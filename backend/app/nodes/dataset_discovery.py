"""Starting LangGraph node for dataset discovery."""

from app.graph.state import DQState
from app.services.dataset_discovery import discover_dataset


def dataset_discovery_node(state: DQState) -> DQState:
    """Return artifact paths and counts, not full metadata."""
    result = discover_dataset(
        catalog=state["catalog"],
        schema=state["schema"],
        config_dir=state["config_volume_path"],
        artifacts_root=state["artifacts_root"],
    )

    return {
        "discovery_path": result["discovery_path"],
        "matching_results_path": result["matching_results_path"],
        "discovered_table_count": result["table_count"],
        "discovery_column_mismatch_count": result["column_mismatch_count"],
    }