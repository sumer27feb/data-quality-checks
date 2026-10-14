"""Config-driven, read-only statistical profiling for Databricks tables.

Reads discovery artifacts and declared configuration datatypes.
Physical datatypes are queried from Unity Catalog at execution time.

artifacts_root is the dataset directory itself, for example:
    artifacts/workspace.data_quality_rules

Input:
    <artifacts_root>/discovery/

Output:
    <artifacts_root>/statistical_profiles/

Run from backend/:
    python -m app.services.statistical_profiler

No Delta writes, temporary tables, Pandas downloads, or LLM calls are used.
Profiling executes aggregate queries against the source tables.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import tempfile
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.config import (
    ARTIFACTS_ROOT,
    DATABRICKS_CATALOG,
    DATABRICKS_SCHEMA,
    DATABRICKS_SERVER_HOSTNAME,
    DATABRICKS_HTTP_PATH,
    DATABRICKS_TOKEN,
)


# Supported simple types. Extend explicitly when needed.
ALIASES = {
    "INT": "INTEGER",
    "INTEGER": "INTEGER",
    "LONG": "BIGINT",
    "BIGINT": "BIGINT",
    "SHORT": "SMALLINT",
    "SMALLINT": "SMALLINT",
    "BYTE": "TINYINT",
    "TINYINT": "TINYINT",
    "BOOL": "BOOLEAN",
    "BOOLEAN": "BOOLEAN",
    "REAL": "FLOAT",
    "FLOAT": "FLOAT",
    "DOUBLE PRECISION": "DOUBLE",
    "DOUBLE": "DOUBLE",
    "STRING": "STRING",
    "TEXT": "STRING",
    "DATE": "DATE",
    "TIMESTAMP": "TIMESTAMP",
    "TIMESTAMP_NTZ": "TIMESTAMP_NTZ",
}

NUMERIC = {
    "TINYINT",
    "SMALLINT",
    "INTEGER",
    "BIGINT",
    "FLOAT",
    "DOUBLE",
}


def quote_ident(identifier: str) -> str:
    """Escape a Spark SQL identifier."""
    if (
        not isinstance(identifier, str)
        or not identifier
        or "\x00" in identifier
    ):
        raise ValueError(f"Invalid SQL identifier: {identifier!r}")

    return "`" + identifier.replace("`", "``") + "`"


def normalize_type(raw: str) -> str:
    """Normalize equivalent SQL/Spark aliases without widening numerics.

    CHAR/VARCHAR are treated as STRING for profiling.
    Their declared length constraints are not checked at this stage.
    """
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(
            f"Datatype must be a nonempty string: {raw!r}"
        )

    normalized = re.sub(r"\s+", " ", raw.strip().upper())

    if normalized in ALIASES:
        return ALIASES[normalized]

    if re.fullmatch(
        r"(?:VAR)?CHAR\s*\(\s*[0-9]+\s*\)",
        normalized,
    ):
        return "STRING"

    decimal_match = re.fullmatch(
        r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)",
        normalized,
    )

    if decimal_match:
        precision, scale = map(int, decimal_match.groups())

        if not 1 <= precision <= 38 or not 0 <= scale <= precision:
            raise ValueError(
                f"Invalid DECIMAL precision/scale: {raw!r}"
            )

        return f"DECIMAL({precision},{scale})"

    decimal_one = re.fullmatch(
        r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*\)",
        normalized,
    )

    if decimal_one:
        precision = int(decimal_one.group(1))

        if not 1 <= precision <= 38:
            raise ValueError(
                f"Invalid DECIMAL precision: {raw!r}"
            )

        return f"DECIMAL({precision},0)"

    # Do not assume an unspecified decimal equals DECIMAL(p, s).
    if normalized in {"DECIMAL", "NUMERIC"}:
        return "DECIMAL"

    # Unknown types can be compared, but are never used in casts.
    return normalized


def type_family(normalized_type: str) -> str | None:
    if (
        normalized_type in NUMERIC
        or normalized_type.startswith("DECIMAL(")
    ):
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


def get_conversion_expression(
    column_name: str,
    expected_type: str,
    physical_type: str,
) -> tuple[str | None, str]:
    """Choose DIRECT, CONVERTED, or UNSUPPORTED_TYPE_MISMATCH."""
    expected = normalize_type(expected_type)
    physical = normalize_type(physical_type)
    column = quote_ident(column_name)

    if expected == physical and type_family(expected) is not None:
        return column, "DIRECT"

    if (
        physical == "STRING"
        and expected != "STRING"
        and type_family(expected) is not None
    ):
        return (
            f"TRY_CAST({column} AS {expected})",
            "CONVERTED",
        )

    return None, "UNSUPPORTED_TYPE_MISMATCH"


def _get_rows(
    cursor: Any,
    query: str,
) -> list[dict[str, Any]]:
    cursor.execute(query)
    names = [column[0].lower() for column in cursor.description]

    return [
        dict(zip(names, record))
        for record in cursor.fetchall()
    ]


def load_discovery(
    discovery_dir: Path,
) -> tuple[list[str], dict[str, dict], dict[str, dict]]:
    """Load tables whose column names matched during discovery."""
    matching_file = discovery_dir / "matching_results.json"

    if not matching_file.is_file():
        raise FileNotFoundError(
            f"Discovery artifacts missing: {matching_file}. "
            "Run discovery first."
        )

    matching = json.loads(
        matching_file.read_text(encoding="utf-8")
    )
    matched = matching.get("columns_matched_tables")

    if not isinstance(matched, list):
        raise ValueError(
            "Discovery results have no columns_matched_tables "
            "list; rerun latest discovery."
        )

    tables: dict[str, dict] = {}
    configs: dict[str, dict] = {}
    config_dir = discovery_dir / "configs"

    for file in config_dir.glob("*.json"):
        content = json.loads(
            file.read_text(encoding="utf-8-sig")
        )

        if (
            not isinstance(content, dict)
            or not isinstance(content.get("columns"), list)
            or not isinstance(content.get("table_name"), str)
        ):
            continue

        key = content["table_name"].casefold()

        if key in configs:
            raise ValueError(
                f"Duplicate config for table {content['table_name']}"
            )

        configs[key] = content

    for name in matched:
        filename = discovery_dir / "tables" / f"{name}.json"

        if not filename.is_file():
            raise FileNotFoundError(
                f"Table discovery artifact is missing: {filename}"
            )

        table = json.loads(
            filename.read_text(encoding="utf-8")
        )

        if table.get("table_name") != name:
            raise ValueError(
                f"Table discovery metadata mismatch in {filename}"
            )

        if name.casefold() not in configs:
            raise ValueError(
                f"Missing config for matched table {name}"
            )

        tables[name.casefold()] = table

    return matched, tables, configs


def get_physical_types(
    connection: Any,
    catalog: str,
    schema: str,
) -> dict[str, dict[str, str]]:
    """Read physical datatypes from information_schema."""

    def literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    query = f"""
        SELECT
            table_name,
            column_name,
            full_data_type,
            data_type
        FROM {quote_ident(catalog)}.information_schema.columns
        WHERE table_catalog = {literal(catalog)}
          AND table_schema = {literal(schema)}
    """

    with connection.cursor() as cursor:
        rows = _get_rows(cursor, query)

    observed: dict[str, dict[str, str]] = {}

    for row in rows:
        table_key = row["table_name"].casefold()
        column_key = row["column_name"].casefold()

        observed.setdefault(table_key, {})[column_key] = (
            row["full_data_type"] or row["data_type"]
        )

    return observed


def _column_plan(
    config_column: dict,
    actual_name: str,
    physical_type: str,
) -> dict:
    expected_raw = config_column.get("datatype")
    expected = normalize_type(expected_raw)
    physical = normalize_type(physical_type)

    expression, status = get_conversion_expression(
        actual_name,
        expected,
        physical,
    )

    return {
        "name": actual_name,
        "expected_raw": expected_raw,
        "physical_raw": physical_type,
        "expected": expected,
        "physical": physical,
        "status": status,
        "expression": expression,
        "family": type_family(expected),
    }


def build_aggregate_query(
    catalog: str,
    schema: str,
    table: str,
    plans: list[dict],
) -> str:
    """Build one aggregate query for all configured table columns."""
    projections: list[str] = []
    aggregates: list[str] = ["COUNT(*) AS `row_count`"]

    def add_aggregate(expression: str, alias: str) -> None:
        aggregates.append(
            f"{expression} AS {quote_ident(alias)}"
        )

    for index, plan in enumerate(plans):
        raw = quote_ident(f"c{index}_raw")
        value = quote_ident(f"c{index}_value")

        projections.append(
            f"{quote_ident(plan['name'])} AS {raw}"
        )

        add_aggregate(
            f"COUNT_IF({raw} IS NULL)",
            f"c{index}_null_count",
        )

        if plan["status"] == "UNSUPPORTED_TYPE_MISMATCH":
            continue

        projections.append(
            f"{plan['expression']} AS {value}"
        )

        add_aggregate(
            f"COUNT({value})",
            f"c{index}_valid_count",
        )

        if plan["status"] == "CONVERTED":
            add_aggregate(
                f"COUNT_IF({raw} IS NOT NULL AND {value} IS NULL)",
                f"c{index}_invalid_count",
            )
        else:
            add_aggregate(
                "CAST(0 AS BIGINT)",
                f"c{index}_invalid_count",
            )

        family = plan["family"]

        if family == "numeric":
            operations = {
                "min": f"MIN({value})",
                "max": f"MAX({value})",
                "mean": f"AVG({value})",
                "stddev": f"STDDEV_SAMP({value})",
                "p25": f"PERCENTILE_APPROX({value}, 0.25)",
                "p50": f"PERCENTILE_APPROX({value}, 0.50)",
                "p75": f"PERCENTILE_APPROX({value}, 0.75)",
                "zero_count": f"COUNT_IF({value} = 0)",
                "negative_count": f"COUNT_IF({value} < 0)",
                "distinct_count": f"COUNT(DISTINCT {value})",
            }

        elif family == "string":
            operations = {
                "min_length": f"MIN(LENGTH({value}))",
                "max_length": f"MAX(LENGTH({value}))",
                "avg_length": f"AVG(LENGTH({value}))",
                "empty_count": (
                    f"COUNT_IF(LENGTH({value}) = 0)"
                ),
                "whitespace_only_count": (
                    f"COUNT_IF("
                    f"LENGTH({value}) > 0 "
                    f"AND LENGTH(TRIM({value})) = 0"
                    f")"
                ),
                "distinct_count": f"COUNT(DISTINCT {value})",
            }

        elif family == "date":
            operations = {
                "min_date": f"MIN({value})",
                "max_date": f"MAX({value})",
                "distinct_count": f"COUNT(DISTINCT {value})",
                "date_range_days": (
                    f"DATEDIFF(MAX({value}), MIN({value}))"
                ),
            }

        elif family == "timestamp":
            operations = {
                "min_timestamp": f"MIN({value})",
                "max_timestamp": f"MAX({value})",
                "distinct_count": f"COUNT(DISTINCT {value})",
                "time_range_seconds": (
                    f"TIMESTAMPDIFF("
                    f"SECOND, MIN({value}), MAX({value})"
                    f")"
                ),
            }

        elif family == "boolean":
            operations = {
                "true_count": f"COUNT_IF({value} = TRUE)",
                "false_count": f"COUNT_IF({value} = FALSE)",
            }

        else:
            raise AssertionError(
                f"Unimplemented family: {family}"
            )

        for statistic, expression in operations.items():
            add_aggregate(
                expression,
                f"c{index}_{statistic}",
            )

    if not projections:
        raise ValueError(
            f"No columns to profile for table {table}"
        )

    source = ".".join(
        map(quote_ident, (catalog, schema, table))
    )

    return (
        "WITH converted AS (\n"
        "    SELECT\n        "
        + ",\n        ".join(projections)
        + f"\n    FROM {source}\n"
        ")\n"
        "SELECT\n    "
        + ",\n    ".join(aggregates)
        + "\nFROM converted"
    )


def build_top_values_query(
    catalog: str,
    schema: str,
    table: str,
    column: str,
    limit: int,
) -> str:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError(
            "top_values limit must be an integer between 1 and 100"
        )

    identifier = quote_ident(column)
    source = ".".join(
        map(quote_ident, (catalog, schema, table))
    )

    return (
        f"SELECT {identifier} AS value, COUNT(*) AS frequency\n"
        f"FROM {source}\n"
        f"WHERE {identifier} IS NOT NULL\n"
        f"GROUP BY {identifier}\n"
        f"ORDER BY frequency DESC, value ASC\n"
        f"LIMIT {limit}"
    )


def _json_value(value: Any) -> Any:
    """Convert driver values to JSON-compatible values."""
    if value is None or isinstance(value, (bool, str, int)):
        return value

    if isinstance(value, float):
        return value if math.isfinite(value) else None

    if isinstance(value, Decimal):
        return str(value)

    if isinstance(value, (datetime, date, time)):
        return value.isoformat()

    raise TypeError(
        "Unsupported result value for JSON: "
        f"{type(value).__name__}"
    )


def _require_count(value: Any, field: str) -> int:
    if value is None or int(value) < 0:
        raise ValueError(
            f"Unexpected query result for {field}: {value!r}"
        )

    return int(value)


def profile_table(
    connection: Any,
    catalog: str,
    schema: str,
    table: str,
    discovered: dict,
    config: dict,
    physical_types: dict[str, str],
    *,
    top_values_limit: int = 10,
    top_values_max_distinct: int = 100,
) -> dict:
    """Profile a table using aggregates and optional value frequencies."""
    if (
        discovered.get("catalog") != catalog
        or discovered.get("schema") != schema
    ):
        raise ValueError(
            f"Discovery location changed for {table}; rerun discovery"
        )

    actual_columns = {
        column["name"].casefold(): column["name"]
        for column in discovered["columns"]
    }

    configured_columns = {
        column["name"].casefold(): column
        for column in config["columns"]
    }

    if (
        set(actual_columns) != set(configured_columns)
        or set(actual_columns) != set(physical_types)
    ):
        raise ValueError(
            f"Column mismatch or stale discovery for {table}; "
            "rerun dataset discovery"
        )

    plans = [
        _column_plan(
            column,
            actual_columns[column["name"].casefold()],
            physical_types[column["name"].casefold()],
        )
        for column in config["columns"]
    ]

    query = build_aggregate_query(
        catalog,
        schema,
        table,
        plans,
    )

    with connection.cursor() as cursor:
        cursor.execute(query)
        description = [
            column[0].lower()
            for column in cursor.description
        ]
        result = cursor.fetchone()

        if result is None:
            raise RuntimeError(
                f"No aggregate result for {table}"
            )

        aggregate = dict(zip(description, result))

    row_count = _require_count(
        aggregate["row_count"],
        "row_count",
    )

    profiles: dict[str, dict] = {}

    for index, plan in enumerate(plans):
        prefix = f"c{index}_"

        null_count = _require_count(
            aggregate[prefix + "null_count"],
            prefix + "null_count",
        )

        status = plan["status"]

        if status == "UNSUPPORTED_TYPE_MISMATCH":
            valid_count = None
            invalid_count = None
            success_rate = None
            statistics = None

        else:
            valid_count = _require_count(
                aggregate[prefix + "valid_count"],
                prefix + "valid_count",
            )

            invalid_count = _require_count(
                aggregate[prefix + "invalid_count"],
                prefix + "invalid_count",
            )

            if null_count + valid_count + invalid_count != row_count:
                raise ValueError(
                    f"Counts do not reconcile for "
                    f"{table}.{plan['name']}"
                )

            non_null_count = row_count - null_count

            success_rate = (
                round(100 * valid_count / non_null_count, 2)
                if status == "CONVERTED" and non_null_count
                else None
            )

            count_fields = {
                prefix + "null_count",
                prefix + "valid_count",
                prefix + "invalid_count",
            }

            statistics = {
                key[len(prefix):]: _json_value(value)
                for key, value in aggregate.items()
                if key.startswith(prefix) and key not in count_fields
            }

        profiles[plan["name"]] = {
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

    # Limit returned value frequencies to eligible STRING columns.
    # This bounds output size, not the source rows scanned.
    if top_values_limit:
        for plan in plans:
            if (
                plan["family"] != "string"
                or plan["status"] != "DIRECT"
            ):
                continue

            profile = profiles[plan["name"]]
            distinct_count = profile["statistics"]["distinct_count"]

            if (
                not distinct_count
                or distinct_count > top_values_max_distinct
            ):
                profile["statistics"]["top_values"] = []
                continue

            query = build_top_values_query(
                catalog,
                schema,
                table,
                plan["name"],
                top_values_limit,
            )

            with connection.cursor() as cursor:
                result_rows = _get_rows(cursor, query)

            profile["statistics"]["top_values"] = [
                {
                    "value": _json_value(row["value"]),
                    "count": int(row["frequency"]),
                }
                for row in result_rows
            ]

    return {
        "table_name": table,
        "row_count": row_count,
        "column_count": len(plans),
        "columns": profiles,
    }


def _write_profiles(
    destination: Path,
    profiles: dict[str, dict],
) -> None:
    """Publish a replacement folder after all profiling queries succeed.

    Caller must avoid concurrent writes for the same dataset.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = destination.parent / ".statistical_profiles_previous"

    if backup.exists():
        if not destination.exists():
            backup.rename(destination)
        else:
            shutil.rmtree(backup)

    with tempfile.TemporaryDirectory(
        prefix=".statistical_profiles_staging_",
        dir=destination.parent,
    ) as temporary_dir:
        staging = Path(temporary_dir) / "statistical_profiles"
        staging.mkdir()

        for name, result in profiles.items():
            (staging / f"{name}.json").write_text(
                json.dumps(
                    result,
                    indent=2,
                    ensure_ascii=False,
                    allow_nan=False,
                ) + "\n",
                encoding="utf-8",
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
    catalog: str | None = None,
    schema: str | None = None,
    artifacts_root: str | Path | None = None,
    *,
    sql_connection: Any = None,
    top_values_limit: int = 10,
    top_values_max_distinct: int = 100,
) -> dict[str, Any]:
    """Run statistical profiling using the discovery snapshot.

    artifacts_root is the dataset directory itself.
    Explicit arguments override app.config defaults.

    An injected SQL connection remains owned by the caller.
    """
    catalog = (
        catalog if catalog is not None else DATABRICKS_CATALOG
    )
    schema = (
        schema if schema is not None else DATABRICKS_SCHEMA
    )

    if not all(
        isinstance(value, str) and value.strip()
        for value in (catalog, schema)
    ):
        raise ValueError(
            "Provide catalog and schema, or configure "
            "DATABRICKS_CATALOG and DATABRICKS_SCHEMA."
        )

    if (
        type(top_values_limit) is not int
        or not 0 <= top_values_limit <= 100
    ):
        raise ValueError(
            "top_values_limit must be an integer in 0..100"
        )

    if (
        type(top_values_max_distinct) is not int
        or top_values_max_distinct < 0
    ):
        raise ValueError(
            "top_values_max_distinct must be a nonnegative integer"
        )

    # The root already identifies the dataset directory.
    dataset_dir = Path(
        artifacts_root
        if artifacts_root is not None
        else ARTIFACTS_ROOT
    )
    discovery_dir = dataset_dir / "discovery"

    matched, tables, configs = load_discovery(discovery_dir)

    if not matched:
        raise ValueError(
            "No tables with matched columns in discovery; "
            "nothing to profile"
        )

    owns_connection = sql_connection is None
    profiles: dict[str, dict] = {}

    try:
        if owns_connection:
            hostname = (
                (DATABRICKS_SERVER_HOSTNAME or "")
                .removeprefix("https://")
                .rstrip("/")
            )

            if not all(
                (
                    hostname,
                    DATABRICKS_HTTP_PATH,
                    DATABRICKS_TOKEN,
                )
            ):
                raise ValueError(
                    "Configure DATABRICKS_SERVER_HOSTNAME, "
                    "DATABRICKS_HTTP_PATH, and DATABRICKS_TOKEN."
                )

            from databricks import sql

            sql_connection = sql.connect(
                server_hostname=hostname,
                http_path=DATABRICKS_HTTP_PATH,
                access_token=DATABRICKS_TOKEN,
            )

        all_types = get_physical_types(
            sql_connection,
            catalog,
            schema,
        )

        for name in matched:
            key = name.casefold()

            if key not in all_types:
                raise ValueError(
                    f"Databricks table {name} not found; "
                    "rerun discovery"
                )

            profiles[name] = profile_table(
                sql_connection,
                catalog,
                schema,
                name,
                tables[key],
                configs[key],
                all_types[key],
                top_values_limit=top_values_limit,
                top_values_max_distinct=top_values_max_distinct,
            )

    finally:
        if owns_connection and sql_connection is not None:
            sql_connection.close()

    destination = dataset_dir / "statistical_profiles"
    _write_profiles(destination, profiles)

    return {
        "statistical_profiles_path": str(destination.resolve()),
        "table_count": len(profiles),
        "column_count": sum(
            profile["column_count"]
            for profile in profiles.values()
        ),
        "status_counts": {
            status: sum(
                column["profiling_status"] == status
                for profile in profiles.values()
                for column in profile["columns"].values()
            )
            for status in (
                "DIRECT",
                "CONVERTED",
                "UNSUPPORTED_TYPE_MISMATCH",
            )
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Profile table data against config expectations"
    )

    parser.add_argument(
        "--catalog",
        default=DATABRICKS_CATALOG,
    )
    parser.add_argument(
        "--schema",
        default=DATABRICKS_SCHEMA,
    )
    parser.add_argument(
        "--artifacts-root",
        default=ARTIFACTS_ROOT,
        help="Dataset artifacts directory",
    )
    parser.add_argument(
        "--top-values-limit",
        type=int,
        default=10,
        help="Maximum top values per eligible column; 0 disables them",
    )
    parser.add_argument(
        "--top-values-max-distinct",
        type=int,
        default=100,
        help="Maximum distinct count for top-value collection",
    )

    args = parser.parse_args()

    result = profile_dataset(
        catalog=args.catalog,
        schema=args.schema,
        artifacts_root=args.artifacts_root,
        top_values_limit=args.top_values_limit,
        top_values_max_distinct=args.top_values_max_distinct,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()