"""Offline tests; a Databricks connection is not required."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path
import sys

import pytest

# Run from backend/ after extracting: python -m pytest tests/test_statistical_profiler.py -v
# Also work when executed from this standalone delivery directory.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.statistical_profiler import (
    _write_profiles, build_aggregate_query, build_top_values_query,
    get_conversion_expression, normalize_type, profile_dataset, profile_table,
    quote_ident, type_family,
)


def test_type_aliases_and_safe_decimal_normalization():
    assert normalize_type(" int ") == "INTEGER"
    assert normalize_type("integer") == "INTEGER"
    assert normalize_type("long") == "BIGINT"
    assert normalize_type("bool") == "BOOLEAN"
    assert normalize_type("varchar(45)") == "STRING"
    assert normalize_type("CHAR(4)") == "STRING"
    assert normalize_type("numeric(12, 2)") == "DECIMAL(12,2)"
    assert normalize_type("DECIMAL(12,02)") == "DECIMAL(12,2)"
    assert normalize_type("DECIMAL(12,2)") != normalize_type("DECIMAL(18,2)")
    assert normalize_type("INTEGER") != normalize_type("BIGINT")
    with pytest.raises(ValueError):
        normalize_type("DECIMAL(39,2)")
    with pytest.raises(ValueError):
        normalize_type("DECIMAL(4,5)")


def test_conversion_policy():
    assert get_conversion_expression("qty", "INTEGER", "INT") == ("`qty`", "DIRECT")
    assert get_conversion_expression("arrival", "DATE", "STRING") == (
        "TRY_CAST(`arrival` AS DATE)", "CONVERTED"
    )
    assert get_conversion_expression("qty", "INTEGER", "TIMESTAMP") == (
        None, "UNSUPPORTED_TYPE_MISMATCH"
    )
    assert get_conversion_expression("amount", "DECIMAL(12,2)", "DECIMAL(18,2)") == (
        None, "UNSUPPORTED_TYPE_MISMATCH"
    )
    # CHAR and VARCHAR considered string family for profiling; lengths belong to DQ checks
    assert get_conversion_expression("name", "VARCHAR(10)", "STRING") == ("`name`", "DIRECT")
    # Bad SQL text is never inserted into the CAST target.
    assert get_conversion_expression("val", "evil); DROP TABLE abc;--", "STRING") == (
        None, "UNSUPPORTED_TYPE_MISMATCH"
    )
    assert quote_ident("tick`name") == "`tick``name`"


def make_plans():
    from app.services.statistical_profiler import _column_plan
    return [
        _column_plan({"name": "qty", "datatype": "INTEGER"}, "qty", "STRING"),
        _column_plan({"name": "charge", "datatype": "DECIMAL(12,2)"}, "charge", "DECIMAL(12,2)"),
        _column_plan({"name": "arrival", "datatype": "DATE"}, "arrival", "STRING"),
        _column_plan({"name": "bad", "datatype": "INTEGER"}, "bad", "TIMESTAMP"),
        _column_plan({"name": "status", "datatype": "STRING"}, "status", "STRING"),
        _column_plan({"name": "enabled", "datatype": "BOOLEAN"}, "enabled", "BOOLEAN"),
    ]


def test_generated_sql_uses_only_ctes_and_aggregates():
    sql = build_aggregate_query("workspace", "data_quality_rules", "testing", make_plans())
    assert "FROM `workspace`.`data_quality_rules`.`testing`" in sql
    assert "TRY_CAST(`qty` AS INTEGER) AS `c0_value`" in sql
    assert "`charge` AS `c1_value`" in sql
    assert "TRY_CAST(`arrival` AS DATE) AS `c2_value`" in sql
    assert "TRY_CAST(`bad`" not in sql
    assert "COUNT_IF(`c0_raw` IS NOT NULL AND `c0_value` IS NULL)" in sql
    assert "PERCENTILE_APPROX(`c0_value`, 0.25)" in sql
    assert "DATEDIFF(MAX(`c2_value`), MIN(`c2_value`))" in sql
    assert "LENGTH(`c4_value`)" in sql
    assert "`c5_true_count`" in sql
    for forbidden in ("INSERT ", "UPDATE ", "CREATE ", "DELETE ", "ALTER ", "MERGE ", "CACHE "):
        assert forbidden not in sql.upper()
    top_sql = build_top_values_query("a", "b", "c", "status", 10)
    assert "ORDER BY frequency DESC" in top_sql
    with pytest.raises(ValueError):
        build_top_values_query("a", "b", "c", "status", 0)


class MockCursor:
    def __init__(self, conn):
        self.conn = conn
        self.description = []
        self.rows = []
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return None
    def execute(self, query):
        self.conn.queries.append(query)
        if "information_schema.columns" in query:
            payload = self.conn.metadata_rows
        elif "ORDER BY frequency DESC" in query:
            payload = self.conn.top_rows
        else:
            payload = self.conn.aggregate_rows
        self.description = [(name,) for name in payload[0]] if payload else []
        self.rows = [tuple(row.values()) for row in payload]
    def fetchone(self):
        return self.rows[0] if self.rows else None
    def fetchall(self):
        return self.rows


class MockConnection:
    def __init__(self, metadata_rows=None, aggregate_rows=None, top_rows=None):
        self.metadata_rows = metadata_rows or []
        self.aggregate_rows = aggregate_rows or []
        self.top_rows = top_rows or []
        self.queries = []
        self.closed = False
    def cursor(self):
        return MockCursor(self)
    def close(self):
        self.closed = True


def make_table():
    names = ["qty", "charge", "arrival", "bad", "status", "enabled"]
    return {"catalog": "workspace", "schema": "data_quality_rules", "table_name": "testing",
            "columns": [{"name": name, "ordinal_position": i+1} for i, name in enumerate(names)]}


def make_config():
    return {"table_name": "testing", "columns": [
        {"name": "qty", "datatype": "INTEGER", "nullable": False},
        {"name": "charge", "datatype": "DECIMAL(12,2)", "nullable": False},
        {"name": "arrival", "datatype": "DATE", "nullable": False},
        {"name": "bad", "datatype": "INTEGER", "nullable": True},
        {"name": "status", "datatype": "STRING", "nullable": False},
        {"name": "enabled", "datatype": "BOOLEAN", "nullable": False},
    ]}


def sample_agg():
    return {
        "row_count": 6,
        "c0_null_count": 1, "c0_valid_count": 3, "c0_invalid_count": 2,
        "c0_min": -3, "c0_max": 25, "c0_mean": 10.666666,
        "c0_stddev": 14.011, "c0_p25": -3, "c0_p50": 10, "c0_p75": 25,
        "c0_zero_count": 0, "c0_negative_count": 1, "c0_distinct_count": 3,
        "c1_null_count": 0, "c1_valid_count": 6, "c1_invalid_count": 0,
        "c1_min": Decimal("4.00"), "c1_max": Decimal("9.00"), "c1_mean": Decimal("6.50"),
        "c1_stddev": 2.0, "c1_p25": Decimal("4.00"), "c1_p50": Decimal("6.00"),
        "c1_p75": Decimal("8.00"), "c1_zero_count": 0, "c1_negative_count": 0,
        "c1_distinct_count": 4,
        "c2_null_count": 1, "c2_valid_count": 4, "c2_invalid_count": 1,
        "c2_min_date": date_from("2026-01-01"), "c2_max_date": date_from("2026-01-05"),
        "c2_distinct_count": 4, "c2_date_range_days": 4,
        "c3_null_count": 2,
        "c4_null_count": 0, "c4_valid_count": 6, "c4_invalid_count": 0,
        "c4_min_length": 4, "c4_max_length": 8, "c4_avg_length": 6.0,
        "c4_empty_count": 0, "c4_whitespace_only_count": 0, "c4_distinct_count": 2,
        "c5_null_count": 0, "c5_valid_count": 6, "c5_invalid_count": 0,
        "c5_true_count": 4, "c5_false_count": 2,
    }


def date_from(s):
    from datetime import date
    return date.fromisoformat(s)


def test_profile_table_converts_only_valid_types_and_counts_invalid():
    conn = MockConnection(aggregate_rows=[sample_agg()], top_rows=[
        {"value": "DONE", "frequency": 4}, {"value": "PENDING", "frequency": 2}
    ])
    physical = {
        "qty": "STRING", "charge": "DECIMAL(12,2)", "arrival": "STRING",
        "bad": "TIMESTAMP", "status": "STRING", "enabled": "BOOLEAN"
    }
    result = profile_table(
        conn, "workspace", "data_quality_rules", "testing", make_table(), make_config(), physical
    )
    assert result["row_count"] == 6
    assert result["column_count"] == 6
    qty = result["columns"]["qty"]
    assert qty["profiling_status"] == "CONVERTED"
    assert qty["conversion_success_rate"] == 60.0
    assert (qty["null_count"], qty["valid_count"], qty["invalid_count"]) == (1, 3, 2)
    assert qty["statistics"]["min"] == -3
    assert result["columns"]["charge"]["statistics"]["min"] == "4.00"
    assert result["columns"]["charge"]["conversion_success_rate"] is None
    assert result["columns"]["arrival"]["statistics"]["min_date"] == "2026-01-01"
    assert result["columns"]["bad"]["statistics"] is None
    assert result["columns"]["bad"]["valid_count"] is None
    assert result["columns"]["enabled"]["statistics"]["true_count"] == 4
    assert result["columns"]["status"]["statistics"]["top_values"] == [
        {"value": "DONE", "count": 4}, {"value": "PENDING", "count": 2}
    ]
    assert len(conn.queries) == 2


def test_counts_dont_reconcile_fails():
    data = sample_agg()
    data["c0_invalid_count"] = 200
    conn = MockConnection(aggregate_rows=[data])
    physical = {p["name"].casefold(): p["physical_raw"] for p in make_plans()}
    with pytest.raises(ValueError, match="do not reconcile"):
        profile_table(conn, "workspace", "data_quality_rules", "testing",
                      make_table(), make_config(), physical, top_values_limit=0)


def test_staging_replaces_stale_profile_files(tmp_path):
    path = tmp_path / "statistical_profiles"
    _write_profiles(path, {"a": {"table_name": "a"}, "old": {"table_name": "old"}})
    _write_profiles(path, {"a": {"table_name": "a", "row_count": 22}})
    assert not (path / "old.json").exists()
    assert json.loads((path / "a.json").read_text())["row_count"] == 22
    assert not (tmp_path / ".statistical_profiles_previous").exists()


def test_integration_with_discovery_artifacts_mock_databricks(tmp_path):
    discovery = tmp_path / "workspace.data_quality_rules" / "discovery"
    (discovery / "tables").mkdir(parents=True)
    (discovery / "configs").mkdir()
    (discovery / "matching_results.json").write_text(
        json.dumps({"columns_matched_tables": ["testing"]}), encoding="utf-8"
    )
    (discovery / "tables" / "testing.json").write_text(json.dumps(make_table()), encoding="utf-8")
    (discovery / "configs" / "testing.json").write_text(json.dumps(make_config()), encoding="utf-8")
    (discovery / "configs" / "relationships.json").write_text('{"relationships":[]}', encoding="utf-8")
    metadata_rows = [
        {"table_name": "testing", "column_name": p["name"], "full_data_type": p["physical_raw"], "data_type": p["physical_raw"]}
        for p in make_plans()
    ]
    connection = MockConnection(metadata_rows=metadata_rows, aggregate_rows=[sample_agg()])
    result = profile_dataset(artifacts_root=tmp_path, sql_connection=connection, top_values_limit=0)
    assert result["table_count"] == 1
    assert result["column_count"] == 6
    assert result["status_counts"] == {"DIRECT": 3, "CONVERTED": 2, "UNSUPPORTED_TYPE_MISMATCH": 1}
    assert Path(result["statistical_profiles_path"]).joinpath("testing.json").is_file()
    assert connection.closed is False  # externally owned


def test_representative_mock_ecommerce_config_types():
    # Types actually used in the previously generated seven-table dataset.
    for declared in ("STRING", "DATE", "BOOLEAN", "INTEGER", "DECIMAL(12,2)"):
        assert type_family(normalize_type(declared)) in {
            "numeric", "string", "date", "boolean"
        }
