import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCheck,
  CircleHelp,
  Clock3,
  Copy,
  GitBranch,
  Info,
  LoaderCircle,
  RefreshCw,
  Workflow,
} from "lucide-react";

import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";

import {
  ApiError,
  runsApi,
  type AnalysisRun,
  type RunStatus,
} from "@/features/runs/api";
import PipelineNode, {
  type PipelineStageNode,
} from "@/features/pipeline/PipelineNode";
import {
  PIPELINE_CONNECTIONS,
  PIPELINE_STAGES,
  STAGE_STATUS_LABELS,
  type DisplayStageStatus,
  type StageDefinition,
  type StageId,
} from "@/features/pipeline/pipeline-config";

const LAST_RUN_KEY = "dq-studio:latest-run-id";
const nodeTypes: NodeTypes = { pipelineStage: PipelineNode };

const runBadge: Record<RunStatus, string> = {
  queued: "bg-amber-50 text-amber-700 ring-amber-200",
  running: "bg-blue-50 text-blue-700 ring-blue-200",
  completed: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-rose-50 text-rose-700 ring-rose-200",
  archived: "bg-slate-100 text-slate-600 ring-slate-200",
};

const stageBadge: Record<DisplayStageStatus, string> = {
  pending: "bg-slate-100 text-slate-600",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  interrupted: "bg-amber-100 text-amber-800",
  unknown: "bg-slate-100 text-slate-500",
};

