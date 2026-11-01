
"""LangGraph state for scoped DQ rule recommendation runs."""

from typing import TypedDict


class RecommendationState(TypedDict, total=False):
    # Run identity and storage
    discovery_id: str
    recommendation_id: str
    parent_artifacts_root: str
    artifacts_root: str

    # Execution configuration
    llm_model: str
    selections: dict[str, list[str]]
    business_context: str
    run_individual: bool
    run_inter_table: bool

    # Scoped input preparation
    scoped_profiles_dir: str
    selected_table_count: int
    selected_column_count: int
    supporting_join_columns: dict[str, list[str]]
    included_relationship_count: int
    cross_table_ready: bool

    # Inter-table consolidation
    inter_table_profile_path: str
    inter_table_profile_table_count: int
    inter_table_profile_foreign_key_count: int

    # Individual-table recommendations
    individual_recommendations_dir: str
    individual_recommendation_table_count: int
    individual_recommendation_rule_count: int

    # Inter-table recommendations
    inter_table_recommendations_path: str
    inter_table_recommendation_rule_count: int
