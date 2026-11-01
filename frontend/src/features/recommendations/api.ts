import { request } from "@/features/runs/api";
import type {
  CustomRule,
  ScopedRecommendations,
} from "@/features/reusable/api";

export type ImpactLevel = "high" | "medium" | "low";

export type RuleScope = "individual" | "inter_table" | "traditional" | "custom";

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
  | "not_null"
  | "unique"
  | "not_blank"
  | "trimmed"
  | "non_negative"
  | "positive"
  | "range"
  | "length"
  | "allowed_values";

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
  custom_rules?: CustomRule[];
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

export interface ReviewedRuleSelection {
  id: string;
  reviewed_sql: string | null;
}

export interface SavedReview {
  rules: ReviewedRuleSelection[];
  updated_at?: string;
}

// -----------------------------------------------------
// Run identity
// -----------------------------------------------------

export function scopedRunReference(
  runId: string | null,
): { discoveryId: string; recommendationId: string } | null {
  if (!runId) return null;

  const parts = runId.split("::");

  if (parts.length !== 2 || !parts[0].startsWith("discovery_") || !parts[1]) {
    return null;
  }

  return {
    discoveryId: parts[0],
    recommendationId: parts[1],
  };
}

function scopedPath(discoveryId: string, recommendationId: string): string {
  return (
    `/api/v1/discovery-runs/${encodeURIComponent(discoveryId)}` +
    `/recommendation-runs/${encodeURIComponent(recommendationId)}`
  );
}

// -----------------------------------------------------
// Traditional checks
// -----------------------------------------------------

function normalizeTraditional(
  runId: string,
  payload: Partial<TraditionalChecksResponse>,
): TraditionalChecksResponse {
  return {
    version: payload.version ?? 1,
    run_id: runId,
    sql_result_mode: "violation_rows",
    sql_validation_performed: false,
    selections: payload.selections ?? [],
    rules: payload.rules ?? [],
  };
}

export const traditionalChecksApi = {
  get: async (
    runId: string,
    signal?: AbortSignal,
  ): Promise<TraditionalChecksResponse> => {
    const ref = scopedRunReference(runId);

    const path = ref
      ? `${scopedPath(ref.discoveryId, ref.recommendationId)}/traditional-checks`
      : `/api/v1/runs/${encodeURIComponent(runId)}/traditional-checks`;

    const result = await request<TraditionalChecksResponse>(
      path,
      "GET",
      signal,
    );

    return normalizeTraditional(runId, result);
  },

  save: async (
    runId: string,
    selections: TraditionalSelection[],
  ): Promise<TraditionalChecksResponse> => {
    const ref = scopedRunReference(runId);

    const path = ref
      ? `${scopedPath(ref.discoveryId, ref.recommendationId)}/traditional-checks`
      : `/api/v1/runs/${encodeURIComponent(runId)}/traditional-checks`;

    const result = await request<TraditionalChecksResponse>(
      path,
      "POST",
      undefined,
      { selections },
    );

    return normalizeTraditional(runId, result);
  },
};

// -----------------------------------------------------
// Recommendation retrieval
// -----------------------------------------------------

export const recommendationsApi = {
  get: async (
    runId: string,
    signal?: AbortSignal,
  ): Promise<RecommendationsResponse> => {
    const ref = scopedRunReference(runId);

    if (!ref) {
      // Original seven-stage workflow remains readable.
      return request<RecommendationsResponse>(
        `/api/v1/runs/${encodeURIComponent(runId)}/recommendations`,
        "GET",
        signal,
      );
    }

    const path = scopedPath(ref.discoveryId, ref.recommendationId);

    const [payload, manifest] = await Promise.all([
      request<ScopedRecommendations>(`${path}/recommendations`, "GET", signal),
      request<{ stages: Record<string, string> }>(path, "GET", signal),
    ]);

    const traditional: Record<string, TraditionalRule[]> = {};

    for (const rule of payload.traditional_rules ?? []) {
      (traditional[rule.table_name] ??= []).push(rule as TraditionalRule);
    }

    return {
      run_id: runId,
      status: payload.status,
      available: {
        individual: manifest.stages.individual_recommendations === "completed",
        inter_table:
          manifest.stages.inter_table_recommendations === "completed",
        traditional: (payload.traditional_rules?.length ?? 0) > 0,
      },
      individual_rules: payload.individual_rules ?? {},
      inter_table_rules: payload.inter_table_rules ?? [],
      traditional_rules: traditional,
      custom_rules: payload.custom_rules ?? [],
    };
  },
};

export const reviewApi = {
  get: (runId: string, signal?: AbortSignal): Promise<SavedReview> => {
    const ref = scopedRunReference(runId);
    if (!ref) throw new Error("Server reviews require a recommendation run");

    return request<SavedReview>(
      `${scopedPath(ref.discoveryId, ref.recommendationId)}/review`,
      "GET",
      signal,
    );
  },

  save: (
    runId: string,
    rules: ReviewedRuleSelection[],
  ): Promise<SavedReview> => {
    const ref = scopedRunReference(runId);
    if (!ref) throw new Error("Server reviews require a recommendation run");

    return request<SavedReview>(
      `${scopedPath(ref.discoveryId, ref.recommendationId)}/review`,
      "PUT",
      undefined,
      { rules },
    );
  },
};

// -----------------------------------------------------
// Rule identity and normalization
// -----------------------------------------------------

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

  for (const [table, recommendations] of Object.entries(
    payload.traditional_rules ?? {},
  )) {
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

  (payload.custom_rules ?? []).forEach((custom, index) => {
    rules.push({
      id: custom.id,
      scope: "custom",
      table_name: custom.tables.length === 1 ? custom.tables[0] : null,
      position: index + 1,
      rule: custom.name,
      description: custom.description,
      validation_sql: custom.validation_sql,
      sql_generation_note: "User-authored SQL. Not executed or validated.",
      proposed_relation: "user_defined",
      sql_result_mode: custom.sql_result_mode,
      impact: {
        level: custom.impact_level,
        reason: "Impact selected by the user",
      },
    });
  });

  return rules;
}
