"""LangGraph wrapper for semantic profiling."""

from app.graph.state import DQState
from app.services.semantic_profiler import profile_semantics


def semantic_profiler_node(state: DQState) -> DQState:
    """Return artifact paths and counts, not profile contents."""
    result = profile_semantics(
        artifacts_root=state["artifacts_root"],
        model=state["llm_model"],
    )

    return {
        "semantic_profiles_path": result["semantic_profiles_path"],
        "semantic_table_count": result["table_count"],
        "semantic_column_count": result["column_count"],
    }
