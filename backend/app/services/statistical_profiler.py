"""Config-driven, read-only statistical profiling for Databricks Bronze tables.

Reads the existing discovery artifacts and the declared config datatypes. The
physical types are queried from Unity Catalog at execution time because the
existing discovery table artifacts intentionally contain only column names.

Run independently from backend/:
    python -m app.services.statistical_profiler

No Delta writes, temporary tables, Pandas downloads, or LLM calls are used.
"""

from __future__ import annotations

import argparse
from datetime import date, datetime, time
from decimal import Decimal
import json
import math
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any

from app.config import (
    DATABRICKS_SERVER_HOSTNAME,
    DATABRICKS_HTTP_PATH,
    DATABRICKS_TOKEN,
    DATABRICKS_CATALOG,
    DATABRICKS_SCHEMA,
)

BACKEND_ROOT = Path(__file__).resolve().parents[2]
# A deliberately small set of supported simple types. Extend explicitly later.
ALIASES = {
    "INT": "INTEGER", "INTEGER": "INTEGER",
    "LONG": "BIGINT", "BIGINT": "BIGINT",
    "SHORT": "SMALLINT", "SMALLINT": "SMALLINT",
    "BYTE": "TINYINT", "TINYINT": "TINYINT",
    "BOOL": "BOOLEAN", "BOOLEAN": "BOOLEAN",
    "REAL": "FLOAT", "FLOAT": "FLOAT",
    "DOUBLE PRECISION": "DOUBLE", "DOUBLE": "DOUBLE",
    "STRING": "STRING", "TEXT": "STRING",
    "DATE": "DATE", "TIMESTAMP": "TIMESTAMP", "TIMESTAMP_NTZ": "TIMESTAMP_NTZ",
}
NUMERIC = {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "FLOAT", "DOUBLE"}
DATETIME = {"DATE", "TIMESTAMP", "TIMESTAMP_NTZ"}


def quote_ident(identifier: str) -> str:
    """Spark SQL escaped identifier; table and column names are untrusted strings."""
    if not isinstance(identifier, str) or not identifier or "\x00" in identifier:
        raise ValueError(f"Invalid SQL identifier: {identifier!r}")
    return "`" + identifier.replace("`", "``") + "`"


