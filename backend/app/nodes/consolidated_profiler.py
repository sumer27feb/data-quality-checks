"""LangGraph wrapper for consolidated YAML profile generation."""

from __future__ import annotations

from typing import Any

from services.consolidated_profiler import generate_consolidated_profiles


def consolidated_profiles_node(state: dict[str, Any]) -> dict[str, Any]:
    """State must supply artifacts_root, e.g. 'artifacts/workspace.data_quality_rules'.

    Add the returned keys to your existing LangGraph state schema.
    """
    artifacts_root = state.get("artifacts_root")
    if not artifacts_root:
        raise ValueError("LangGraph state is missing required key 'artifacts_root'")

    result = generate_consolidated_profiles(artifacts_root)
    return {
        "consolidated_profiles_dir": str(result.output_dir),
        "consolidated_profile_count": result.table_count,
    }
