export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "archived";
export type StageStatus = "pending" | "running" | "completed" | "interrupted";

export interface Workspace {
  source: string;
  catalog: string | null;
  schema: string | null;
  config_volume_path: string | null;
  model_endpoint: string | null;
  configured: boolean;
  missing_configuration: string[];
}

export interface RunMetrics {
  discovered_table_count?: number;
  discovery_column_mismatch_count?: number;
  profiled_table_count?: number;
  profiled_column_count?: number;
  semantic_table_count?: number;
  semantic_column_count?: number;
  consolidated_profile_count?: number;
  individual_recommendation_table_count?: number;
  individual_recommendation_rule_count?: number;
  inter_table_profile_table_count?: number;
  inter_table_profile_foreign_key_count?: number;
  inter_table_recommendation_rule_count?: number;
}

export interface AnalysisRun {
  run_id: string;
  status: RunStatus;
  created_at: string | null;
  artifact_modified_at?: string | null;
  stages: Record<string, StageStatus>;
  metrics: RunMetrics;
  error: string | null;
}

export interface RunListItem {
  run_id: string;
  status: RunStatus;
  created_at: string | null;
  artifact_modified_at: string | null;
  completed_stages: number | null;
}

export interface RunHistoryResponse {
  runs: RunListItem[];
}

export interface CreatedRun {
  run_id: string;
  status: RunStatus;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

export async function request<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  if (!API_BASE_URL) {
    throw new Error("VITE_API_BASE_URL is not configured.");
  }

  let response: Response;

  try {
    response = await fetch(`${API_BASE_URL.replace(/\/+$/, "")}${path}`, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "Cannot reach FastAPI. Check the backend server and API URL.",
    );
  }

  if (!response.ok) {
    let message = response.statusText || "Request failed";

    try {
      const body = await response.json();

      if (typeof body?.detail === "string") {
        message = body.detail;
      }
    } catch {
      // Use the HTTP status message.
    }

    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

export const runsApi = {
  getWorkspace: (signal?: AbortSignal) =>
    request<Workspace>("/api/v1/workspace", "GET", signal),

  createRun: () => request<CreatedRun>("/api/v1/runs", "POST"),

  getRun: (runId: string, signal?: AbortSignal) =>
    request<AnalysisRun>(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      "GET",
      signal,
    ),

  listRuns: (signal?: AbortSignal) =>
    request<RunHistoryResponse>("/api/v1/runs?limit=20", "GET", signal),
};
