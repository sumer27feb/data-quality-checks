import { request } from "@/features/runs/api";

export type ImpactLevel = "high" | "medium" | "low";
export type RuleScope = "individual" | "inter_table" | "traditional";

export interface RecommendedRule {
  rule: string;
  validation_sql: string | null;
  sql_generation_note: string | null;
  description: string;
  proposed_relation: string | null;
  impact: {
    level: ImpactLevel;
    reason: string;
  };
}

export type TraditionalCheckType =
  | "not_null" | "unique" | "not_blank" | "trimmed" | "non_negative"
  | "positive" | "range" | "length" | "allowed_values";

export interface TraditionalSelection {
  table: string;
  column: string;
  check: TraditionalCheckType;
  params: Record<string, unknown>;
  impact_level: ImpactLevel;
}

export interface TraditionalRule extends RecommendedRule {
  id: string;
  table_name: string;
  column_name: string;
  check_type: TraditionalCheckType;
  params: Record<string, unknown>;
}

export interface TraditionalChecksResponse {
  version: number;
  run_id: string;
  sql_result_mode: "violation_rows";
  sql_validation_performed: false;
  selections: TraditionalSelection[];
  rules: TraditionalRule[];
}

export const traditionalChecksApi = {
  get: (runId: string, signal?: AbortSignal) =>
    request<TraditionalChecksResponse>(`/api/v1/runs/${encodeURIComponent(runId)}/traditional-checks`, "GET", signal),
  save: (runId: string, selections: TraditionalSelection[]) =>
    request<TraditionalChecksResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}/traditional-checks`,
      "POST", undefined, { selections },
    ),
};

export interface RecommendationsResponse {
  run_id: string;
  status: "queued" | "running" | "completed" | "failed" | "archived";
  available: {
    individual: boolean;
    inter_table: boolean;
    traditional?: boolean;
  };
  individual_rules: Record<string, RecommendedRule[]>;
  inter_table_rules: RecommendedRule[];
  traditional_rules?: Record<string, TraditionalRule[]>;
}

export interface ReviewRule extends RecommendedRule {
  id: string;
  scope: RuleScope;
  table_name: string | null;
  position: number;
  column_name?: string | null;
  check_type?: TraditionalCheckType | null;
  sql_result_mode?: "violation_rows" | "violation_count";
}

export const recommendationsApi = {
  get: (runId: string, signal?: AbortSignal) =>
    request<RecommendationsResponse>(
      `/api/v1/runs/${encodeURIComponent(runId)}/recommendations`,
      "GET",
      signal,
    ),
};

// A fingerprint of the source, position AND predicate means a rule cannot
// silently inherit another rule's selection after an artifact is rewritten.
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function normalizeRecommendations(
  payload: RecommendationsResponse,
): ReviewRule[] {
  const rules: ReviewRule[] = [];

  for (const [table, recommendations] of Object.entries(
    payload.individual_rules ?? {},
  )) {
    recommendations.forEach((recommendation, index) => {
      rules.push({
        ...recommendation,
        validation_sql: recommendation.validation_sql ?? null,
        sql_generation_note: recommendation.sql_generation_note ?? null,
        id: `individual:${table}:${index + 1}:${fingerprint(recommendation.rule)}`,
        scope: "individual",
        table_name: table,
        position: index + 1,
      });
    });
  }

  (payload.inter_table_rules ?? []).forEach((recommendation, index) => {
    rules.push({
      ...recommendation,
      validation_sql: recommendation.validation_sql ?? null,
      sql_generation_note: recommendation.sql_generation_note ?? null,
      id: `inter_table:${index + 1}:${fingerprint(recommendation.rule)}`,
      scope: "inter_table",
      table_name: null,
      position: index + 1,
    });
  });

  for (const [table, recommendations] of Object.entries(payload.traditional_rules ?? {})) {
    recommendations.forEach((recommendation, index) => {
      rules.push({
        ...recommendation,
        id: recommendation.id,
        validation_sql: recommendation.validation_sql ?? null,
        sql_generation_note: recommendation.sql_generation_note ?? null,
        scope: "traditional",
        table_name: table,
        column_name: recommendation.column_name,
        check_type: recommendation.check_type,
        sql_result_mode: "violation_rows",
        position: index + 1,
      });
    });
  }
  return rules;
}
