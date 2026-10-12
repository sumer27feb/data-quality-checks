"""LangGraph wrapper for inter-table consolidated YAML creation."""

from __future__ import annotations

from typing import Any

from services.inter_table_profiler import generate_inter_table_profile


def inter_table_consolidation_node(state: dict[str, Any]) -> dict[str, Any]:
    """Uses state['artifacts_root']; optional state['relationships_json_path'].

    Add the keys returned below to the graph state schema if using TypedDict.
    Run after the existing per-table consolidated profiles node.
    """
    artifacts_root = state.get("artifacts_root")
    if not artifacts_root:
        raise ValueError("LangGraph state is missing required key 'artifacts_root'")

    result = generate_inter_table_profile(
        artifacts_root,
        relationships_json_path=state.get("relationships_json_path"),
    )
    return {
        "inter_table_profile_path": str(result.output_path),
        "inter_table_profile_table_count": result.table_count,
        "inter_table_profile_foreign_key_count": result.foreign_key_count,
    }
