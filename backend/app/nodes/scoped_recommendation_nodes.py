
"""LangGraph nodes for scoped DQ rule recommendations.

These nodes read an existing discovery run and write outputs
only into the selected recommendation run.
"""

from pathlib import Path

from app.graph.recommendation_state import RecommendationState

from app.services import reusable_run_store as store
from app.services.scoped_recommendation_inputs import (
    prepare_scoped_inputs,
    consolidate_scoped_inter_table,
)
from app.services.table_llm_recommender_service import (
    generate_individual_rule_recommendations,
)
from app.services.inter_table_llm_recommender_service import (
    generate_inter_table_rule_recommendations,
)


def load_saved_profiles_node(
    state: RecommendationState,
) -> dict:
    """Resolve a completed parent discovery and child run config."""

    discovery_id = state["discovery_id"]
    recommendation_id = state["recommendation_id"]

    parent = store.discovery_path(discovery_id)
    child = store.recommendation_path(
        discovery_id, recommendation_id
    )

    parent_manifest = store.read_json(
        parent / "manifest.json"
    )

    if parent_manifest["status"] != "completed":
        raise ValueError(
            "The selected discovery run is not completed"
        )

    config = store.read_json(
        child / "run_config.json"
    )

    if (
        config.get("discovery_id") != discovery_id
        or config.get("recommendation_id") != recommendation_id
    ):
        raise ValueError(
            "Recommendation configuration does not match run IDs"
        )

    selections = config["selections"]
    branches = config["branches"]

    if not isinstance(branches, dict):
        raise ValueError("Invalid recommendation branch settings")

    individual = branches.get("individual")
    inter_table = branches.get("inter_table")

    if type(individual) is not bool or type(inter_table) is not bool:
        raise ValueError("Branch settings must be boolean")

    if not individual and not inter_table:
        raise ValueError(
            "At least one recommendation branch must be enabled"
        )

    # Optional user-provided business context.
    context = ""
    context_file = config.get("business_context_file")

    if context_file is not None:
        if context_file != "business_context.txt":
            raise ValueError("Invalid business context filename")

        context = (
            child / context_file
        ).read_text(encoding="utf-8")

    return {
        "parent_artifacts_root": str(parent),
        "artifacts_root": str(child),
        "selections": selections,
        "business_context": context,
        "run_individual": individual,
        "run_inter_table": inter_table,
    }


def prepare_scoped_metadata_node(
    state: RecommendationState,
) -> dict:
    """Prepare individual profiles without inter-table consolidation."""

    parent = Path(state["parent_artifacts_root"])
    child = Path(state["artifacts_root"])

    result = prepare_scoped_inputs(
        parent=parent,
        child=child,
        selections=state["selections"],
    )

    return {
        "scoped_profiles_dir": str(
            child / "consolidated_profiles"
        ),
        "selected_table_count": len(result["tables"]),
        "selected_column_count": result["target_column_count"],
        "supporting_join_columns": result["supporting_join_columns"],
        "included_relationship_count": result["included_relationship_count"],
        "cross_table_ready": result["cross_table_ready"],
    }


def individual_recommendations_node(
    state: RecommendationState,
) -> dict:
    """Generate individual-table rules from the scoped YAMLs."""

    result = generate_individual_rule_recommendations(
        artifacts_root=state["artifacts_root"],
        model=state["llm_model"],
        business_context=state.get("business_context", ""),
    )

    return {
        "individual_recommendations_dir": str(result.output_dir),
        "individual_recommendation_table_count": result.table_count,
        "individual_recommendation_rule_count": result.rule_count,
    }


def scoped_inter_table_consolidation_node(
    state: RecommendationState,
) -> dict:
    """Build the selected cross-table profile as its own graph stage."""

    result = consolidate_scoped_inter_table(
        parent=Path(state["parent_artifacts_root"]),
        child=Path(state["artifacts_root"]),
    )

    if result is None:
        raise RuntimeError(
            "Inter-table consolidation was requested "
            "without eligible relationships"
        )

    return result


def inter_table_recommendations_node(
    state: RecommendationState,
) -> dict:
    """Generate cross-table DQ recommendations."""

    result = generate_inter_table_rule_recommendations(
        artifacts_root=state["artifacts_root"],
        model=state["llm_model"],
        business_context=state.get("business_context", ""),
    )

    return {
        "inter_table_recommendations_path": str(
            result.output_path
        ),
        "inter_table_recommendation_rule_count": result.rule_count,
    }
