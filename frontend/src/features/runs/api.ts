export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "archived";

export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "interrupted";

export type RunKind = "discovery" | "recommendation" | "legacy";

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
  selected_table_count?: number;
  selected_column_count?: number;
  included_relationship_count?: number;
}

export interface AnalysisRun {
  run_id: string;
  status: RunStatus;
  created_at: string | null;
  artifact_modified_at?: string | null;
  stages: Record<string, StageStatus>;
  metrics: RunMetrics;
  error: string | null;
  kind?: RunKind;
}

export interface RunListItem {
  run_id: string;
  status: RunStatus;
  created_at: string | null;
  artifact_modified_at: string | null;
  completed_stages: number | null;
  kind?: RunKind;
  name?: string;
  parent_discovery_id?: string;
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
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
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

interface WorkflowManifest {
  status: "queued" | "running" | "completed" | "failed";
  created_at: string;
  stages: Record<string, StageStatus>;
  metrics: RunMetrics;
  error: string | null;
}

function asAnalysisRun(
  runId: string,
  kind: "discovery" | "recommendation",
  manifest: WorkflowManifest,
): AnalysisRun {
  return {
    run_id: runId,
    kind,
    status: manifest.status,
    created_at: manifest.created_at,
    artifact_modified_at: null,
    stages: manifest.stages,
    metrics: manifest.metrics ?? {},
    error: manifest.error,
  };
}

function recommendationReference(
  runId: string,
): { discoveryId: string; recommendationId: string } | null {
  const parts = runId.split("::");

  if (parts.length !== 2 || !parts[0].startsWith("discovery_")) {
    return null;
  }

  if (!parts[1]) return null;

  return {
    discoveryId: parts[0],
    recommendationId: parts[1],
  };
}

export const runsApi = {
  getWorkspace: (signal?: AbortSignal) =>
    request<Workspace>("/api/v1/workspace", "GET", signal),

  // Overview now creates a reusable discovery run (Graph 1).
  createRun: async (): Promise<CreatedRun> => {
    const created = await request<{
      discovery_id: string;
      status: RunStatus;
    }>("/api/v1/discovery-runs", "POST");

    return {
      run_id: created.discovery_id,
      status: created.status,
    };
  },

  getRun: async (runId: string, signal?: AbortSignal): Promise<AnalysisRun> => {
    const recommendation = recommendationReference(runId);

    if (recommendation) {
      const { discoveryId, recommendationId } = recommendation;

      const manifest = await request<WorkflowManifest>(
        `/api/v1/discovery-runs/${encodeURIComponent(discoveryId)}` +
          `/recommendation-runs/${encodeURIComponent(recommendationId)}`,
        "GET",
        signal,
      );

      return asAnalysisRun(runId, "recommendation", manifest);
    }

    if (runId.startsWith("discovery_")) {
      const manifest = await request<WorkflowManifest>(
        `/api/v1/discovery-runs/${encodeURIComponent(runId)}`,
        "GET",
        signal,
      );

      return asAnalysisRun(runId, "discovery", manifest);
    }

    // Historical UUID-based runs remain readable.
    const legacy = await request<AnalysisRun>(
      `/api/v1/runs/${encodeURIComponent(runId)}`,
      "GET",
      signal,
    );

    return { ...legacy, kind: "legacy" };
  },

  listRuns: async (signal?: AbortSignal): Promise<RunHistoryResponse> => {
    const [workflowHistory, legacyHistory] = await Promise.all([
      request<RunHistoryResponse>(
        "/api/v1/discovery-runs/history/all",
        "GET",
        signal,
      ),
      request<RunHistoryResponse>("/api/v1/runs?limit=20", "GET", signal),
    ]);

    const runs = [
      ...workflowHistory.runs,
      ...legacyHistory.runs.map((run) => ({
        ...run,
        kind: "legacy" as const,
      })),
    ];

    runs.sort((a, b) =>
      (b.created_at ?? b.artifact_modified_at ?? "").localeCompare(
        a.created_at ?? a.artifact_modified_at ?? "",
      ),
    );

    return { runs };
  },
};
