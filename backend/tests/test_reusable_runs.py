"""No Databricks or LLM connection required for these tests."""
import json
from pathlib import Path

import pytest
import yaml

from app.services import reusable_run_store as store

from app.services.scoped_recommendation_inputs import (
    SelectionError,
    prepare_inputs,
    validate_selection,
    prepare_scoped_inputs,
    consolidate_scoped_inter_table,
)



@pytest.fixture()
def parent_run(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(store, "root_dir", lambda: tmp_path / "discovery_runs")
    info = store.new_discovery("workspace", "data_quality_rules", "/Volumes/x")
    parent = store.discovery_path(info["discovery_id"])
    profiles = parent / "consolidated_profiles"
    profiles.mkdir()
    for table, cols in {
        "orders": ["order_id", "total_amount"],
        "payments": ["payment_id", "order_id", "amount"],
    }.items():
        obj = {
            "table_name": table,
            "table_semantics": {"description": f"{table} records", "row_grain": f"one {table} row"},
            "columns": {c: {"datatype": "STRING" if c.endswith("id") else "DOUBLE",
                            "description": c} for c in cols},
        }
        (profiles / f"{table}.yaml").write_text(yaml.safe_dump(obj), encoding="utf-8")
        store.write_json(parent / "discovery" / "tables" / f"{table}.json", {
            "catalog": "workspace", "schema": "data_quality_rules", "table_name": table,
            "columns": [{"name": c, "ordinal_position": i + 1} for i, c in enumerate(cols)],
        })
        store.write_json(parent / "discovery" / "configs" / f"{table}.json", {
            "table_name": table, "columns": [{"name": c, "datatype": "STRING"} for c in cols],
        })
    store.write_json(parent / "discovery" / "matching_results.json", {
        "columns_matched_tables": ["orders", "payments"],
    })
    store.write_json(parent / "discovery" / "relationships.json", {
        "foreign_keys": [{"from_table": "payments", "from_column": "order_id",
                          "to_table": "orders", "to_column": "order_id", "cardinality": "N:1"}],
    })
    store.update(parent, status="completed")
    return info["discovery_id"], parent


def test_names_and_artifact_isolation(parent_run):
    id, parent = parent_run
    a = store.new_recommendation(id, "Payment Validation", {"orders": ["total_amount"]}, "Policy A")
    b = store.new_recommendation(id, "Payment Validation", {"orders": ["order_id"]}, "Policy B")
    assert a["recommendation_id"] != b["recommendation_id"]
    assert a["recommendation_id"].startswith("payment-validation__")
    assert store.recommendation_path(id, a["recommendation_id"]) != store.recommendation_path(id, b["recommendation_id"])
    assert (parent / "consolidated_profiles" / "orders.yaml").exists()
    assert len(store.list_recommendations(id)) == 2
    assert (store.recommendation_path(id, b["recommendation_id"]) / "business_context.txt").read_text() == "Policy B"


def test_scoped_profiles_and_context_only_fk(parent_run):
    id, parent = parent_run
    selected = {"orders": ["total_amount"], "payments": ["amount"]}
    summary = validate_selection(parent, selected)
    assert summary["cross_table_ready"] is True
    assert not (parent / "recommendation_runs").exists()
    r = store.new_recommendation(id, "Financial Checks", selected)
    child = store.recommendation_path(id, r["recommendation_id"])
    result = prepare_inputs(parent, child, selected)
    assert result["included_relationship_count"] == 1
    assert result["supporting_join_columns"] == {"orders": ["order_id"], "payments": ["order_id"]}
    individual = yaml.safe_load((child / "consolidated_profiles" / "orders.yaml").read_text())
    assert set(individual["columns"]) == {"total_amount"}
    cross = yaml.safe_load((child / "consolidated_profiles" / "inter_table_consolidated.yaml").read_text())
    assert cross["tables"]["orders"]["columns"]["order_id"]["recommendation_target"] is False
    assert cross["tables"]["orders"]["columns"]["total_amount"]["recommendation_target"] is True
    assert len(cross["relationships"]["foreign_keys"]) == 1
    assert yaml.safe_load((parent / "consolidated_profiles" / "orders.yaml").read_text())["columns"].keys() >= {"order_id", "total_amount"}
    assert json.loads((child / "selection_snapshot.json").read_text())["selections"] == selected


def test_invalid_selections_do_not_write(parent_run):
    _, parent = parent_run
    with pytest.raises(SelectionError, match="Unknown columns"):
        validate_selection(parent, {"orders": ["not_real"]})
    with pytest.raises(SelectionError, match="empty table"):
        validate_selection(parent, {"orders": []})
    with pytest.raises(SelectionError, match="unmatched"):
        validate_selection(parent, {"unlisted_table": ["any"]})


def test_one_table_skips_cross_profile(parent_run):
    id, parent = parent_run
    selected = {"orders": ["total_amount"]}
    r = store.new_recommendation(id, "One table", selected)
    child = store.recommendation_path(id, r["recommendation_id"])
    result = prepare_inputs(parent, child, selected)
    assert result["cross_table_ready"] is False
    assert not (child / "consolidated_profiles" / "inter_table_consolidated.yaml").exists()


def test_scoped_preparation_does_not_run_inter_table(parent_run):
    """The preparation stage must not perform consolidation."""

    discovery_id, parent = parent_run

    selections = {
        "orders": ["total_amount"],
        "payments": ["amount"],
    }

    run = store.new_recommendation(
        discovery_id,
        "Scoped Only",
        selections,
    )

    child = store.recommendation_path(
        discovery_id,
        run["recommendation_id"],
    )

    summary = prepare_scoped_inputs(
        parent,
        child,
        selections,
    )

    assert summary["cross_table_ready"] is True
    assert summary["included_relationship_count"] == 1

    # Individual profiles must exist.
    assert (
        child / "consolidated_profiles" / "orders.yaml"
    ).is_file()

    assert (
        child / "consolidated_profiles" / "payments.yaml"
    ).is_file()

    # Inter-table consolidation must NOT have executed.
    assert not (
        child
        / "consolidated_profiles"
        / "inter_table_consolidated.yaml"
    ).exists()

    # Selection metadata is persisted.
    snapshot = store.read_json(
        child / "selection_snapshot.json"
    )

    assert snapshot["selections"] == selections


def test_inter_table_consolidation_runs_separately(parent_run):
    """Cross-table YAML should be generated only when requested."""

    discovery_id, parent = parent_run

    selections = {
        "orders": ["total_amount"],
        "payments": ["amount"],
    }

    run = store.new_recommendation(
        discovery_id,
        "Cross Table",
        selections,
    )

    child = store.recommendation_path(
        discovery_id,
        run["recommendation_id"],
    )

    prepare_scoped_inputs(
        parent,
        child,
        selections,
    )

    result = consolidate_scoped_inter_table(
        parent,
        child,
    )

    assert result is not None
    assert result["inter_table_profile_table_count"] == 2
    assert result["inter_table_profile_foreign_key_count"] == 1

    output = (
        child
        / "consolidated_profiles"
        / "inter_table_consolidated.yaml"
    )

    assert output.is_file()

    combined = yaml.safe_load(
        output.read_text(encoding="utf-8")
    )

    # Selected business columns are recommendation targets.
    assert (
        combined["tables"]["orders"]["columns"]
        ["total_amount"]["recommendation_target"]
        is True
    )

    # The unselected join column is context only.
    assert (
        combined["tables"]["orders"]["columns"]
        ["order_id"]["recommendation_target"]
        is False
    )


def test_two_recommendation_runs_have_isolated_inputs(parent_run):
    """Independent child runs cannot overwrite each other's scopes."""

    discovery_id, parent = parent_run

    original_path = (
        parent / "consolidated_profiles" / "orders.yaml"
    )
    original_content = original_path.read_text(
        encoding="utf-8"
    )

    first_selection = {
        "orders": ["total_amount"],
    }

    second_selection = {
        "orders": ["order_id"],
    }

    first = store.new_recommendation(
        discovery_id,
        "Amount Checks",
        first_selection,
    )

    second = store.new_recommendation(
        discovery_id,
        "Identifier Checks",
        second_selection,
    )

    first_dir = store.recommendation_path(
        discovery_id,
        first["recommendation_id"],
    )

    second_dir = store.recommendation_path(
        discovery_id,
        second["recommendation_id"],
    )

    prepare_scoped_inputs(
        parent,
        first_dir,
        first_selection,
    )

    prepare_scoped_inputs(
        parent,
        second_dir,
        second_selection,
    )

    first_yaml = yaml.safe_load(
        (
            first_dir / "consolidated_profiles" / "orders.yaml"
        ).read_text(encoding="utf-8")
    )

    second_yaml = yaml.safe_load(
        (
            second_dir / "consolidated_profiles" / "orders.yaml"
        ).read_text(encoding="utf-8")
    )

    assert set(first_yaml["columns"]) == {"total_amount"}
    assert set(second_yaml["columns"]) == {"order_id"}

    # Graph 1's original profile is unchanged.
    assert original_path.read_text(
        encoding="utf-8"
    ) == original_content

    # Neither one-table selection requires inter-table consolidation.
    assert consolidate_scoped_inter_table(
        parent,
        first_dir,
    ) is None
