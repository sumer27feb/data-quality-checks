"""Thin LangGraph wrapper for per-table LLM recommendation generation."""

from __future__ import annotations

from typing import Any

from services.table_llm_recommender_service import generate_individual_rule_recommendations


def individual_rule_inference_node(state: dict[str, Any]) -> dict[str, Any]:
    """Requires artifacts_root; optional llm_model from state.

    Declare returned keys in the graph's TypedDict / state schema. This node
    runs all individual table YAMLs; standalone service supports --table for
    debugging a single table.
    """
    artifacts_root = state.get("artifacts_root")
    if not artifacts_root:
        raise ValueError("LangGraph state is missing required key 'artifacts_root'")

    result = generate_individual_rule_recommendations(
        artifacts_root,
        model=state.get("llm_model"),
    )
    return {
        "individual_recommendations_dir": str(result.output_dir),
        "individual_recommendation_table_count": result.table_count,
        "individual_recommendation_rule_count": result.rule_count,
    }
