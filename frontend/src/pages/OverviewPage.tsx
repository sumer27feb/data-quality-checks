import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock3,
  Database,
  FileCode2,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { ApiError, runsApi, type RunStatus } from "@/features/runs/api";
import RecentRuns, { type SavedRun } from "@/features/runs/RecentRuns";

const LAST_RUN_KEY = "dq-studio:latest-run-id";

const RECENT_RUNS_KEY = "dq-studio:recent-runs";

// Keep only small run identifiers and browser timestamps locally.
// Execution states and metrics always come from FastAPI.

function readSavedRuns(): SavedRun[] {
  try {
    const raw = localStorage.getItem(RECENT_RUNS_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is SavedRun =>
          typeof item === "object" &&
          item !== null &&
          typeof item.run_id === "string" &&
          typeof item.saved_at === "string",
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}

const statusStyles: Record<RunStatus, string> = {
  queued: "bg-amber-50 text-amber-700 border-amber-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  archived: "bg-slate-100 text-slate-600 border-slate-200",
};

function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium text-slate-500">{label}</p>
      <p className="break-all text-sm font-semibold text-slate-800">
        {value || "Not configured"}
      </p>
    </div>
  );
}

function MetricCard({
  title,
  value,
  description,
}: {
  title: string;
  value: string | number;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="mt-2 text-xs text-slate-500">{description}</p>
    </div>
  );
}

