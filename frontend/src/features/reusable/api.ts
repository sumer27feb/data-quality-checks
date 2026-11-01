const base = import.meta.env.VITE_API_BASE_URL as string | undefined;

async function call<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  if (!base) throw new Error("VITE_API_BASE_URL is not configured");
  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method,
    headers: { Accept: "application/json", ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message = body && typeof body === "object" && "detail" in body
      ? JSON.stringify((body as { detail: unknown }).detail)
      : response.statusText;
    throw new Error(`${response.status}: ${message}`);
  }
  return response.json() as Promise<T>;
}

export type DQStatus = "queued" | "running" | "completed" | "failed";
export interface Discovery {
  discovery_id: string;
  name: string;
  status: DQStatus;
  created_at: string;
  error: string | null;
  catalog: string;
  schema: string;
  stages: Record<string, string>;
  metrics: Record<string, number>;
}
export interface Recommendation {
  discovery_id: string;
  recommendation_id: string;
  name: string;
  status: DQStatus;
  created_at: string;
  error: string | null;
  stages: Record<string, string>;
  metrics: Record<string, number>;
  config?: { selections: Record<string, string[]>; branches: { individual: boolean; inter_table: boolean } };
}
export interface DiscoveryTable { table_name: string; columns: string[] }
export interface LLMRule {
  rule: string;
  description: string;
  validation_sql: string | null;
  sql_generation_note: string | null;
  proposed_relation: string | null;
  impact: { level: "low" | "medium" | "high"; reason: string };
}
export interface TraditionalRule extends LLMRule {
  id: string; table_name: string; column_name: string; check_type: string;
}
export interface CustomRule {
  id: string; source: "user"; name: string; description: string;
  scope: "individual" | "inter_table"; tables: string[]; columns: Record<string, string[]>;
  impact_level: "low" | "medium" | "high"; validation_sql: string;
  sql_result_mode: "violation_rows" | "violation_count";
}
export interface ScopedRecommendations {
  discovery_id: string; recommendation_id: string; status: DQStatus;
  individual_rules: Record<string, LLMRule[]>;
  inter_table_rules: LLMRule[];
  traditional_rules: TraditionalRule[];
  custom_rules: CustomRule[];
}
const p = (d: string) => `/api/v1/discovery-runs/${encodeURIComponent(d)}`;
const c = (d: string, r: string) => `${p(d)}/recommendation-runs/${encodeURIComponent(r)}`;

export const reusableApi = {
  listDiscoveries: () => call<{ discovery_runs: Discovery[] }>("/api/v1/discovery-runs"),
  createDiscovery: () => call<Discovery>("/api/v1/discovery-runs", "POST"),
  getDiscovery: (d: string) => call<Discovery>(p(d)),
  tables: (d: string) => call<{ tables: DiscoveryTable[] }>(`${p(d)}/tables`),
  listRecommendations: (d: string) => call<{ recommendation_runs: Recommendation[] }>(`${p(d)}/recommendation-runs`),
  createRecommendation: (d: string, input: { name: string; selections: Record<string, string[]>; business_context: string; individual: boolean; inter_table: boolean }) => call<Recommendation>(`${p(d)}/recommendation-runs`, "POST", input),
  getRecommendation: (d: string, r: string) => call<Recommendation>(c(d, r)),
  recommendations: (d: string, r: string) => call<ScopedRecommendations>(`${c(d, r)}/recommendations`),
  getTraditional: (d: string, r: string) => call<{ selections: TraditionalSelection[]; rules: TraditionalRule[] }>(`${c(d, r)}/traditional-checks`),
  saveTraditional: (d: string, r: string, selections: TraditionalSelection[]) => call<{ selections: TraditionalSelection[]; rules: TraditionalRule[] }>(`${c(d, r)}/traditional-checks`, "POST", { selections }),
  createCustom: (d: string, r: string, rule: Omit<CustomRule, "id" | "source">) => call<CustomRule>(`${c(d, r)}/custom-rules`, "POST", rule),
  updateCustom: (d: string, r: string, id: string, rule: Omit<CustomRule, "id" | "source">) => call<CustomRule>(`${c(d, r)}/custom-rules/${encodeURIComponent(id)}`, "PUT", rule),
  deleteCustom: (d: string, r: string, id: string) => call<{ deleted: boolean }>(`${c(d, r)}/custom-rules/${encodeURIComponent(id)}`, "DELETE"),
  getReview: (d: string, r: string) => call<{ rules: { id: string; reviewed_sql: string | null }[] }>(`${c(d, r)}/review`),
  saveReview: (d: string, r: string, rules: { id: string; reviewed_sql: string | null }[]) => call<{ rules: { id: string; reviewed_sql: string | null }[] }>(`${c(d, r)}/review`, "PUT", { rules }),
};
export interface TraditionalSelection {
  table: string; column: string;
  check: "not_null" | "unique" | "not_blank" | "trimmed" | "non_negative" | "positive";
  params: Record<string, unknown>; impact_level: "low" | "medium" | "high";
}
