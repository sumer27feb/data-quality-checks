"""LangGraph node for inter-table LLM rule recommendations."""

from __future__ import annotations

from typing import Any

from app.services.inter_table_llm_recommender_service import (
    generate_inter_table_rule_recommendations,
)


def inter_table_llm_recommender_node(state: dict[str, Any]) -> dict[str, Any]:
    """Read state['artifacts_root']; optionally state['llm_model'].

    Declare the two returned keys in your existing LangGraph state type.
    Run this node after inter_table_consolidated.yaml is generated.
    """
    artifacts_root = state.get("artifacts_root")
    if not artifacts_root:
        raise ValueError("LangGraph state is missing required key 'artifacts_root'")

    result = generate_inter_table_rule_recommendations(
        artifacts_root,
        model=state.get("llm_model"),
    )
    return {
        "inter_table_recommendations_path": str(result.output_path),
        "inter_table_recommendation_rule_count": result.rule_count,
    }
