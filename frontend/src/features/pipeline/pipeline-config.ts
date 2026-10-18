import type { RunMetrics, StageStatus } from "@/features/runs/api";

// This topology mirrors backend/app/graph/workflow.py.
// Positions, labels and descriptions describe the workflow, not a dataset.
export type StageId =
  | "dataset_discovery"
  | "statistical_profiling"
  | "semantic_profiling"
  | "table_consolidation"
  | "individual_recommendations"
  | "inter_table_consolidation"
  | "inter_table_recommendations";

export type DisplayStageStatus = StageStatus | "unknown";

export interface StageMetric {
  key: keyof RunMetrics;
  label: string;
}

export interface StageDefinition {
  id: StageId;
  title: string;
  description: string;
  track: "Shared pipeline" | "Individual-table branch" | "Inter-table branch";
  position: { x: number; y: number };
  metrics: StageMetric[];
}

export const PIPELINE_STAGES: StageDefinition[] = [
  {
    id: "dataset_discovery",
    title: "Dataset Discovery",
    description:
      "Discover the configured Databricks tables and compare their columns against the supplied configuration.",
    track: "Shared pipeline",
    position: { x: 282, y: 16 },
    metrics: [
      { key: "discovered_table_count", label: "Discovered tables" },
      { key: "discovery_column_mismatch_count", label: "Column mismatches" },
    ],
  },
  {
    id: "statistical_profiling",
    title: "Statistical Profiling",
    description:
      "Compute column-level statistics and profiling summaries from the discovered tables.",
    track: "Shared pipeline",
    position: { x: 282, y: 150 },
    metrics: [
      { key: "profiled_table_count", label: "Tables profiled" },
      { key: "profiled_column_count", label: "Columns profiled" },
    ],
  },
  {
    id: "semantic_profiling",
    title: "Semantic Profiling",
    description:
      "Infer structured business semantics for tables and columns using the configured language model.",
    track: "Shared pipeline",
    position: { x: 282, y: 284 },
    metrics: [
      { key: "semantic_table_count", label: "Tables profiled" },
      { key: "semantic_column_count", label: "Columns profiled" },
    ],
  },
  {
    id: "table_consolidation",
    title: "Table Consolidation",
    description:
      "Combine available statistical and semantic information into consolidated per-table profiles.",
    track: "Shared pipeline",
    position: { x: 282, y: 418 },
    metrics: [
      { key: "consolidated_profile_count", label: "Consolidated profiles" },
    ],
  },
  {
    id: "individual_recommendations",
    title: "Individual Recommendations",
    description:
      "Generate recommendations for checks within individual tables, including their columns and intra-table relationships.",
    track: "Individual-table branch",
    position: { x: 17, y: 568 },
    metrics: [
      { key: "individual_recommendation_table_count", label: "Tables with recommendations" },
      { key: "individual_recommendation_rule_count", label: "Recommended rules" },
    ],
  },
  {
    id: "inter_table_consolidation",
    title: "Inter-Table Consolidation",
    description:
      "Consolidate relationships and metadata across tables for inter-table rule inference.",
    track: "Inter-table branch",
    position: { x: 547, y: 568 },
    metrics: [
      { key: "inter_table_profile_table_count", label: "Tables considered" },
      { key: "inter_table_profile_foreign_key_count", label: "Foreign keys consolidated" },
    ],
  },
  {
    id: "inter_table_recommendations",
    title: "Inter-Table Recommendations",
    description:
      "Generate cross-table quality recommendations from the consolidated relationships and profiles.",
    track: "Inter-table branch",
    position: { x: 547, y: 702 },
    metrics: [
      { key: "inter_table_recommendation_rule_count", label: "Recommended rules" },
    ],
  },
];

export const PIPELINE_CONNECTIONS: ReadonlyArray<readonly [StageId, StageId]> = [
  ["dataset_discovery", "statistical_profiling"],
  ["statistical_profiling", "semantic_profiling"],
  ["semantic_profiling", "table_consolidation"],
  ["table_consolidation", "individual_recommendations"],
  ["table_consolidation", "inter_table_consolidation"],
  ["inter_table_consolidation", "inter_table_recommendations"],
];

export const STAGE_STATUS_LABELS: Record<DisplayStageStatus, string> = {
  pending: "Pending",
  running: "Active / next",
  completed: "Completed",
  interrupted: "Interrupted",
  unknown: "Unknown",
};
