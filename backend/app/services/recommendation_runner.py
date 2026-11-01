
"""Execute Graph 2 and persist recommendation stage statuses.

LangGraph determines which nodes execute.
This runner observes node updates and persists their outcomes.
"""

from __future__ import annotations

from typing import Any

from app.config import DATABRICKS_MODEL_ENDPOINT
from app.services import reusable_run_store as store


# Only these numeric fields are persisted from graph output.
# Paths, business context and complete graph state are excluded.
STAGE_METRICS = {
    "load_saved_profiles": (),
    "scoped_metadata": (
        "selected_table_count",
        "selected_column_count",
        "included_relationship_count",
    ),
    "individual_recommendations": (
        "individual_recommendation_table_count",
        "individual_recommendation_rule_count",
    ),
    "inter_table_consolidation": (
        "inter_table_profile_table_count",
        "inter_table_profile_foreign_key_count",
    ),
    "inter_table_recommendations": (
        "inter_table_recommendation_rule_count",
    ),
}


def _metrics_for_stage(
    stage: str,
    output: dict[str, Any],
) -> dict[str, int]:
    """Extract only explicitly supported integer metrics."""

    return {
        key: output[key]
        for key in STAGE_METRICS[stage]
        if type(output.get(key)) is int
    }


def _set_skipped(child, stage: str) -> None:
    """Mark a branch node that LangGraph will not execute."""

    store.set_stage(child, stage, "skipped")


def run_recommendation(
    discovery_id: str,
    recommendation_id: str,
    *,
    graph: Any = None,
) -> None:
    """Execute a new recommendation run through Graph 2.

    An optional graph can be supplied for offline testing.
    """

    child = store.recommendation_path(
        discovery_id,
        recommendation_id,
    )

    manifest = store.read_json(child / "manifest.json")

    if manifest["status"] != "queued":
        raise ValueError(
            "Only queued recommendation runs can be started"
        )

    if tuple(manifest["stages"]) != store.RECOMMENDATION_STAGES:
        raise ValueError(
            "Recommendation manifest does not match Graph 2 stages"
        )

    if graph is None:
        from app.graph.recommendation_workflow import (
            recommendation_graph,
        )

        graph = recommendation_graph

    initial_state = {
        "discovery_id": discovery_id,
        "recommendation_id": recommendation_id,
        "llm_model": DATABRICKS_MODEL_ENDPOINT,
    }

    individual_enabled = None
    inter_table_enabled = None

    try:
        store.update(
            child,
            status="running",
            error=None,
        )

        store.set_stage(
            child,
            "load_saved_profiles",
            "running",
        )

        for event in graph.stream(
            initial_state,
            stream_mode="updates",
            version="v2",
        ):
            if event.get("type") != "updates":
                continue

            updates = event.get("data")

            if not isinstance(updates, dict):
                raise RuntimeError(
                    "Malformed LangGraph update event"
                )

            # A single event may contain updates from multiple
            # branches executed in the same graph superstep.
            for stage, output in updates.items():
                if stage not in store.RECOMMENDATION_STAGES:
                    raise RuntimeError(
                        f"Unexpected Graph 2 stage: {stage}"
                    )

                if not isinstance(output, dict):
                    raise RuntimeError(
                        f"Invalid output from stage: {stage}"
                    )

                current = store.read_json(
                    child / "manifest.json"
                )["stages"][stage]

                if current != "running":
                    raise RuntimeError(
                        f"Unexpected status {current!r} "
                        f"for completed stage {stage}"
                    )

                # These flags come from the actual load node.
                # They must agree with LangGraph's routing state.
                if stage == "load_saved_profiles":
                    individual_enabled = output.get(
                        "run_individual"
                    )
                    inter_table_enabled = output.get(
                        "run_inter_table"
                    )

                    if (
                        type(individual_enabled) is not bool
                        or type(inter_table_enabled) is not bool
                    ):
                        raise RuntimeError(
                            "Graph did not return valid branch settings"
                        )

                if stage == "scoped_metadata":
                    if (
                        type(output.get("cross_table_ready"))
                        is not bool
                    ):
                        raise RuntimeError(
                            "Scoped metadata did not return "
                            "cross_table_ready"
                        )

                # The node has actually finished successfully.
                store.set_stage(
                    child,
                    stage,
                    "completed",
                    _metrics_for_stage(stage, output),
                )

                if stage == "load_saved_profiles":
                    store.set_stage(
                        child,
                        "scoped_metadata",
                        "running",
                    )

                elif stage == "scoped_metadata":
                    # Determine the same branch eligibility used
                    # by the LangGraph conditional router.
                    run_individual = individual_enabled is True
                    run_inter_table = (
                        inter_table_enabled is True
                        and output["cross_table_ready"] is True
                    )

                    if run_individual:
                        store.set_stage(
                            child,
                            "individual_recommendations",
                            "running",
                        )
                    else:
                        _set_skipped(
                            child,
                            "individual_recommendations",
                        )

                    if run_inter_table:
                        store.set_stage(
                            child,
                            "inter_table_consolidation",
                            "running",
                        )
                    else:
                        _set_skipped(
                            child,
                            "inter_table_consolidation",
                        )
                        _set_skipped(
                            child,
                            "inter_table_recommendations",
                        )

                elif stage == "inter_table_consolidation":
                    store.set_stage(
                        child,
                        "inter_table_recommendations",
                        "running",
                    )

        # The graph stream has ended. Check that every stage
        # has reached an appropriate terminal status.
        final_manifest = store.read_json(
            child / "manifest.json"
        )

        unfinished = {
            stage: status
            for stage, status in final_manifest["stages"].items()
            if status not in ("completed", "skipped")
        }

        if unfinished:
            raise RuntimeError(
                "Graph 2 ended with unfinished stages: "
                f"{unfinished}"
            )

        store.update(
            child,
            status="completed",
            error=None,
        )

    except Exception as exc:
        # Multiple parallel branches might be active when an
        # exception occurs. Mark every active stage interrupted.
        failed_manifest = store.read_json(
            child / "manifest.json"
        )

        for stage, status in failed_manifest["stages"].items():
            if status == "running":
                store.set_stage(
                    child,
                    stage,
                    "interrupted",
                )

        store.update(
            child,
            status="failed",
            error=f"{type(exc).__name__}: {exc}",
        )

        raise
