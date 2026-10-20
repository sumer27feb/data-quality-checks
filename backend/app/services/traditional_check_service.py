"""Deterministic, metadata-validated Spark SQL violation-row generator.

Generates SELECT * statements only. NO SQL execution, Databricks connection,
LLM inference, or LangGraph call occurs in this module.
"""
from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class TraditionalCheckError(ValueError):
    """Invalid selection or missing discovery metadata."""


CheckType = Literal[
    "not_null", "unique", "not_blank", "trimmed", "non_negative",
    "positive", "range", "length", "allowed_values",
]
ImpactLevel = Literal["low", "medium", "high"]


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    table: str = Field(min_length=1, max_length=128)
    column: str = Field(min_length=1, max_length=128)
    check: CheckType
    params: dict[str, Any] = Field(default_factory=dict)
    impact_level: ImpactLevel = "medium"


class SelectionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    selections: list[Selection] = Field(max_length=500)


IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
STRING_RE = re.compile(r"^(?:VAR)?CHAR\b|^STRING\b", re.I)
NUMERIC_RE = re.compile(r"^(?:TINYINT|SMALLINT|INT|INTEGER|BIGINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|LONG|SHORT)\b", re.I)
TEMPORAL_RE = re.compile(r"^(?:DATE|TIMESTAMP)\b", re.I)


def _ident(name: str) -> str:
    if not isinstance(name, str) or not IDENTIFIER.fullmatch(name):
        raise TraditionalCheckError(f"Unsupported SQL identifier: {name!r}")
    return f"`{name}`"


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TraditionalCheckError(f"Invalid discovery artifact {path.name}: {exc}") from exc
    if not isinstance(obj, dict):
        raise TraditionalCheckError(f"Invalid discovery artifact {path.name}: expected object")
    return obj


def _table_metadata(root: Path, table_name: str) -> tuple[str, dict[str, str | None]]:
    _ident(table_name)
    discovery = _read_json(root / "discovery" / "tables" / f"{table_name}.json")
    if discovery is None or discovery.get("table_name") != table_name:
        raise TraditionalCheckError(f"Table {table_name!r} is not present in this run's discovery")

    catalog = discovery.get("catalog")
    schema = discovery.get("schema")
    if not all(isinstance(x, str) and IDENTIFIER.fullmatch(x) for x in (catalog, schema)):
        raise TraditionalCheckError(f"Missing or invalid run-specific catalog/schema for {table_name}")
    qualified = ".".join((_ident(catalog), _ident(schema), _ident(table_name)))

    discovered_columns = discovery.get("columns")
    if not isinstance(discovered_columns, list) or not discovered_columns:
        raise TraditionalCheckError(f"No discovered columns for {table_name}")
    columns: dict[str, str | None] = {}
    for c in discovered_columns:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str):
            continue
        _ident(c["name"])
        columns[c["name"]] = None

    # Config names need not equal filenames; the source JSON declares the table.
    config_dir = root / "discovery" / "configs"
    if config_dir.is_dir():
        for path in sorted(config_dir.glob("*.json")):
            cfg = _read_json(path)
            if not cfg or cfg.get("table_name") != table_name:
                continue
            for col in cfg.get("columns", []):
                if not isinstance(col, dict):
                    continue
                name, datatype = col.get("name"), col.get("datatype")
                if name in columns and isinstance(datatype, str) and datatype.strip():
                    columns[name] = datatype.strip()
            break

    stat = _read_json(root / "statistical_profiles" / f"{table_name}.json")
    if stat and isinstance(stat.get("columns"), dict):
        for name, obj in stat["columns"].items():
            if name not in columns or not isinstance(obj, dict):
                continue
            physical = obj.get("physical_type")
            if isinstance(physical, str) and physical.strip():
                columns[name] = physical.strip()
    return qualified, columns


