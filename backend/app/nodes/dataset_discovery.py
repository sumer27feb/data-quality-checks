"""LangGraph node. Add it to a StateGraph when building workflow.py."""

from typing import Any

from app.services.dataset_discovery import discover_dataset


def dataset_discovery_node(state: dict[str, Any]) -> dict[str, Any]:
    """Return only artifact paths and status, not the full discovered metadata."""
    result = discover_dataset(
        catalog=state.get("catalog", "workspace"),
        schema=state.get("schema", "data_quality_rules"),
        config_dir=state.get(
            "config_volume_path",
            "/Volumes/workspace/data_quality_rules/dataset/config/",
        ),
        artifacts_root=state.get("artifacts_root"),
    )
    return {
        "discovery_path": result["discovery_path"],
        "matching_results_path": result["matching_results_path"],
        "discovered_table_count": result["table_count"],
        "discovery_column_mismatch_count": result["column_mismatch_count"],
    }
