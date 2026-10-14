"""LangGraph wrapper for consolidated YAML profile generation."""

from app.graph.state import DQState
from app.services.consolidated_profiler import generate_consolidated_profiles


def consolidated_profiles_node(state: DQState) -> DQState:
    """Return the consolidated profiles directory and table count."""
    result = generate_consolidated_profiles(
        artifacts_root=state["artifacts_root"],
    )

    return {
        "consolidated_profiles_dir": str(result.output_dir),
        "consolidated_profile_count": result.table_count,
    }