def normalize_type(raw: str) -> str:
    """Normalize equivalent SQL/Spark aliases without widening numerics.

    For profiling, CHAR/VARCHAR belong to the STRING family; their lengths
    remain in the original config and are not validated by this stage.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"Datatype must be a nonempty string: {raw!r}")
    t = re.sub(r"\s+", " ", raw.strip().upper())
    if t in ALIASES:
        return ALIASES[t]
    if re.fullmatch(r"(?:VAR)?CHAR\s*\(\s*[0-9]+\s*\)", t):
        return "STRING"
    decimal = re.fullmatch(r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", t)
    if decimal:
        precision, scale = map(int, decimal.groups())
        if not 1 <= precision <= 38 or not 0 <= scale <= precision:
            raise ValueError(f"Invalid DECIMAL precision/scale: {raw!r}")
        return f"DECIMAL({precision},{scale})"
    decimal_one = re.fullmatch(r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*\)", t)
    if decimal_one:
        precision = int(decimal_one.group(1))
        if not 1 <= precision <= 38:
            raise ValueError(f"Invalid DECIMAL precision: {raw!r}")
        return f"DECIMAL({precision},0)"
    # Unparameterized decimals cannot be assumed equivalent to DECIMAL(p,s).
    if t in {"DECIMAL", "NUMERIC"}:
        return "DECIMAL"
    # An unknown type is retained for comparison but NEVER interpolated in a cast.
    return t


def type_family(normalized_type: str) -> str | None:
    if normalized_type in NUMERIC or normalized_type.startswith("DECIMAL("):
        return "numeric"
    if normalized_type == "STRING":
        return "string"
    if normalized_type == "DATE":
        return "date"
    if normalized_type in {"TIMESTAMP", "TIMESTAMP_NTZ"}:
        return "timestamp"
    if normalized_type == "BOOLEAN":
        return "boolean"
    return None


def get_conversion_expression(column_name: str, expected_type: str, physical_type: str) -> tuple[str | None, str]:
    """Decide on DIRECT, CONVERTED, or UNSUPPORTED_TYPE_MISMATCH.

    Note that no arbitrary conversion from e.g. TIMESTAMP to INTEGER occurs.
    """
    expected = normalize_type(expected_type)
    physical = normalize_type(physical_type)
    col = quote_ident(column_name)
    if expected == physical and type_family(expected) is not None:
        return col, "DIRECT"
    if physical == "STRING" and expected != "STRING" and type_family(expected) is not None:
        # expected is guaranteed to be allowlisted and syntactically safe.
        return f"TRY_CAST({col} AS {expected})", "CONVERTED"
    return None, "UNSUPPORTED_TYPE_MISMATCH"


def _get_rows(cursor: Any, query: str) -> list[dict[str, Any]]:
    cursor.execute(query)
    names = [col[0].lower() for col in cursor.description]
    return [dict(zip(names, record)) for record in cursor.fetchall()]


def load_discovery(discovery_dir: Path) -> tuple[list[str], dict[str, dict], dict[str, dict]]:
    """Use the names matched by discovery. Reject stale/broken local inputs."""
    matching_file = discovery_dir / "matching_results.json"
    if not matching_file.is_file():
        raise FileNotFoundError(f"Discovery artifacts missing: {matching_file}. Run discovery first.")
    matching = json.loads(matching_file.read_text(encoding="utf-8"))
    matched = matching.get("columns_matched_tables")
    if not isinstance(matched, list):
        raise ValueError("Discovery results have no columns_matched_tables list; rerun latest discovery")
    tables: dict[str, dict] = {}
    configs: dict[str, dict] = {}
    config_dir = discovery_dir / "configs"
    for file in config_dir.glob("*.json"):
        content = json.loads(file.read_text(encoding="utf-8-sig"))
        if not isinstance(content, dict) or not isinstance(content.get("columns"), list) or not isinstance(content.get("table_name"), str):
            continue  # e.g. relationships.json
        key = content["table_name"].casefold()
        if key in configs:
            raise ValueError(f"Duplicate config for table {content['table_name']}")
        configs[key] = content
    for name in matched:
        filename = discovery_dir / "tables" / f"{name}.json"
        if not filename.is_file():
            raise FileNotFoundError(f"Table discovery artifact is missing: {filename}")
        table = json.loads(filename.read_text(encoding="utf-8"))
        if table.get("table_name") != name:
            raise ValueError(f"Table discovery metadata mismatch in {filename}")
        if name.casefold() not in configs:
            raise ValueError(f"Missing config for matched table {name}")
        tables[name.casefold()] = table
    return matched, tables, configs


def get_physical_types(connection: Any, catalog: str, schema: str) -> dict[str, dict[str, str]]:
    """Read types from information_schema, not the discovery name-only JSONs."""
    # String predicates quoted using SQL literals; identifiers separately escaped.
    def lit(s: str) -> str:
        return "'" + s.replace("'", "''") + "'"

    query = f"""
        SELECT table_name, column_name, full_data_type, data_type
        FROM {quote_ident(catalog)}.information_schema.columns
        WHERE table_catalog = {lit(catalog)} AND table_schema = {lit(schema)}
    """
    with connection.cursor() as cursor:
        rows = _get_rows(cursor, query)
    observed: dict[str, dict[str, str]] = {}
    for row in rows:
        tab = row["table_name"].casefold()
        col = row["column_name"].casefold()
        observed.setdefault(tab, {})[col] = row["full_data_type"] or row["data_type"]
    return observed


def _column_plan(config_column: dict, actual_name: str, physical_type: str) -> dict:
    expected_raw = config_column.get("datatype")
    expected = normalize_type(expected_raw)
    physical = normalize_type(physical_type)
    expr, status = get_conversion_expression(actual_name, expected, physical)
    return {
        "name": actual_name,
        "expected_raw": expected_raw,
        "physical_raw": physical_type,
        "expected": expected,
        "physical": physical,
        "status": status,
        "expression": expr,
        "family": type_family(expected),
    }


def build_aggregate_query(catalog: str, schema: str, table: str, plans: list[dict]) -> str:
    """Single read-only aggregate query for all configured columns in a table."""
    projections: list[str] = []
    aggregates: list[str] = ["COUNT(*) AS `row_count`"]

    def agg(expr: str, alias: str) -> None:
        aggregates.append(f"{expr} AS {quote_ident(alias)}")

    for i, plan in enumerate(plans):
        raw, converted = f"c{i}_raw", f"c{i}_value"
        r, v = quote_ident(raw), quote_ident(converted)
        projections.append(f"{quote_ident(plan['name'])} AS {r}")
        agg(f"COUNT_IF({r} IS NULL)", f"c{i}_null_count")
        if plan["status"] == "UNSUPPORTED_TYPE_MISMATCH":
            continue
        projections.append(f"{plan['expression']} AS {v}")
        agg(f"COUNT({v})", f"c{i}_valid_count")
        if plan["status"] == "CONVERTED":
            agg(f"COUNT_IF({r} IS NOT NULL AND {v} IS NULL)", f"c{i}_invalid_count")
        else:
            agg("CAST(0 AS BIGINT)", f"c{i}_invalid_count")

        family = plan["family"]
        if family == "numeric":
            operations = {
                "min": f"MIN({v})", "max": f"MAX({v})", "mean": f"AVG({v})",
                "stddev": f"STDDEV_SAMP({v})", "p25": f"PERCENTILE_APPROX({v}, 0.25)",
                "p50": f"PERCENTILE_APPROX({v}, 0.50)",
                "p75": f"PERCENTILE_APPROX({v}, 0.75)",
                "zero_count": f"COUNT_IF({v} = 0)",
                "negative_count": f"COUNT_IF({v} < 0)",
                "distinct_count": f"COUNT(DISTINCT {v})",
            }
        elif family == "string":
            operations = {
                "min_length": f"MIN(LENGTH({v}))",
                "max_length": f"MAX(LENGTH({v}))",
                "avg_length": f"AVG(LENGTH({v}))",
                "empty_count": f"COUNT_IF(LENGTH({v}) = 0)",
                "whitespace_only_count": f"COUNT_IF(LENGTH({v}) > 0 AND LENGTH(TRIM({v})) = 0)",
                "distinct_count": f"COUNT(DISTINCT {v})",
            }
        elif family == "date":
            operations = {
                "min_date": f"MIN({v})", "max_date": f"MAX({v})",
                "distinct_count": f"COUNT(DISTINCT {v})",
                "date_range_days": f"DATEDIFF(MAX({v}), MIN({v}))",
            }
        elif family == "timestamp":
            operations = {
                "min_timestamp": f"MIN({v})", "max_timestamp": f"MAX({v})",
                "distinct_count": f"COUNT(DISTINCT {v})",
                "time_range_seconds": f"TIMESTAMPDIFF(SECOND, MIN({v}), MAX({v}))",
            }
        elif family == "boolean":
            operations = {
                "true_count": f"COUNT_IF({v} = TRUE)",
                "false_count": f"COUNT_IF({v} = FALSE)",
            }
        else:
            raise AssertionError(f"Unimplemented family: {family}")
        for stat, expression in operations.items():
            agg(expression, f"c{i}_{stat}")

    if not projections:
        raise ValueError(f"No columns to profile for table {table}")
    source = ".".join(map(quote_ident, (catalog, schema, table)))
    return (
        "WITH converted AS (\n    SELECT\n        "
        + ",\n        ".join(projections)
        + f"\n    FROM {source}\n)\nSELECT\n    "
        + ",\n    ".join(aggregates)
        + "\nFROM converted"
    )


def build_top_values_query(catalog: str, schema: str, table: str, column: str, limit: int) -> str:
    if not 1 <= limit <= 100:
        raise ValueError("top_values limit must be between 1 and 100")
    identifier = quote_ident(column)
    source = ".".join(map(quote_ident, (catalog, schema, table)))
    return (
        f"SELECT {identifier} AS value, COUNT(*) AS frequency\n"
        f"FROM {source}\nWHERE {identifier} IS NOT NULL\n"
        f"GROUP BY {identifier}\nORDER BY frequency DESC, value ASC\nLIMIT {limit}"
    )


def _json_value(value: Any) -> Any:
    """Databricks driver values -> JSON. Preserve arbitrary precision decimals."""
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    raise TypeError(f"Unsupported result value for JSON: {type(value).__name__}")


def _require_count(value: Any, field: str) -> int:
    if value is None or int(value) < 0:
        raise ValueError(f"Unexpected query result for {field}: {value!r}")
    return int(value)


def profile_table(
    connection: Any, catalog: str, schema: str, table: str,
    discovered: dict, config: dict, physical_types: dict[str, str],
    *, top_values_limit: int = 10, top_values_max_distinct: int = 100,
) -> dict:
    """Profile a table without fetching or writing its raw records."""
    if discovered.get("catalog") != catalog or discovered.get("schema") != schema:
        raise ValueError(f"Discovery location changed for {table}; rerun discovery")
    actual_columns = {c["name"].casefold(): c["name"] for c in discovered["columns"]}
    configured_columns = {c["name"].casefold(): c for c in config["columns"]}
    if set(actual_columns) != set(configured_columns) or set(actual_columns) != set(physical_types):
        raise ValueError(f"Column mismatch or stale discovery for {table}; rerun dataset discovery")

    plans = [
        _column_plan(c, actual_columns[c["name"].casefold()], physical_types[c["name"].casefold()])
        for c in config["columns"]
    ]
    query = build_aggregate_query(catalog, schema, table, plans)
    with connection.cursor() as cursor:
        cursor.execute(query)
        description = [c[0].lower() for c in cursor.description]
        result = cursor.fetchone()
        if result is None:
            raise RuntimeError(f"No aggregate result for {table}")
        agg = dict(zip(description, result))

    row_count = _require_count(agg["row_count"], "row_count")
    profiles: dict[str, dict] = {}
    for i, plan in enumerate(plans):
        prefix = f"c{i}_"
        null_count = _require_count(agg[prefix + "null_count"], prefix + "null_count")
        status = plan["status"]
        if status == "UNSUPPORTED_TYPE_MISMATCH":
            valid_count = invalid_count = success_rate = statistics = None
        else:
            valid_count = _require_count(agg[prefix + "valid_count"], prefix + "valid_count")
            invalid_count = _require_count(agg[prefix + "invalid_count"], prefix + "invalid_count")
            if null_count + valid_count + invalid_count != row_count:
                raise ValueError(f"Counts do not reconcile for {table}.{plan['name']}")
            non_null_count = row_count - null_count
            success_rate = (
                round(100 * valid_count / non_null_count, 2)
                if status == "CONVERTED" and non_null_count else None
            )
            statistics = {
                key[len(prefix):]: _json_value(value)
                for key, value in agg.items()
                if key.startswith(prefix) and key not in {
                    prefix + "null_count", prefix + "valid_count", prefix + "invalid_count"
                }
            }

        profile = {
            "column_name": plan["name"],
            "expected_type": plan["expected"],
            "physical_type": plan["physical"],
            "expected_type_raw": plan["expected_raw"],
            "physical_type_raw": plan["physical_raw"],
            "profiling_status": status,
            "null_count": null_count,
            "valid_count": valid_count,
            "invalid_count": invalid_count,
            "conversion_success_rate": success_rate,
            "statistics": statistics,
        }
        profiles[plan["name"]] = profile

    # Optional, bounded value-frequency queries only for low/medium cardinality
    # STRING columns, avoiding raw identifiers and PII-like high-cardinality data.
    if top_values_limit:
        for plan in plans:
            if plan["family"] != "string" or plan["status"] != "DIRECT":
                continue
            profile = profiles[plan["name"]]
            distinct_count = profile["statistics"]["distinct_count"]
            if not distinct_count or distinct_count > top_values_max_distinct:
                profile["statistics"]["top_values"] = []
                continue
            query = build_top_values_query(catalog, schema, table, plan["name"], top_values_limit)
            with connection.cursor() as cursor:
                result_rows = _get_rows(cursor, query)
            profile["statistics"]["top_values"] = [
                {"value": _json_value(r["value"]), "count": int(r["frequency"])}
                for r in result_rows
            ]

    return {"table_name": table, "row_count": row_count,
            "column_count": len(plans), "columns": profiles}


def _write_profiles(destination: Path, profiles: dict[str, dict]) -> None:
    """Replace one stable folder after *all* profiling SQL queries succeed."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = destination.parent / ".statistical_profiles_previous"
    if backup.exists():
        if not destination.exists():
            backup.rename(destination)
        else:
            shutil.rmtree(backup)
    with tempfile.TemporaryDirectory(prefix=".statistical_profiles_staging_", dir=destination.parent) as tmp:
        staging = Path(tmp) / "statistical_profiles"
        staging.mkdir()
        for name, result in profiles.items():
            (staging / f"{name}.json").write_text(
                json.dumps(result, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8"
            )
        if destination.exists():
            destination.rename(backup)
        try:
            staging.rename(destination)
        except OSError:
            if backup.exists() and not destination.exists():
                backup.rename(destination)
            raise
        if backup.exists():
            shutil.rmtree(backup)


def profile_dataset(
    catalog: str | None = None, schema: str | None = None,
    artifacts_root: str | Path | None = None,
    *, sql_connection: Any = None, top_values_limit: int = 10,
    top_values_max_distinct: int = 100,
) -> dict:
    """Run the statistical stage from the existing discovery JSON snapshot."""
    catalog = catalog if catalog is not None else DATABRICKS_CATALOG
    schema = schema if schema is not None else DATABRICKS_SCHEMA
    if not catalog or not schema:
        raise ValueError("DATABRICKS_CATALOG and DATABRICKS_SCHEMA must be set in app.config")
    if not 0 <= top_values_limit <= 100:
        raise ValueError("top_values_limit must be in 0..100")
    if top_values_max_distinct < 0:
        raise ValueError("top_values_max_distinct must be nonnegative")
    root = Path(artifacts_root) if artifacts_root is not None else BACKEND_ROOT / "artifacts"
    dataset_dir = root / f"{catalog}.{schema}"
    discovery_dir = dataset_dir / "discovery"
    matched, tables, configs = load_discovery(discovery_dir)
    if not matched:
        raise ValueError("No tables with matched columns in discovery; nothing to profile")

    owns_connection = sql_connection is None
    if owns_connection:
        from databricks import sql
        if not all((DATABRICKS_SERVER_HOSTNAME, DATABRICKS_HTTP_PATH, DATABRICKS_TOKEN)):
            raise ValueError("Databricks connection settings are missing in app.config")
        hostname = DATABRICKS_SERVER_HOSTNAME.removeprefix("https://").rstrip("/")
        sql_connection = sql.connect(
            server_hostname=hostname,
            http_path=DATABRICKS_HTTP_PATH,
            access_token=DATABRICKS_TOKEN,
        )
    try:
        all_types = get_physical_types(sql_connection, catalog, schema)
        profiles = {}
        for name in matched:
            key = name.casefold()
            if key not in all_types:
                raise ValueError(f"Databricks table {name} not found; rerun discovery")
            profiles[name] = profile_table(
                sql_connection, catalog, schema, name, tables[key], configs[key], all_types[key],
                top_values_limit=top_values_limit,
                top_values_max_distinct=top_values_max_distinct,
            )
    finally:
        if owns_connection:
            sql_connection.close()

    destination = dataset_dir / "statistical_profiles"
    _write_profiles(destination, profiles)
    return {
        "statistical_profiles_path": str(destination.resolve()),
        "table_count": len(profiles),
        "column_count": sum(p["column_count"] for p in profiles.values()),
        "status_counts": {
            status: sum(
                column["profiling_status"] == status
                for prof in profiles.values() for column in prof["columns"].values()
            )
            for status in ("DIRECT", "CONVERTED", "UNSUPPORTED_TYPE_MISMATCH")
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Profile Bronze data against config expectations")
    parser.add_argument("--catalog", default=DATABRICKS_CATALOG)
    parser.add_argument("--schema", default=DATABRICKS_SCHEMA)
    parser.add_argument("--artifacts-root", default=str(BACKEND_ROOT / "artifacts"))
    parser.add_argument("--top-values-limit", type=int, default=10)
    parser.add_argument("--top-values-max-distinct", type=int, default=100)
    args = parser.parse_args()
    result = profile_dataset(
        catalog=args.catalog, schema=args.schema, artifacts_root=args.artifacts_root,
        top_values_limit=args.top_values_limit,
        top_values_max_distinct=args.top_values_max_distinct,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