function getStageStatus(
  run: AnalysisRun | undefined,
  stage: StageId,
): DisplayStageStatus {
  if (!run || run.status === "archived") return "unknown";
  return run.stages[stage] ?? "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "Unavailable";
  const date = new Date(dateString);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

function metricSummary(
  stage: StageDefinition,
  run: AnalysisRun | undefined,
): string | null {
  if (!run || run.status === "archived") return null;
  const firstAvailable = stage.metrics.find(
    ({ key }) => typeof run.metrics[key] === "number",
  );
  if (!firstAvailable) return null;
  const count = run.metrics[firstAvailable.key];
  return typeof count === "number" ? count.toLocaleString() : null;
}

function buildEdges(run: AnalysisRun | undefined): Edge[] {
  return PIPELINE_CONNECTIONS.map(([source, target]) => {
    const from = getStageStatus(run, source);
    const to = getStageStatus(run, target);
    const completed = from === "completed" && to === "completed";
    const advancing = from === "completed" && to === "running";
    const color = completed ? "#10b981" : advancing ? "#2563eb" : "#b7c6d9";

    return {
      id: `${source}-${target}`,
      source,
      target,
      type: "smoothstep",
      animated: advancing,
      selectable: false,
      style: { stroke: color, strokeWidth: completed || advancing ? 2.8 : 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 15, height: 15 },
      pathOptions: { borderRadius: 16 },
    };
  });
}

function StageInspector({
  stage,
  run,
}: {
  stage: StageDefinition;
  run: AnalysisRun | undefined;
}) {
  const status = getStageStatus(run, stage.id);
  const presentMetrics =
    run?.status === "archived"
      ? []
      : stage.metrics.filter(
          ({ key }) => typeof run?.metrics[key] === "number",
        );

  return (
    <aside className="rounded-2xl border border-slate-200 bg-white shadow-sm xl:sticky xl:top-7">
      <div className="border-b border-slate-100 px-5 py-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          <Activity size={15} /> Stage inspector
        </div>
        <h3 className="mt-3 text-lg font-bold leading-tight text-slate-900">
          {stage.title}
        </h3>
        <p className="mt-1.5 break-all font-mono text-xs text-slate-400">
          {stage.id}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${stageBadge[status]}`}
          >
            {STAGE_STATUS_LABELS[status]}
          </span>
          <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
            {stage.track}
          </span>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500">
            What this stage does
          </h4>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {stage.description}
          </p>
        </div>

        <div className="border-t border-slate-100 pt-5">
          <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">
            Reported results
          </h4>
          {presentMetrics.length > 0 ? (
            <div className="space-y-2.5">
              {presentMetrics.map(({ key, label }) => (
                <div
                  key={key}
                  className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3.5 py-3"
                >
                  <span className="text-xs text-slate-600">{label}</span>
                  <span className="text-base font-bold tabular-nums text-slate-900">
                    {run?.metrics[key]?.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3.5 py-4 text-sm leading-6 text-slate-500">
              {run?.status === "archived"
                ? "Execution metrics were not persisted for this archived run."
                : status === "pending"
                  ? "No results yet. This stage is pending."
                  : status === "running"
                    ? "Waiting for this stage to report its results."
                    : status === "unknown"
                      ? "Select a run to inspect its reported stage metrics."
                      : "The API has not returned numerical metrics for this stage."}
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-blue-50/70 px-3.5 py-3 text-xs leading-5 text-blue-900">
          <Info size={16} className="mt-0.5 shrink-0" />
          {run?.status === "archived"
            ? "Artifacts may still exist, but completed stages and the original execution outcome cannot be verified after the backend restarts."
            : status === "running"
              ? "The backend marks the next expected stage as running when its predecessor finishes. It does not confirm the precise start time."
              : status === "interrupted"
                ? "This stage was in a running state when the workflow failed; the API does not identify the exact failing node."
                : "These counts come from the run-status API. Detailed profiling files are not exposed by this endpoint."}
        </div>
      </div>
    </aside>
  );
}

function SummaryCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string | number;
  sublabel: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-slate-900">
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="mt-1 text-xs text-slate-500">{sublabel}</p>
    </div>
  );
}

export default function PipelinePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [storedRunId, setStoredRunId] = useState<string | null>(() =>
    localStorage.getItem(LAST_RUN_KEY),
  );
  const [selectedStageId, setSelectedStageId] =
    useState<StageId>("dataset_discovery");
  const [copied, setCopied] = useState(false);

  const historyQuery = useQuery({
    queryKey: ["run-history"],
    queryFn: ({ signal }) => runsApi.listRuns(signal),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.runs.some(
        (run) => run.status === "queued" || run.status === "running",
      )
        ? 4000
        : false,
  });

  const history = historyQuery.data?.runs ?? [];
  const selectedRunId =
    searchParams.get("run") || storedRunId || history[0]?.run_id || null;

  const runQuery = useQuery({
    queryKey: ["run", selectedRunId],
    queryFn: ({ signal }) => runsApi.getRun(selectedRunId!, signal),
    enabled: Boolean(selectedRunId),
    retry: false,
    refetchInterval: (query) => {
      if (
        query.state.error instanceof ApiError &&
        query.state.error.status === 404
      ) {
        return false;
      }
      const status = query.state.data?.status;
      return status === "completed" ||
        status === "failed" ||
        status === "archived"
        ? false
        : 2000;
    },
  });

  const run = runQuery.data;
  const isArchived = run?.status === "archived";
  const hasLiveStageState = Boolean(run && !isArchived);
  const completed = hasLiveStageState
    ? PIPELINE_STAGES.filter((stage) => run?.stages[stage.id] === "completed")
        .length
    : null;
  const active = hasLiveStageState
    ? PIPELINE_STAGES.filter((stage) => run?.stages[stage.id] === "running")
        .length
    : null;

  const nodes = useMemo<PipelineStageNode[]>(
    () =>
      PIPELINE_STAGES.map((stage) => ({
        id: stage.id,
        type: "pipelineStage",
        position: stage.position,
        data: {
          stage,
          status: getStageStatus(run, stage.id),
          activeSelection: selectedStageId === stage.id,
          primaryMetric: metricSummary(stage, run),
        },
        draggable: false,
        selectable: true,
      })),
    [run, selectedStageId],
  );
  const edges = useMemo(() => buildEdges(run), [run]);
  const selectedStage = PIPELINE_STAGES.find(
    (stage) => stage.id === selectedStageId,
  )!;

  function selectRun(id: string) {
    localStorage.setItem(LAST_RUN_KEY, id);
    setStoredRunId(id);
    setSearchParams({ run: id });
    setSelectedStageId("dataset_discovery");
    setCopied(false);
  }

  async function copyRunId() {
    if (!selectedRunId) return;
    try {
      await navigator.clipboard.writeText(selectedRunId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-700">
            <Workflow size={17} /> Workflow visualization
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Pipeline
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Explore the seven processing stages, follow both recommendation
            branches, and inspect metrics reported by LangGraph.
          </p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          Overview <ArrowUpRight size={16} />
        </Link>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <GitBranch size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <label
                htmlFor="pipeline-run"
                className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500"
              >
                Analysis run
              </label>
              <select
                id="pipeline-run"
                value={selectedRunId ?? ""}
                onChange={(event) => selectRun(event.target.value)}
                disabled={historyQuery.isPending && !selectedRunId}
                className="w-full max-w-135 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                {!selectedRunId && (
                  <option value="">Select an analysis run</option>
                )}
                {selectedRunId &&
                  !history.some((item) => item.run_id === selectedRunId) && (
                    <option value={selectedRunId}>
                      {selectedRunId} (saved selection)
                    </option>
                  )}
                {history.map((item) => (
                  <option key={item.run_id} value={item.run_id}>
                    {item.run_id} — {item.status}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {run && (
              <span
                className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize ring-1 ${runBadge[run.status]}`}
              >
                {run.status}
              </span>
            )}
            {selectedRunId && (
              <button
                type="button"
                onClick={() => void copyRunId()}
                title="Copy complete run ID"
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                <Copy size={14} /> {copied ? "Copied" : "Copy ID"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                void historyQuery.refetch();
                if (selectedRunId) void runQuery.refetch();
              }}
              title="Refresh available runs and selected run status"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
            >
              <RefreshCw
                size={14}
                className={runQuery.isFetching ? "animate-spin" : ""}
              />
              Refresh
            </button>
          </div>
        </div>
        {run && (
          <p className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500">
            <Clock3 size={14} />
            {run.created_at
              ? `Created ${formatDate(run.created_at)}`
              : run.artifact_modified_at
                ? `Artifact directory modified ${formatDate(run.artifact_modified_at)}`
                : "Original creation time unavailable"}
            <span className="mx-1 text-slate-300">•</span>
            {isArchived
              ? "Archived: previous execution state is not available"
              : "Stage states and metrics are sourced from FastAPI"}
          </p>
        )}
        {historyQuery.isError && (
          <p className="mt-3 text-sm text-rose-700">
            Could not load run list: {errorMessage(historyQuery.error)}
          </p>
        )}
      </section>

      {!selectedRunId && !historyQuery.isPending && (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-8 text-center">
          <CircleHelp className="mx-auto text-slate-400" size={28} />
          <p className="mt-2 font-semibold text-slate-900">No run selected</p>
          <p className="mt-1 text-sm text-slate-500">
            Start an analysis from Overview to inspect its pipeline.
          </p>
          <Link
            to="/"
            className="mt-3 inline-block text-sm font-semibold text-blue-700 hover:underline"
          >
            Go to Overview
          </Link>
        </div>
      )}

      {selectedRunId && runQuery.isPending && (
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm text-slate-600">
          <LoaderCircle className="animate-spin text-blue-700" size={17} />{" "}
          Loading the selected run...
        </div>
      )}

      {selectedRunId && runQuery.isError && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Run status could not be retrieved</p>
            <p className="mt-1">{errorMessage(runQuery.error)}</p>
            {run && (
              <p className="mt-1 text-xs">
                Showing the last cached status; it may be outdated.
              </p>
            )}
          </div>
        </div>
      )}

      {run?.status === "failed" && run.error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <AlertTriangle size={19} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">Workflow failed</p>
            <p className="mt-1 wrap-break-word">{run.error}</p>
            <p className="mt-2 text-xs">
              Interrupted nodes are not necessarily the exact source of failure.
            </p>
          </div>
        </div>
      )}

      {run && !isArchived && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Stages completed"
            value={`${completed} / ${PIPELINE_STAGES.length}`}
            sublabel="Finished graph nodes"
          />
          <SummaryCard
            label="Active / next"
            value={active ?? 0}
            sublabel="Backend-reported running states"
          />
          <SummaryCard
            label="Individual-table rules"
            value={run.metrics.individual_recommendation_rule_count ?? "—"}
            sublabel={
              typeof run.metrics.individual_recommendation_rule_count ===
              "number"
                ? "Reported by recommender"
                : "Not reported yet"
            }
          />
          <SummaryCard
            label="Inter-table rules"
            value={run.metrics.inter_table_recommendation_rule_count ?? "—"}
            sublabel={
              typeof run.metrics.inter_table_recommendation_rule_count ===
              "number"
                ? "Reported by recommender"
                : "Not reported yet"
            }
          />
        </div>
      )}

      {isArchived && (
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-100/75 px-5 py-4 text-sm text-slate-700">
          <Info size={19} className="mt-0.5 shrink-0 text-slate-500" />
          <div>
            <p className="font-semibold">
              Historical artifacts found; execution state unavailable
            </p>
            <p className="mt-1 leading-6">
              FastAPI no longer has this run in memory. The workflow structure
              below is accurate, but node statuses and execution metrics cannot
              be recovered without persisted run metadata.
            </p>
          </div>
        </div>
      )}

      <section className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <GitBranch size={19} className="text-blue-700" /> Execution
                graph
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Click a node to inspect its reported results. Pan and zoom to
                explore.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />{" "}
                Completed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-blue-500" /> Active
                / next
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-300" />{" "}
                Pending / unknown
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />{" "}
                Interrupted
              </span>
            </div>
          </div>

          <div className="relative h-170 w-full bg-[#f8fbff] sm:h-185">
            <ReactFlow<PipelineStageNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedStageId(node.id as StageId)}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              elementsSelectable
              fitView
              fitViewOptions={{ padding: 0.13, minZoom: 0.5, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.5}
              className="bg-transparent"
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={19}
                size={1.1}
                color="#cbd5e1"
              />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
            {!run && (
              <div className="pointer-events-none absolute right-4 top-4 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-600 shadow-sm">
                {runQuery.isPending && selectedRunId
                  ? "Loading run state..."
                  : "Workflow structure only — no run state"}
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-white px-5 py-3 text-xs text-slate-500">
            <span>7 stages · 2 recommendation branches</span>
            <span className="flex items-center gap-1.5">
              <CheckCheck size={14} /> Graph topology mirrors the backend
              workflow
            </span>
          </div>
        </div>

        <StageInspector stage={selectedStage} run={run} />
      </section>

      <p className="text-xs leading-5 text-slate-500">
        Stage states are sourced from{" "}
        <code className="rounded bg-slate-100 px-1.5 py-0.5">
          GET /api/v1/runs/{"{run_id}"}
        </code>
        . The diagram represents processing stages, not checks executed against
        source data. Numerical counts are shown only when returned by the
        backend.
      </p>
    </div>
  );
}
