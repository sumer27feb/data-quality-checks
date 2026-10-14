"""LangGraph wrapper for per-table LLM recommendation generation."""

from app.graph.state import DQState
from app.services.table_llm_recommender_service import (
    generate_individual_rule_recommendations,
)


def individual_rule_inference_node(state: DQState) -> DQState:
    """Return the recommendations directory and counts."""
    result = generate_individual_rule_recommendations(
        artifacts_root=state["artifacts_root"],
        model=state["llm_model"],
    )

    return {
        "individual_recommendations_dir": str(result.output_dir),
        "individual_recommendation_table_count": result.table_count,
        "individual_recommendation_rule_count": result.rule_count,
    }