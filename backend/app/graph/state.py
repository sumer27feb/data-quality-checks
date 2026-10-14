"""Shared state for the data quality recommendation graph."""

from typing import TypedDict


class DQState(TypedDict, total=False):
    # Initial workflow configuration
    catalog: str
    schema: str
    artifacts_root: str
    config_volume_path: str
    llm_model: str

    # Optional override for the relationships file
    relationships_json_path: str

    # Dataset discovery
    discovery_path: str
    matching_results_path: str
    discovered_table_count: int
    discovery_column_mismatch_count: int

    # Statistical profiling
    statistical_profiles_path: str
    profiled_table_count: int
    profiled_column_count: int
    profiling_status_counts: dict[str, int]

    # Semantic profiling
    semantic_profiles_path: str
    semantic_table_count: int
    semantic_column_count: int

    # Individual-table consolidation
    consolidated_profiles_dir: str
    consolidated_profile_count: int

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