def _decimal_literal(value: Any, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise TraditionalCheckError(f"{label} must be a finite number")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise TraditionalCheckError(f"{label} must be a finite number") from exc
    if not result.is_finite() or len(result.as_tuple().digits) > 40 or abs(result.adjusted()) > 40 or abs(result.as_tuple().exponent) > 40:
        raise TraditionalCheckError(f"{label} must be a finite, reasonably bounded number")
    return format(result, "f")


def _integer(value: Any, label: str) -> int:
    if type(value) is not int or not (0 <= value <= 100000):
        raise TraditionalCheckError(f"{label} must be an integer between 0 and 100000")
    return value


def _quote_string(value: str) -> str:
    if not isinstance(value, str) or len(value) > 1000 or "\x00" in value:
        raise TraditionalCheckError("Allowed values must be strings of <=1000 characters")
    return "'" + value.replace("'", "''") + "'"


def _check_params(s: Selection, datatype: str | None) -> tuple[dict[str, Any], str, str, str]:
    """Return (canonical params, logical predicate body, failure WHERE, human description)."""
    dtype = (datatype or "").upper().strip()
    col = _ident(s.column)
    logical_col = f"{_ident(s.table)}.{col}"
    check = s.check
    params = s.params
    is_string = bool(STRING_RE.match(dtype))
    is_number = bool(NUMERIC_RE.match(dtype))
    is_temporal = bool(TEMPORAL_RE.match(dtype))
    is_boolean = dtype.startswith("BOOLEAN")

    needs = {
        "not_blank": is_string,
        "trimmed": is_string,
        "non_negative": is_number,
        "positive": is_number,
        "range": is_number,
        "length": is_string,
        "allowed_values": is_string,
    }
    if check in needs and not needs[check]:
        raise TraditionalCheckError(f"{s.table}.{s.column}: check {check!r} is not applicable to {datatype!r}")
    if check in ("not_null", "unique", "not_blank", "trimmed", "non_negative", "positive") and params:
        raise TraditionalCheckError(f"{check} does not accept parameters")

    if check == "unique" and not (is_string or is_number or is_temporal or is_boolean):
        raise TraditionalCheckError(f"{s.table}.{s.column}: unique requires a comparable scalar datatype")
    if check == "not_null":
        return {}, f"{logical_col} IS NOT NULL", f"{col} IS NULL", "must not be NULL"
    if check == "unique":
        # Enforces unique non-null values, counting every row in each duplicate group.
        # The logical predicate is a dataset-level invariant, not a per-row expression.
        predicate = (f"NOT EXISTS (SELECT 1 FROM {_ident(s.table)} WHERE {col} IS NOT NULL "
                     f"GROUP BY {col} HAVING COUNT(*) > 1)")
        return {}, predicate, (f"{col} IS NOT NULL AND {col} IN "
                              f"(SELECT {col} FROM {{table}} WHERE {col} IS NOT NULL "
                              f"GROUP BY {col} HAVING COUNT(*) > 1)"), "must be unique among non-NULL values"
    if check == "not_blank":
        return {}, f"{logical_col} IS NULL OR TRIM({logical_col}) <> ''", f"{col} IS NOT NULL AND TRIM({col}) = ''", "must not be empty or contain only spaces"
    if check == "trimmed":
        return {}, f"{logical_col} IS NULL OR {logical_col} = TRIM({logical_col})", f"{col} IS NOT NULL AND {col} <> TRIM({col})", "must not have leading or trailing spaces"
    if check in ("non_negative", "positive"):
        op = ">=" if check == "non_negative" else ">"
        bad = "<" if check == "non_negative" else "<="
        return {}, f"{logical_col} {op} 0", f"{col} IS NOT NULL AND {col} {bad} 0", "must be non-negative" if check == "non_negative" else "must be greater than zero"
    if check == "range":
        if not params or set(params) - {"min", "max"}:
            raise TraditionalCheckError("range requires min and/or max only")
        bounds = {k: _decimal_literal(params[k], f"range.{k}") for k in ("min", "max") if params.get(k) is not None}
        if not bounds:
            raise TraditionalCheckError("range requires at least one bound")
        if "min" in bounds and "max" in bounds and Decimal(bounds["min"]) > Decimal(bounds["max"]):
            raise TraditionalCheckError("range.min cannot exceed range.max")
        good = ([f"{logical_col} >= {bounds['min']}"] if "min" in bounds else []) + ([f"{logical_col} <= {bounds['max']}"] if "max" in bounds else [])
        bad = ([f"{col} < {bounds['min']}"] if "min" in bounds else []) + ([f"{col} > {bounds['max']}"] if "max" in bounds else [])
        return bounds, " AND ".join(good), f"{col} IS NOT NULL AND ({' OR '.join(bad)})", "must stay within the configured inclusive numeric bounds"
    if check == "length":
        if not params or set(params) - {"min", "max"}:
            raise TraditionalCheckError("length requires min and/or max only")
        bounds = {k: _integer(params[k], f"length.{k}") for k in ("min", "max") if params.get(k) is not None}
        if not bounds:
            raise TraditionalCheckError("length requires at least one bound")
        if "min" in bounds and "max" in bounds and bounds["min"] > bounds["max"]:
            raise TraditionalCheckError("length.min cannot exceed length.max")
        good = ([f"LENGTH({logical_col}) >= {bounds['min']}"] if "min" in bounds else []) + ([f"LENGTH({logical_col}) <= {bounds['max']}"] if "max" in bounds else [])
        bad = ([f"LENGTH({col}) < {bounds['min']}"] if "min" in bounds else []) + ([f"LENGTH({col}) > {bounds['max']}"] if "max" in bounds else [])
        return bounds, " AND ".join(good), f"{col} IS NOT NULL AND ({' OR '.join(bad)})", "must satisfy the configured string-length bounds"
    if check == "allowed_values":
        if set(params) != {"values"} or not isinstance(params.get("values"), list):
            raise TraditionalCheckError("allowed_values requires a values list")
        values = params["values"]
        if not 1 <= len(values) <= 100 or any(not isinstance(v, str) for v in values):
            raise TraditionalCheckError("allowed_values requires 1 to 100 string values")
        if len(values) != len(set(values)):
            raise TraditionalCheckError("allowed_values values must be distinct")
        literal = ", ".join(_quote_string(v) for v in values)
        return {"values": values}, f"{logical_col} IN ({literal})", f"{col} IS NOT NULL AND {col} NOT IN ({literal})", "must belong to the configured allowed values"
    raise TraditionalCheckError(f"Unsupported check {check!r}")


def generate_rules(root: Path, selections: list[Selection]) -> list[dict[str, Any]]:
    """Validate metadata and produce row-returning violation queries deterministically."""
    cache: dict[str, tuple[str, dict[str, str | None]]] = {}
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    for selection in selections:
        key = (selection.table, selection.column, selection.check)
        if key in seen:
            raise TraditionalCheckError(f"Duplicate configuration for {'.'.join(key)}")
        seen.add(key)
        if selection.table not in cache:
            cache[selection.table] = _table_metadata(root, selection.table)
        table_sql, columns = cache[selection.table]
        if selection.column not in columns:
            raise TraditionalCheckError(f"Column {selection.table}.{selection.column} was not discovered")
        canonical, predicate, failure, desc = _check_params(selection, columns[selection.column])
        failure = failure.replace("{table}", table_sql)
        query = f"SELECT *\nFROM {table_sql}\nWHERE {failure}"
        identity = json.dumps([selection.table, selection.column, selection.check, canonical], sort_keys=True, separators=(",", ":"))
        suffix = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
        rid = f"traditional:{selection.table}:{selection.column}:{selection.check}:{suffix}"
        result.append({
            "id": rid,
            "table_name": selection.table,
            "column_name": selection.column,
            "check_type": selection.check,
            "params": canonical,
            "rule": predicate,
            "validation_sql": query,
            "sql_generation_note": "Deterministic Spark SQL violation-row query; SELECT * returns matching rows. Not executed or analyzed.",
            "description": f"{selection.table}.{selection.column} {desc}.",
            "proposed_relation": selection.check,
            "impact": {
                "level": selection.impact_level,
                "reason": "Severity configured by the user for this traditional check; not LLM-assessed.",
            },
        })
    return result


def artifact(root: Path, run_id: str, selections: list[Selection]) -> dict[str, Any]:
    rules = generate_rules(root, selections)
    return {
        "version": 1,
        "run_id": run_id,
        "sql_result_mode": "violation_rows",
        "sql_validation_performed": False,
        "selections": [s.model_dump(mode="json") for s in selections],
        "rules": rules,
    }