export default function OverviewPage() {
  const [runId, setRunId] = useState<string | null>(() =>
    localStorage.getItem(LAST_RUN_KEY),
  );

  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>(readSavedRuns);
  const queryClient = useQueryClient();

  function rememberRun(selectedId: string) {
    const current = readSavedRuns();
    const existing = current.find((item) => item.run_id === selectedId);

    const updated: SavedRun[] = [
      {
        run_id: selectedId,
        saved_at: existing?.saved_at ?? new Date().toISOString(),
      },
      ...current.filter((item) => item.run_id !== selectedId),
    ].slice(0, 20);

    localStorage.setItem(RECENT_RUNS_KEY, JSON.stringify(updated));
    setSavedRuns(updated);
  }

  const historyQuery = useQuery({
    queryKey: ["run-history"],
    queryFn: ({ signal }) => runsApi.listRuns(signal),
    retry: 1,
    refetchInterval: (query) => {
      const hasActiveRun = query.state.data?.runs.some(
        (item) => item.status === "queued" || item.status === "running",
      );
      return hasActiveRun ? 4000 : false;
    },
  });

  const workspaceQuery = useQuery({
    queryKey: ["workspace"],
    queryFn: ({ signal }) => runsApi.getWorkspace(signal),
    retry: 1,
  });

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => runsApi.getRun(runId!, signal),
    enabled: Boolean(runId),
    retry: false,

    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const error = query.state.error;

      if (error instanceof ApiError && error.status === 404) {
        return false;
      }

      if (
        status === "completed" ||
        status === "failed" ||
        status === "archived"
      ) {
        return false;
      }

      return 2000;
    },
    refetchIntervalInBackground: true,
  });

  const startMutation = useMutation({
    mutationFn: runsApi.createRun,
    onSuccess: (createdRun) => {
      localStorage.setItem(LAST_RUN_KEY, createdRun.run_id);
      rememberRun(createdRun.run_id);
      setRunId(createdRun.run_id);
      setSessionMessage(null);

      // The history list needs to include this newly created run.
      void queryClient.invalidateQueries({ queryKey: ["run-history"] });
    },
  });

  // Refresh the history row after the selected live run finishes.
  useEffect(() => {
    const status = runQuery.data?.status;
    if (runId && (status === "completed" || status === "failed")) {
      void queryClient.invalidateQueries({ queryKey: ["run-history"] });
    }
  }, [queryClient, runId, runQuery.data?.status]);

  // A run with no in-memory record and no artifact directory returns 404.
  useEffect(() => {
    const error = runQuery.error;

    if (runId && error instanceof ApiError && error.status === 404) {
      localStorage.removeItem(LAST_RUN_KEY);
      setRunId(null);
      setSessionMessage(
        "This run could not be found in backend memory or the artifact directory.",
      );
    }
  }, [runId, runQuery.error]);

  const workspace = workspaceQuery.data;
  const run = runQuery.data;

  const isActive = run?.status === "queued" || run?.status === "running";

  const isRestoringRun = Boolean(runId) && runQuery.isPending && !run;

  const canStart =
    workspace?.configured === true &&
    !isActive &&
    !isRestoringRun &&
    !runQuery.isError &&
    !startMutation.isPending;

  const stages = Object.values(run?.stages ?? {});
  const totalStages = stages.length;
  const completedStages = stages.filter(
    (status) => status === "completed",
  ).length;

  const completionPercentage =
    totalStages > 0 ? (completedStages / totalStages) * 100 : 0;

  const metrics = run?.metrics ?? {};

  const individualRules = metrics.individual_recommendation_rule_count;

  const interTableRules = metrics.inter_table_recommendation_rule_count;

  const hasRuleCounts =
    typeof individualRules === "number" || typeof interTableRules === "number";

  const totalRules = hasRuleCounts
    ? (individualRules ?? 0) + (interTableRules ?? 0)
    : null;

  const bothBranchesCompleted =
    typeof individualRules === "number" && typeof interTableRules === "number";

  return (
    <div className="space-y-7 pb-12">
      {/* Page heading */}
      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-700">
          <ShieldCheck size={17} />
          Automated Data Quality
        </div>

        <h1 className="text-3xl font-bold tracking-tight text-slate-900">
          Analysis Overview
        </h1>

        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
          Discover existing Databricks tables, generate statistical and semantic
          profiles, and recommend meaningful data quality checks.
        </p>
      </div>

      {/* Configured Databricks workspace */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl bg-blue-50 p-3 text-blue-700">
            <Database size={22} />
          </div>

          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Configured Data Source
            </h2>
            <p className="text-sm text-slate-500">
              Read-only configuration supplied by FastAPI
            </p>
          </div>
        </div>

        {workspaceQuery.isPending && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <LoaderCircle size={16} className="animate-spin" />
            Loading workspace configuration...
          </p>
        )}

        {workspaceQuery.isError && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-medium text-red-800">
              Unable to load workspace configuration
            </p>
            <p className="mt-1 text-sm text-red-700">
              {errorText(workspaceQuery.error)}
            </p>

            <button
              type="button"
              onClick={() => void workspaceQuery.refetch()}
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-red-800 hover:underline"
            >
              <RefreshCw size={14} />
              Retry request
            </button>
          </div>
        )}

        {workspace && (
          <>
            <div className="grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-2 xl:grid-cols-4">
              <Detail label="Data Platform" value={workspace.source} />
              <Detail label="Catalog" value={workspace.catalog} />
              <Detail label="Schema" value={workspace.schema} />
              <Detail label="LLM Endpoint" value={workspace.model_endpoint} />
            </div>

            <div className="mt-5 flex items-start gap-3 rounded-xl bg-slate-50 p-4">
              <FolderOpen
                size={19}
                className="mt-0.5 shrink-0 text-slate-500"
              />

              <div className="min-w-0">
                <p className="text-xs font-medium text-slate-500">
                  Configuration Volume
                </p>

                <p className="mt-1 break-all font-mono text-sm text-slate-800">
                  {workspace.config_volume_path || "Not configured"}
                </p>
              </div>
            </div>

            {!workspace.configured && (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                <p className="font-semibold text-amber-900">
                  Backend configuration is incomplete
                </p>
                <p className="mt-1 text-sm text-amber-800">
                  Missing environment settings:
                </p>
                <p className="mt-2 wrap-break-word font-mono text-xs text-amber-900">
                  {workspace.missing_configuration.join(", ")}
                </p>
              </div>
            )}
          </>
        )}
      </section>

      {/* Start analysis */}
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col justify-between gap-5 md:flex-row md:items-center">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2">
              <Activity size={19} className="text-blue-700" />
              <h2 className="text-lg font-semibold text-slate-900">
                Analysis Execution
              </h2>
            </div>

            <p className="mt-2 text-sm leading-6 text-slate-500">
              Start the existing LangGraph workflow using the configured
              Databricks dataset. Source tables and configuration files are
              discovered directly from Databricks; no file upload is required.
            </p>
          </div>

          <button
            type="button"
            disabled={!canStart}
            onClick={() => startMutation.mutate()}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startMutation.isPending ? (
              <LoaderCircle size={18} className="animate-spin" />
            ) : (
              <Play size={18} />
            )}

            {startMutation.isPending
              ? "Starting..."
              : isActive
                ? "Analysis Running"
                : run
                  ? "Start New Analysis"
                  : "Start Analysis"}
          </button>
        </div>

        {startMutation.isError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {errorText(startMutation.error)}
          </div>
        )}

        {sessionMessage && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            {sessionMessage}
          </div>
        )}
      </section>

      {/* Backend-owned recent run history */}
      <RecentRuns
        runs={historyQuery.data?.runs ?? []}
        savedRuns={savedRuns}
        selectedRunId={runId}
        loading={historyQuery.isPending}
        error={historyQuery.isError ? errorText(historyQuery.error) : null}
        onRetry={() => void historyQuery.refetch()}
        onSelect={(selectedId) => {
          rememberRun(selectedId);
          localStorage.setItem(LAST_RUN_KEY, selectedId);
          setRunId(selectedId);
          setSessionMessage(null);
        }}
      />

      {/* Previous or active run */}
      {isRestoringRun && (
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
          <LoaderCircle size={18} className="animate-spin text-blue-700" />
          Retrieving the selected analysis run...
        </div>
      )}

      {runQuery.isError &&
        !(
          runQuery.error instanceof ApiError && runQuery.error.status === 404
        ) && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-5">
            <p className="font-medium text-red-800">
              Unable to retrieve the selected run
            </p>

            <p className="mt-1 text-sm text-red-700">
              {errorText(runQuery.error)}
            </p>

            <button
              type="button"
              onClick={() => void runQuery.refetch()}
              className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-red-800 hover:underline"
            >
              <RefreshCw size={15} />
              Retry status request
            </button>
          </div>
        )}

      {run?.status === "archived" && (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">
              Selected Archived Run
            </h2>
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusStyles.archived}`}
            >
              Archived
            </span>
          </div>
          <p className="mt-2 break-all font-mono text-xs text-slate-500">
            {run.run_id}
          </p>
          {run.artifact_modified_at && (
            <p className="mt-3 text-sm text-slate-500">
              Artifact folder last modified:{" "}
              {new Date(run.artifact_modified_at).toLocaleString()}
            </p>
          )}
          <p className="mt-4 text-sm leading-6 text-slate-600">
            Existing artifacts were found for this run. Because FastAPI no
            longer has its in-memory execution record, the original status,
            completed stages, and metrics cannot be confirmed. Stored
            recommendations can still be retrieved where the corresponding files
            exist.
          </p>
        </section>
      )}

      {run && run.status !== "archived" && (
        <>
          {/* Run information */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Selected Analysis Run
                </h2>

                <p className="mt-1 break-all font-mono text-xs text-slate-500">
                  {run.run_id}
                </p>
              </div>

              <span
                className={`rounded-full border px-3 py-1 text-xs font-semibold capitalize ${statusStyles[run.status]}`}
              >
                {run.status}
              </span>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <Clock3 size={15} />
              Created:{" "}
              {run.created_at
                ? new Date(run.created_at).toLocaleString()
                : "Unavailable"}
            </div>

            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-slate-700">
                  Pipeline stages completed
                </span>
                <span className="font-semibold text-slate-900">
                  {completedStages} / {totalStages}
                </span>
              </div>

              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-500"
                  style={{
                    width: `${completionPercentage}%`,
                  }}
                />
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Progress represents completed processing stages, not estimated
                execution time.
              </p>
            </div>

            {run.status === "failed" && (
              <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4">
                <div className="flex items-center gap-2 font-semibold text-red-800">
                  <AlertCircle size={17} />
                  Analysis execution failed
                </div>

                <p className="mt-2 wrap-break-word text-sm text-red-700">
                  {run.error || "No detailed execution error was returned."}
                </p>

                <p className="mt-2 text-xs text-red-700">
                  Any stages that were completed before the failure remain
                  recorded in this run.
                </p>
              </div>
            )}

            {run.status === "completed" && (
              <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">
                <CheckCircle2 size={18} />
                Workflow execution completed.
              </div>
            )}
          </section>

          {/* Only show metrics returned by completed nodes */}
          <section>
            <div className="mb-4 flex items-center gap-2">
              <Layers3 size={20} className="text-slate-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Analysis Metrics
              </h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                title="Completed Stages"
                value={`${completedStages} / ${totalStages}`}
                description="Reported by LangGraph execution tracking"
              />

              {typeof metrics.discovered_table_count === "number" && (
                <MetricCard
                  title="Discovered Tables"
                  value={metrics.discovered_table_count}
                  description="Returned by Dataset Discovery"
                />
              )}

              {typeof metrics.profiled_column_count === "number" && (
                <MetricCard
                  title="Profiled Columns"
                  value={metrics.profiled_column_count}
                  description="Returned by Statistical Profiling"
                />
              )}

              {totalRules !== null && (
                <MetricCard
                  title="Recommended Rules"
                  value={totalRules}
                  description={
                    bothBranchesCompleted
                      ? "Combined individual and inter-table recommendations"
                      : "Count from completed recommendation branches so far"
                  }
                />
              )}
            </div>
          </section>

          {/* Actual intermediate counts */}
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center gap-2">
              <FileCode2 size={19} className="text-slate-600" />
              <h2 className="text-lg font-semibold text-slate-900">
                Available Processing Results
              </h2>
            </div>

            <div className="divide-y divide-slate-100">
              {[
                {
                  label: "Discovery column mismatches",
                  value: metrics.discovery_column_mismatch_count,
                },
                {
                  label: "Tables statistically profiled",
                  value: metrics.profiled_table_count,
                },
                {
                  label: "Tables semantically profiled",
                  value: metrics.semantic_table_count,
                },
                {
                  label: "Consolidated table profiles",
                  value: metrics.consolidated_profile_count,
                },
                {
                  label: "Declared foreign keys consolidated",
                  value: metrics.inter_table_profile_foreign_key_count,
                },
                {
                  label: "Individual-table recommendations",
                  value: individualRules,
                },
                {
                  label: "Inter-table recommendations",
                  value: interTableRules,
                },
              ]
                .filter((item) => typeof item.value === "number")
                .map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <span className="text-sm text-slate-600">{item.label}</span>

                    <span className="font-semibold tabular-nums text-slate-900">
                      {item.value?.toLocaleString()}
                    </span>
                  </div>
                ))}
            </div>

            {completedStages === 0 && (
              <p className="text-sm text-slate-500">
                Processing summaries will appear after their respective stages
                complete.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
