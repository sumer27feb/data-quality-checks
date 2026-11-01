
"""Offline tests for Graph 2 execution and status persistence."""

import pytest

from app.services import reusable_run_store as store
from app.services.recommendation_runner import (
    run_recommendation,
)


class FakeGraph:
    """Simulate LangGraph v2 update events."""

    def __init__(self, updates, error=None):
        self.updates = updates
        self.error = error
        self.initial_state = None

    def stream(self, initial_state, **kwargs):
        self.initial_state = initial_state

        assert kwargs["stream_mode"] == "updates"
        assert kwargs["version"] == "v2"

        for update in self.updates:
            yield {
                "type": "updates",
                "data": update,
            }

        if self.error is not None:
            raise self.error


@pytest.fixture
def run_factory(tmp_path, monkeypatch):
    monkeypatch.setattr(
        store,
        "root_dir",
        lambda: tmp_path / "discovery_runs",
    )

    discovery = store.new_discovery(
        "workspace",
        "data_quality_rules",
        "/Volumes/test/config",
    )

    discovery_id = discovery["discovery_id"]
    parent = store.discovery_path(discovery_id)

    store.update(parent, status="completed")

    def create(
        selections=None,
        individual=True,
        inter_table=True,
    ):
        run = store.new_recommendation(
            discovery_id,
            "Runner Test",
            selections or {"orders": ["order_id"]},
            individual=individual,
            inter_table=inter_table,
        )

        child = store.recommendation_path(
            discovery_id,
            run["recommendation_id"],
        )

        return discovery_id, run["recommendation_id"], child

    return create


def load_event(individual=True, inter_table=True):
    return {
        "load_saved_profiles": {
            "run_individual": individual,
            "run_inter_table": inter_table,
        }
    }


def scope_event(cross_ready):
    return {
        "scoped_metadata": {
            "cross_table_ready": cross_ready,
            "selected_table_count": 2 if cross_ready else 1,
            "selected_column_count": 3,
            "included_relationship_count": 1 if cross_ready else 0,
        }
    }


def test_new_manifest_matches_graph_stages(run_factory):
    _, _, child = run_factory()

    manifest = store.read_json(child / "manifest.json")

    assert tuple(manifest["stages"]) == store.RECOMMENDATION_STAGES

    assert all(
        status == "pending"
        for status in manifest["stages"].values()
    )


def test_both_branches_complete_and_persist(run_factory):
    discovery_id, rec_id, child = run_factory()

    graph = FakeGraph([
        load_event(),
        scope_event(cross_ready=True),

        # Two parallel nodes report in one graph event.
        {
            "inter_table_consolidation": {
                "inter_table_profile_table_count": 2,
                "inter_table_profile_foreign_key_count": 1,
            },
            "individual_recommendations": {
                "individual_recommendation_table_count": 2,
                "individual_recommendation_rule_count": 8,
            },
        },

        {
            "inter_table_recommendations": {
                "inter_table_recommendation_rule_count": 4,
            }
        },
    ])

    run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "completed"

    assert all(
        status == "completed"
        for status in manifest["stages"].values()
    )

    assert manifest["metrics"]["individual_recommendation_rule_count"] == 8
    assert manifest["metrics"]["inter_table_recommendation_rule_count"] == 4
    assert manifest["metrics"]["selected_table_count"] == 2

    assert graph.initial_state["discovery_id"] == discovery_id
    assert graph.initial_state["recommendation_id"] == rec_id

    # Existing API reads the same persisted manifest.
    from app.api.reusable_routes import get_recommendation_run

    response = get_recommendation_run(discovery_id, rec_id)

    assert response["status"] == "completed"
    assert response["stages"] == manifest["stages"]


def test_single_table_skips_cross_branch(run_factory):
    discovery_id, rec_id, child = run_factory()

    graph = FakeGraph([
        load_event(),
        scope_event(cross_ready=False),
        {
            "individual_recommendations": {
                "individual_recommendation_table_count": 1,
                "individual_recommendation_rule_count": 3,
            }
        },
    ])

    run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "completed"

    assert manifest["stages"]["individual_recommendations"] == "completed"
    assert manifest["stages"]["inter_table_consolidation"] == "skipped"
    assert manifest["stages"]["inter_table_recommendations"] == "skipped"


def test_cross_table_only_run(run_factory):
    discovery_id, rec_id, child = run_factory(
        selections={
            "orders": ["order_id"],
            "payments": ["order_id"],
        },
        individual=False,
        inter_table=True,
    )

    graph = FakeGraph([
        load_event(individual=False, inter_table=True),
        scope_event(cross_ready=True),
        {
            "inter_table_consolidation": {
                "inter_table_profile_table_count": 2,
                "inter_table_profile_foreign_key_count": 1,
            }
        },
        {
            "inter_table_recommendations": {
                "inter_table_recommendation_rule_count": 5,
            }
        },
    ])

    run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "completed"
    assert manifest["stages"]["individual_recommendations"] == "skipped"
    assert manifest["stages"]["inter_table_consolidation"] == "completed"
    assert manifest["stages"]["inter_table_recommendations"] == "completed"


def test_no_applicable_branch_finishes_with_skips(run_factory):
    discovery_id, rec_id, child = run_factory(
        individual=False,
        inter_table=True,
    )

    graph = FakeGraph([
        load_event(individual=False, inter_table=True),
        scope_event(cross_ready=False),
    ])

    run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "completed"
    assert manifest["stages"]["load_saved_profiles"] == "completed"
    assert manifest["stages"]["scoped_metadata"] == "completed"

    for stage in (
        "individual_recommendations",
        "inter_table_consolidation",
        "inter_table_recommendations",
    ):
        assert manifest["stages"][stage] == "skipped"


def test_failure_interrupts_parallel_branches(run_factory):
    discovery_id, rec_id, child = run_factory()

    graph = FakeGraph(
        updates=[
            load_event(),
            scope_event(cross_ready=True),
        ],
        error=RuntimeError("Simulated LLM failure"),
    )

    with pytest.raises(RuntimeError, match="Simulated LLM"):
        run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "failed"
    assert "Simulated LLM failure" in manifest["error"]

    assert manifest["stages"]["load_saved_profiles"] == "completed"
    assert manifest["stages"]["scoped_metadata"] == "completed"

    assert manifest["stages"]["individual_recommendations"] == "interrupted"
    assert manifest["stages"]["inter_table_consolidation"] == "interrupted"

    # Downstream cross-table inference had not started.
    assert manifest["stages"]["inter_table_recommendations"] == "pending"


def test_premature_graph_end_fails(run_factory):
    discovery_id, rec_id, child = run_factory()

    graph = FakeGraph([
        load_event(),
    ])

    with pytest.raises(RuntimeError, match="unfinished stages"):
        run_recommendation(discovery_id, rec_id, graph=graph)

    manifest = store.read_json(child / "manifest.json")

    assert manifest["status"] == "failed"
    assert manifest["stages"]["load_saved_profiles"] == "completed"
    assert manifest["stages"]["scoped_metadata"] == "interrupted"
