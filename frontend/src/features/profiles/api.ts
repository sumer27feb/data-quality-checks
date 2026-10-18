import { request } from "@/features/runs/api";

export interface ProfileSources {
  discovery: boolean;
  config: boolean;
  statistical: boolean;
  semantic: boolean;
  consolidated: boolean;
}
export interface TableEntry {
  table_name: string;
  available: ProfileSources;
}
export interface ProfilesIndex {
  run_id: string;
  tables: TableEntry[];
  matching_summary: Record<string, number> | null;
}
export interface DiscoveredColumn {
  name: string;
  ordinal_position: number;
}
export interface DiscoveryArtifact {
  catalog: string;
  schema: string;
  table_name: string;
  full_name: string;
  columns: DiscoveredColumn[];
}
export interface ConfigColumn {
  name: string;
  datatype: string | null;
  nullable: boolean | null;
}
export interface TableConfig {
  table_name: string;
  expected_row_count: number | null;
  primary_key: string[] | null;
  columns: ConfigColumn[];
}
export interface ColumnMismatch {
  table: string;
  column: string;
  issue: string;
}
export type StatValue = string | number | boolean | null | Array<{value: string | number | boolean | null; count: number}>;
export interface StatisticalColumn {
  column_name: string;
  expected_type: string;
  physical_type: string;
  profiling_status: string;
  null_count: number | null;
  valid_count: number | null;
  invalid_count: number | null;
  conversion_success_rate: number | null;
  statistics: Record<string, StatValue>;
}
export interface StatisticalProfile {
  table_name: string;
  row_count: number;
  column_count: number;
  columns: Record<string, StatisticalColumn>;
}
export interface SemanticColumn {
  column_name: string;
  description: string;
  semantic_role: string;
  semantic_type: string;
  entity: string;
  confidence: string;
}
export interface SemanticProfile {
  table_name: string;
  table_semantics: {
    description: string;
    business_entity: string;
    row_grain: string;
  };
  columns: Record<string, SemanticColumn>;
}
export interface TableProfile {
  run_id: string;
  table_name: string;
  available: ProfileSources;
  discovery: DiscoveryArtifact | null;
  config: TableConfig | null;
  column_mismatches: ColumnMismatch[];
  statistical: StatisticalProfile | null;
  semantic: SemanticProfile | null;
  consolidated_yaml: string | null;
}
export interface ForeignKey {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  cardinality?: string;
}
export interface RelationshipsResponse {
  run_id: string;
  foreign_keys: ForeignKey[];
  configuration_available: boolean;
  inter_table_yaml: string | null;
}

export const profilesApi = {
  list: (runId: string, signal?: AbortSignal) =>
    request<ProfilesIndex>(
      `/api/v1/runs/${encodeURIComponent(runId)}/profiles`,
      "GET",
      signal,
    ),
  getTable: (runId: string, table: string, signal?: AbortSignal) =>
    request<TableProfile>(
      `/api/v1/runs/${encodeURIComponent(runId)}/profiles/${encodeURIComponent(table)}`,
      "GET",
      signal,
    ),
  getRelationships: (runId: string, signal?: AbortSignal) =>
    request<RelationshipsResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}/relationships`,
      "GET",
      signal,
    ),
};
