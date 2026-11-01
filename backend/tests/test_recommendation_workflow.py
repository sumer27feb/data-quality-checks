
"""Offline tests for independent recommendation LangGraph."""

from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from app.graph.recommendation_workflow import (
    build_recommendation_graph,
    choose_recommendation_branches,
)
from app.nodes import scoped_recommendation_nodes as nodes
from app.services import reusable_run_store as store


@pytest.fixture
def discovery_run(tmp_path, monkeypatch):
    monkeypatch.setattr(
        store,
        "root_dir",
        lambda: tmp_path / "discovery_runs",
    )

    info = store.new_discovery(
        "workspace",
        "data_quality_rules",
        "/Volumes/test/config",
    )

    parent = store.discovery_path(info["discovery_id"])
    profiles = parent / "consolidated_profiles"
    profiles.mkdir()

    tables = {
        "orders": ["order_id", "total_amount"],
        "payments": ["payment_id", "order_id", "amount"],
    }

    for table, columns in tables.items():
        profile = {
            "table_name": table,
            "table_semantics": {
                "description": f"{table} records",
                "row_grain": f"one row per {table} record",
            },
            "columns": {
                col: {
                    "datatype": "STRING" if col.endswith("id") else "DOUBLE",
                    "description": col,
                }
                for col in columns
            },
        }

        (profiles / f"{table}.yaml").write_text(
            yaml.safe_dump(profile),
            encoding="utf-8",
        )

        store.write_json(
            parent / "discovery" / "tables" / f"{table}.json",
            {
                "table_name": table,
                "columns": [{"name": col} for col in columns],
            },
        )

        store.write_json(
            parent / "discovery" / "configs" / f"{table}.json",
            {
                "table_name": table,
                "columns": [
                    {"name": col, "datatype": "STRING"}
                    for col in columns
                ],
            },
        )

    store.write_json(
        parent / "discovery" / "matching_results.json",
        {
            "columns_matched_tables": list(tables),
        },
    )

    store.write_json(
        parent / "discovery" / "relationships.json",
        {
            "foreign_keys": [{
                "from_table": "payments",
                "from_column": "order_id",
                "to_table": "orders",
                "to_column": "order_id",
                "cardinality": "N:1",
            }],
        },
    )

    store.update(parent, status="completed")

    return info["discovery_id"], parent


@pytest.fixture
def fake_llms(monkeypatch):
    """Replace actual LLM generation with predictable responses."""

    calls = []

    def fake_individual(
        artifacts_root, model, business_context
    ):
        calls.append(("individual", business_context))
        return SimpleNamespace(
            output_dir=Path(artifacts_root) / "recommendations" / "individual_tables",
            table_count=2,
            rule_count=6,
        )

    def fake_inter_table(
        artifacts_root, model, business_context
    ):
        calls.append(("inter_table", business_context))
        return SimpleNamespace(
            output_path=Path(artifacts_root) / "recommendations" / "inter_table.json",
            rule_count=3,
        )

    monkeypatch.setattr(
        nodes,
        "generate_individual_rule_recommendations",
        fake_individual,
    )

    monkeypatch.setattr(
        nodes,
        "generate_inter_table_rule_recommendations",
        fake_inter_table,
    )

    return calls


def create_child(
    discovery_id,
    selections,
    individual=True,
    inter_table=True,
    context="",
):
    run = store.new_recommendation(
        discovery_id,
        "Graph 2 Test",
        selections,
        context,
        individual,
        inter_table,
    )

    return run["recommendation_id"]


def invoke_graph(discovery_id, recommendation_id):
    return build_recommendation_graph().invoke({
        "discovery_id": discovery_id,
        "recommendation_id": recommendation_id,
        "llm_model": "mock-model",
    })


def test_graph_contains_no_profiling_nodes():
    graph = build_recommendation_graph()

    names = set(graph.get_graph().nodes)

    assert "load_saved_profiles" in names
    assert "scoped_metadata" in names
    assert "individual_recommendations" in names
    assert "inter_table_consolidation" in names
    assert "inter_table_recommendations" in names

    assert "dataset_discovery" not in names
    assert "statistical_profiling" not in names
    assert "semantic_profiling" not in names
    assert "table_consolidation" not in names


def test_both_recommendation_branches(
    discovery_run,
    fake_llms,
):
    discovery_id, parent = discovery_run

    selections = {
        "orders": ["total_amount"],
        "payments": ["amount"],
    }

    rec_id = create_child(
        discovery_id,
        selections,
        context="Amounts must follow finance policy.",
    )

    result = invoke_graph(discovery_id, rec_id)

    assert result["cross_table_ready"] is True
    assert result["individual_recommendation_rule_count"] == 6
    assert result["inter_table_recommendation_rule_count"] == 3

    assert {name for name, _ in fake_llms} == {
        "individual",
        "inter_table",
    }

    assert all(
        context == "Amounts must follow finance policy."
        for _, context in fake_llms
    )

    child = store.recommendation_path(discovery_id, rec_id)

    assert (
        child / "consolidated_profiles" / "inter_table_consolidated.yaml"
    ).is_file()

    # Original discovery profile remains untouched.
    original = yaml.safe_load(
        (
            parent / "consolidated_profiles" / "orders.yaml"
        ).read_text(encoding="utf-8")
    )

    assert set(original["columns"]) == {
        "order_id",
        "total_amount",
    }


def test_single_table_skips_inter_table(
    discovery_run,
    fake_llms,
):
    discovery_id, _ = discovery_run

    rec_id = create_child(
        discovery_id,
        {"orders": ["total_amount"]},
    )

    result = invoke_graph(discovery_id, rec_id)

    assert result["cross_table_ready"] is False
    assert [name for name, _ in fake_llms] == ["individual"]
    assert "inter_table_recommendation_rule_count" not in result

    child = store.recommendation_path(discovery_id, rec_id)

    assert not (
        child / "consolidated_profiles" / "inter_table_consolidated.yaml"
    ).exists()


def test_inter_table_only(
    discovery_run,
    fake_llms,
):
    discovery_id, _ = discovery_run

    rec_id = create_child(
        discovery_id,
        {
            "orders": ["total_amount"],
            "payments": ["amount"],
        },
        individual=False,
        inter_table=True,
    )

    result = invoke_graph(discovery_id, rec_id)

    assert result["inter_table_recommendation_rule_count"] == 3
    assert [name for name, _ in fake_llms] == ["inter_table"]
    assert "individual_recommendation_rule_count" not in result


def test_reject_incomplete_parent(
    discovery_run,
    fake_llms,
):
    discovery_id, parent = discovery_run

    rec_id = create_child(
        discovery_id,
        {"orders": ["order_id"]},
    )

    # Simulate a parent that is no longer eligible.
    store.update(parent, status="failed")

    with pytest.raises(ValueError, match="not completed"):
        invoke_graph(discovery_id, rec_id)

    assert fake_llms == []
