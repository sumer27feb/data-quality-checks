"""LangGraph node wrapping the read-only statistical profiling service."""

from app.graph.state import DQState
from app.services.statistical_profiler import profile_dataset


def statistical_profiler_node(state: DQState) -> DQState:
    """Use a small graph state: pass artifact paths rather than JSON contents."""
    result = profile_dataset(
        catalog=state["catalog"],
        schema=state["schema"],
        artifacts_root=state["artifacts_root"],
    )
    return {
        "statistical_profiles_path": result["statistical_profiles_path"],
        "profiled_table_count": result["table_count"],
        "profiled_column_count": result["column_count"],
        "profiling_status_counts": result["status_counts"],
    }
