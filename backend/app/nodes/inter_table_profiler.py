"""LangGraph wrapper for inter-table consolidated YAML creation."""

from app.graph.state import DQState
from app.services.inter_table_profiler import generate_inter_table_profile


def inter_table_consolidation_node(state: DQState) -> DQState:
    """Return the profile path and counts, not profile contents."""
    result = generate_inter_table_profile(
        artifacts_root=state["artifacts_root"],
        relationships_json_path=state.get("relationships_json_path"),
    )

    return {
        "inter_table_profile_path": str(result.output_path),
        "inter_table_profile_table_count": result.table_count,
        "inter_table_profile_foreign_key_count": result.foreign_key_count,
    }