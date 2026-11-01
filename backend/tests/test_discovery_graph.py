
"""Tests for the discovery/profiling LangGraph workflow."""

import pytest

from app.graph import reusable_discovery_workflow as workflow
from app.services import reusable_run_store as store


EXPECTED_STAGES = [
    "dataset_discovery",
    "statistical_profiling",
    "semantic_profiling",
    "table_consolidation",
]


@pytest.fixture
def discovery_run(tmp_path, monkeypatch):
    monkeypatch.setattr(
        store,
        "root_dir",
        lambda: tmp_path / "discovery_runs",
    )

    manifest = store.new_discovery(
        catalog="workspace",
        schema="data_quality_rules",
        config_dir="/Volumes/test/config",
    )

    folder = store.discovery_path(manifest["discovery_id"])

    return folder


def test_graph_topology():
    graph = workflow.build_discovery_graph()

    representation = graph.get_graph()

    actual_nodes = set(representation.nodes)

    for stage in EXPECTED_STAGES:
        assert stage in actual_nodes

    assert "inter_table_consolidation" not in actual_nodes
    assert "individual_recommendations" not in actual_nodes
    assert "inter_table_recommendations" not in actual_nodes

    actual_edges = {
        (edge.source, edge.target)
        for edge in representation.edges
    }

    expected_edges = {
        ("__start__", "dataset_discovery"),
        ("dataset_discovery", "statistical_profiling"),
        ("statistical_profiling", "semantic_profiling"),
        ("semantic_profiling", "table_consolidation"),
        ("table_consolidation", "__end__"),
    }

    assert actual_edges == expected_edges


def test_discovery_manifest_has_four_stages(discovery_run):
    manifest = store.read_json(
        discovery_run / "manifest.json"
    )

    assert list(manifest["stages"]) == EXPECTED_STAGES

    assert all(
        status == "pending"
        for status in manifest["stages"].values()
    )


def test_successful_discovery_execution(
    discovery_run,
    monkeypatch,
):
    """Mock graph events; no Databricks connection needed."""

    class FakeGraph:
        def stream(self, initial_state, **kwargs):
            assert initial_state["artifacts_root"] == str(
                discovery_run
            )

            for stage in EXPECTED_STAGES:
                yield {
                    "type": "updates",
                    "data": {
                        stage: {"processed_count": 1}
                    },
                }

    monkeypatch.setattr(
        workflow,
        "build_discovery_graph",
        lambda: FakeGraph(),
    )

    workflow.run_discovery(str(discovery_run))

    manifest = store.read_json(
        discovery_run / "manifest.json"
    )

    assert manifest["status"] == "completed"

    assert all(
        status == "completed"
        for status in manifest["stages"].values()
    )


def test_incomplete_discovery_fails(
    discovery_run,
    monkeypatch,
):
    """A prematurely ended graph must not complete the run."""

    class FakeGraph:
        def stream(self, initial_state, **kwargs):
            yield {
                "type": "updates",
                "data": {
                    "dataset_discovery": {}
                },
            }

    monkeypatch.setattr(
        workflow,
        "build_discovery_graph",
        lambda: FakeGraph(),
    )

    with pytest.raises(
        RuntimeError,
        match="incomplete stages",
    ):
        workflow.run_discovery(str(discovery_run))

    manifest = store.read_json(
        discovery_run / "manifest.json"
    )

    assert manifest["status"] == "failed"

    assert (
        manifest["stages"]["statistical_profiling"]
        == "interrupted"
    )
