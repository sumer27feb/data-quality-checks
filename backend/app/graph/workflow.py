"""Data quality rule recommendation workflow.

Run from backend/:
    python -m app.graph.workflow
"""

import json

from langgraph.graph import END, START, StateGraph

from app.config import (
    ARTIFACTS_ROOT,
    DATABRICKS_CATALOG,
    DATABRICKS_SCHEMA,
    DATABRICKS_CONFIG_DIR,
    DATABRICKS_MODEL_ENDPOINT,
)
from app.graph.state import DQState

from app.nodes.dataset_discovery import dataset_discovery_node
from app.nodes.statistical_profiler import statistical_profiler_node
from app.nodes.semantic_profiler import semantic_profiler_node
from app.nodes.consolidated_profiler import consolidated_profiles_node
from app.nodes.inter_table_profiler import inter_table_consolidation_node
from app.nodes.table_llm_recommender import individual_rule_inference_node
from app.nodes.inter_table_llm_recommender import (
    inter_table_llm_recommender_node,
)


def build_graph():
    builder = StateGraph(DQState)

    # Register processing nodes.
    builder.add_node(
        "dataset_discovery",
        dataset_discovery_node,
    )
    builder.add_node(
        "statistical_profiling",
        statistical_profiler_node,
    )
    builder.add_node(
        "semantic_profiling",
        semantic_profiler_node,
    )
    builder.add_node(
        "table_consolidation",
        consolidated_profiles_node,
    )
    builder.add_node(
        "individual_recommendations",
        individual_rule_inference_node,
    )
    builder.add_node(
        "inter_table_consolidation",
        inter_table_consolidation_node,
    )
    builder.add_node(
        "inter_table_recommendations",
        inter_table_llm_recommender_node,
    )

    # Shared profiling pipeline.
    builder.add_edge(START, "dataset_discovery")
    builder.add_edge(
        "dataset_discovery",
        "statistical_profiling",
    )
    builder.add_edge(
        "statistical_profiling",
        "semantic_profiling",
    )
    builder.add_edge(
        "semantic_profiling",
        "table_consolidation",
    )

    # Individual-table recommendation branch.
    builder.add_edge(
        "table_consolidation",
        "individual_recommendations",
    )
    builder.add_edge(
        "individual_recommendations",
        END,
    )

    # Inter-table recommendation branch.
    builder.add_edge(
        "table_consolidation",
        "inter_table_consolidation",
    )
    builder.add_edge(
        "inter_table_consolidation",
        "inter_table_recommendations",
    )
    builder.add_edge(
        "inter_table_recommendations",
        END,
    )

    return builder.compile()


# Compile on import; execute only when explicitly invoked.
graph = build_graph()


def main() -> None:
    initial_state: DQState = {
        "catalog": DATABRICKS_CATALOG,
        "schema": DATABRICKS_SCHEMA,
        "artifacts_root": ARTIFACTS_ROOT,
        "config_volume_path": DATABRICKS_CONFIG_DIR,
        "llm_model": DATABRICKS_MODEL_ENDPOINT,
    }

    required_keys = (
        "catalog",
        "schema",
        "artifacts_root",
        "config_volume_path",
        "llm_model",
    )
    missing = [
        key for key in required_keys
        if not initial_state.get(key)
    ]
    if missing:
        raise ValueError(
            f"Missing workflow configuration: {', '.join(missing)}"
        )

    result = graph.invoke(initial_state)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()