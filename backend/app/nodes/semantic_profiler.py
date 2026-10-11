"""LangGraph wrapper: carry artifact locations, never profile JSON contents."""

from typing import Any

from app.services.semantic_profiler import profile_semantics


def semantic_profiler_node(state: dict[str, Any]) -> dict[str, Any]:
    result = profile_semantics(artifacts_root=state.get("artifacts_root"))
    return {
        "semantic_profiles_path": result["semantic_profiles_path"],
        "semantic_table_count": result["table_count"],
        "semantic_column_count": result["column_count"],
    }
