"""LangGraph node for inter-table LLM rule recommendations."""

from app.graph.state import DQState
from app.services.inter_table_llm_recommender_service import (
    generate_inter_table_rule_recommendations,
)


def inter_table_llm_recommender_node(state: DQState) -> DQState:
    """Return the recommendations path and rule count."""
    result = generate_inter_table_rule_recommendations(
        artifacts_root=state["artifacts_root"],
        model=state["llm_model"],
    )

    return {
        "inter_table_recommendations_path": str(result.output_path),
        "inter_table_recommendation_rule_count": result.rule_count,
    }