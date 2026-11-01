
"""Independent LangGraph workflow for scoped DQ recommendations.

Graph 2 reuses completed discovery profiles.
It never invokes discovery or statistical/semantic profiling.
"""

from langgraph.graph import StateGraph, START, END

from app.graph.recommendation_state import RecommendationState

from app.nodes.scoped_recommendation_nodes import (
    load_saved_profiles_node,
    prepare_scoped_metadata_node,
    individual_recommendations_node,
    scoped_inter_table_consolidation_node,
    inter_table_recommendations_node,
)


def choose_recommendation_branches(
    state: RecommendationState,
) -> list[str]:
    """Select the applicable recommendation branches."""

    branches = []

    if state.get("run_individual", False):
        branches.append("individual_recommendations")

    if (
        state.get("run_inter_table", False)
        and state.get("cross_table_ready", False)
    ):
        branches.append("inter_table_consolidation")

    # No applicable branch: end after scoped preparation.
    return branches if branches else [END]


def build_recommendation_graph():
    """Compile the independent recommendation workflow."""

    builder = StateGraph(RecommendationState)

    builder.add_node(
        "load_saved_profiles",
        load_saved_profiles_node,
    )

    builder.add_node(
        "scoped_metadata",
        prepare_scoped_metadata_node,
    )

    builder.add_node(
        "individual_recommendations",
        individual_recommendations_node,
    )

    builder.add_node(
        "inter_table_consolidation",
        scoped_inter_table_consolidation_node,
    )

    builder.add_node(
        "inter_table_recommendations",
        inter_table_recommendations_node,
    )

    # Shared initial stages.
    builder.add_edge(
        START,
        "load_saved_profiles",
    )

    builder.add_edge(
        "load_saved_profiles",
        "scoped_metadata",
    )

    # Conditional fan-out into independent branches.
    builder.add_conditional_edges(
        "scoped_metadata",
        choose_recommendation_branches,
        {
            "individual_recommendations": "individual_recommendations",
            "inter_table_consolidation": "inter_table_consolidation",
            END: END,
        },
    )

    # Individual-table branch.
    builder.add_edge(
        "individual_recommendations",
        END,
    )

    # Inter-table branch.
    builder.add_edge(
        "inter_table_consolidation",
        "inter_table_recommendations",
    )

    builder.add_edge(
        "inter_table_recommendations",
        END,
    )

    return builder.compile()


# Compiled independently from Graph 1.
recommendation_graph = build_recommendation_graph()
