import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ClipboardList,
  Download,
  FilterX,
  GitBranch,
  Info,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import { runsApi } from "@/features/runs/api";

import {
  normalizeRecommendations,
  recommendationsApi,
  traditionalChecksApi,
  reviewApi,
  scopedRunReference,
  type ImpactLevel,
  type RuleScope,
  type ReviewRule,
  type TraditionalChecksResponse,
  type RecommendationsResponse,
} from "@/features/recommendations/api";

import { exportSelection } from "@/features/recommendations/export";
import { useSqlDrafts } from "@/features/recommendations/useSqlDrafts";

import RuleCard, { humanize } from "@/features/recommendations/RuleCard";

import RuleInspector from "@/features/recommendations/RuleInspector";
import SqlReviewEditor from "@/features/recommendations/SqlReviewEditor";
import CustomRulesPanel from "@/features/recommendations/CustomRulesPanel";
import TraditionalChecksPanel from "@/features/traditional/TraditionalChecksPanel";

const LAST_RUN_KEY = "dq-studio:latest-run-id";
const SELECTION_PREFIX = "dq-studio:kept-rules:";

type ScopeFilter = "all" | RuleScope;
type ImpactFilter = "all" | ImpactLevel;

const impactOrder: Record<ImpactLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function savedSelections(runId: string | null): string[] {
  if (!runId) return [];

  try {
    const raw: unknown = JSON.parse(
      localStorage.getItem(SELECTION_PREFIX + runId) || "[]",
    );

    return Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected request error occurred.";
}

function StatCard({
  label,
  value,
  footnote,
  icon: Icon,
}: {
  label: string;
  value: number | string;
  footnote: string;
  icon: typeof ShieldCheck;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-500">{label}</span>

        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
          <Icon size={18} />
        </div>
      </div>

      <div className="mt-2 text-3xl font-bold tracking-tight text-slate-900 tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>

      <p className="mt-1 text-xs text-slate-500">{footnote}</p>
    </div>
  );
}

export default function RecommendationsPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const urlRunId = params.get("run");

  const [locallySelectedRun, setLocallySelectedRun] = useState<string | null>(
    () => localStorage.getItem(LAST_RUN_KEY),
  );

  // Discovery runs do not contain rule recommendations.
  const candidateRunId = urlRunId || locallySelectedRun;

  const runId =
    candidateRunId?.startsWith("discovery_") &&
    !scopedRunReference(candidateRunId)
      ? null
      : candidateRunId;

  const scopedRun = scopedRunReference(runId);

  // -----------------------------------------------------
  // Page filters and editors
  // -----------------------------------------------------

  const [scope, setScope] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [tableFilter, setTableFilter] = useState("all");
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>("all");
  const [relationFilter, setRelationFilter] = useState("all");
  const [showOnlySelected, setShowOnlySelected] = useState(false);

  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);

  const [traditionalOpen, setTraditionalOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewMessage, setReviewMessage] = useState("");
  const [reviewError, setReviewError] = useState("");

  // Session changes override persisted selection only after
  // the user actually modifies it.
  const [sessionSelections, setSessionSelections] = useState<{
    runId: string | null;
    ids: string[];
  }>({
    runId: null,
    ids: [],
  });

  // SQL edits made during this session override the saved review.
  const [sqlOverrides, setSqlOverrides] = useState<{
    runId: string | null;
    entries: Record<string, string>;
  }>({
    runId: null,
    entries: {},
  });

  // -----------------------------------------------------
  // Backend queries
  // -----------------------------------------------------

  const historyQuery = useQuery({
    queryKey: ["run-history"],
    queryFn: ({ signal }) => runsApi.listRuns(signal),
    retry: 1,
  });

  const reviewableRuns = (historyQuery.data?.runs ?? []).filter(
    (item) => item.kind !== "discovery",
  );

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => runsApi.getRun(runId!, signal),
    enabled: Boolean(runId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 2500 : false;
    },
  });

  const isRunning =
    runQuery.data?.status === "queued" || runQuery.data?.status === "running";

  const recommendationsQuery = useQuery({
    queryKey: ["recommendations", runId],
    queryFn: ({ signal }) => recommendationsApi.get(runId!, signal),
    enabled: Boolean(runId),
    retry: 1,
    refetchInterval: isRunning ? 4000 : false,
  });

  const traditionalQuery = useQuery({
    queryKey: ["traditional-checks", runId],
    queryFn: ({ signal }) => traditionalChecksApi.get(runId!, signal),
    enabled: Boolean(runId),
    retry: 1,
  });

  // Legacy runs continue using browser selections.
  // Only Graph 2 runs use backend-persisted reviews.
  const reviewQuery = useQuery({
    queryKey: ["saved-review", runId],
    queryFn: ({ signal }) => reviewApi.get(runId!, signal),
    enabled: Boolean(scopedRun),
    retry: 1,
  });

  const reviewReady = !scopedRun || reviewQuery.isSuccess;

  const traditionalData = traditionalQuery.data;

  // Preserve traditional-only rendering even if the legacy
  // recommendations aggregator has not returned data.
  const data: RecommendationsResponse | undefined =
    recommendationsQuery.data ??
    (traditionalData?.rules.length
      ? {
          run_id: runId!,
          status: runQuery.data?.status ?? "archived",
          available: {
            individual: false,
            inter_table: false,
            traditional: true,
          },
          individual_rules: {},
          inter_table_rules: [],
          traditional_rules: {},
          custom_rules: [],
        }
      : undefined);

  // -----------------------------------------------------
  // Normalize LLM, traditional and custom rules
  // -----------------------------------------------------

  const rules = useMemo(() => {
    const combined = data ? normalizeRecommendations(data) : [];

    if (!traditionalData) return combined;

    // The dedicated traditional API is authoritative.
    // Remove any copy returned by the combined API first.
    const otherRules = combined.filter((item) => item.scope !== "traditional");

    const traditionalRules: ReviewRule[] = traditionalData.rules.map(
      (item, index) => ({
        ...item,
        id: item.id,
        scope: "traditional",
        table_name: item.table_name,
        column_name: item.column_name,
        check_type: item.check_type,
        sql_result_mode: "violation_rows",
        validation_sql: item.validation_sql ?? null,
        sql_generation_note: item.sql_generation_note ?? null,
        position: index + 1,
      }),
    );

    return [...otherRules, ...traditionalRules];
  }, [data, traditionalData]);

  const sqlDrafts = useSqlDrafts(runId);

  // -----------------------------------------------------
  // SQL review: session > server review > browser draft
  // -----------------------------------------------------

  function currentSql(rule: ReviewRule): string {
    if (
      sqlOverrides.runId === runId &&
      Object.prototype.hasOwnProperty.call(sqlOverrides.entries, rule.id)
    ) {
      return sqlOverrides.entries[rule.id];
    }

    if (scopedRun && reviewQuery.data) {
      const saved = reviewQuery.data.rules.find(
        (entry) => entry.id === rule.id,
      );

      if (saved) {
        return saved.reviewed_sql ?? "";
      }

      // A Graph 2 rule not present in the saved review
      // starts with its original SQL.
      return rule.validation_sql ?? "";
    }

    return sqlDrafts.currentSql(rule);
  }

  function updateSql(rule: ReviewRule, text: string) {
    setSqlOverrides((previous) => ({
      runId,
      entries: {
        ...(previous.runId === runId ? previous.entries : {}),
        [rule.id]: text,
      },
    }));

    // Keep the original browser-draft behavior.
    sqlDrafts.setDraft(rule, text);
  }

  function restoreSql(rule: ReviewRule) {
    updateSql(rule, rule.validation_sql ?? "");
  }

  const generatedSqlCount = rules.filter((rule) =>
    Boolean(rule.validation_sql?.trim()),
  ).length;

  // -----------------------------------------------------
  // Selection: backend for Graph 2, localStorage for legacy
  // -----------------------------------------------------

  const knownIds = useMemo(
    () => new Set(rules.map((rule) => rule.id)),
    [rules],
  );

  const serverSelectedIds =
    scopedRun && reviewQuery.data
      ? reviewQuery.data.rules.map((entry) => entry.id)
      : [];

  const savedIds =
    sessionSelections.runId === runId
      ? sessionSelections.ids
      : scopedRun
        ? serverSelectedIds
        : savedSelections(runId);

  const selectedIds = useMemo(
    () => new Set(savedIds.filter((id) => knownIds.has(id))),
    [savedIds, knownIds],
  );

  const staleIdsCount = savedIds.length - selectedIds.size;

  const selectedRules = useMemo(
    () => rules.filter((rule) => selectedIds.has(rule.id)),
    [rules, selectedIds],
  );

  const selectedExportRules = selectedRules.map((rule) => ({
    ...rule,
    reviewed_sql: currentSql(rule).trim() || null,
  }));

  const selectedWithSql = selectedExportRules.filter((rule) =>
    Boolean(rule.reviewed_sql),
  ).length;

  // -----------------------------------------------------
  // Counts and available filters
  // -----------------------------------------------------

  const scopeCounts = useMemo(
    () => ({
      all: rules.length,
      individual: rules.filter((rule) => rule.scope === "individual").length,
      inter_table: rules.filter((rule) => rule.scope === "inter_table").length,
      traditional: rules.filter((rule) => rule.scope === "traditional").length,
      custom: rules.filter((rule) => rule.scope === "custom").length,
    }),
    [rules],
  );

  const tableNames = useMemo(
    () =>
      Array.from(
        new Set(
          rules
            .filter((rule) => rule.table_name)
            .map((rule) => rule.table_name!),
        ),
      ).sort(),
    [rules],
  );

  const relationTypes = useMemo(
    () =>
      Array.from(
        new Set(
          rules
            .map((rule) => rule.proposed_relation)
            .filter((relation): relation is string => Boolean(relation)),
        ),
      ).sort(),
    [rules],
  );

  const impactCounts = useMemo(
    () => ({
      high: rules.filter((rule) => rule.impact.level === "high").length,
      medium: rules.filter((rule) => rule.impact.level === "medium").length,
      low: rules.filter((rule) => rule.impact.level === "low").length,
    }),
    [rules],
  );

  const visibleRules = useMemo(() => {
    const needle = search.trim().toLowerCase();

    return rules
      .filter((rule) => {
        if (scope !== "all" && rule.scope !== scope) return false;

        if (tableFilter !== "all" && rule.table_name !== tableFilter)
          return false;

        if (impactFilter !== "all" && rule.impact.level !== impactFilter)
          return false;

        if (
          relationFilter !== "all" &&
          rule.proposed_relation !== relationFilter
        )
          return false;

        if (showOnlySelected && !selectedIds.has(rule.id)) return false;

        if (!needle) return true;

        return [
          rule.description,
          rule.rule,
          rule.validation_sql ?? "",
          rule.sql_generation_note ?? "",
          rule.impact.reason,
          rule.table_name ?? "",
          rule.proposed_relation ?? "",
        ].some((value) => value.toLowerCase().includes(needle));
      })
      .sort(
        (a, b) =>
          impactOrder[a.impact.level] - impactOrder[b.impact.level] ||
          (a.table_name ?? "").localeCompare(b.table_name ?? "") ||
          a.position - b.position,
      );
  }, [
    rules,
    search,
    scope,
    tableFilter,
    impactFilter,
    relationFilter,
    showOnlySelected,
    selectedIds,
  ]);

  const inspectedRule = rules.find((rule) => rule.id === inspectedId) ?? null;

  const editingRule = rules.find((rule) => rule.id === editingRuleId) ?? null;

  const allVisibleSelected =
    visibleRules.length > 0 &&
    visibleRules.every((rule) => selectedIds.has(rule.id));

  const hasFilters = Boolean(
    search ||
    scope !== "all" ||
    tableFilter !== "all" ||
    impactFilter !== "all" ||
    relationFilter !== "all" ||
    showOnlySelected,
  );

  // -----------------------------------------------------
  // Selection actions
  // -----------------------------------------------------

  function updateSelection(next: Set<string>) {
    if (!runId) return;

    const ids = [...next];

    // Only legacy reviews rely on localStorage as their
    // authoritative selection storage.
    if (!scopedRun) {
      try {
        localStorage.setItem(SELECTION_PREFIX + runId, JSON.stringify(ids));
      } catch {
        // Selection remains usable for this session.
      }
    }

    setSessionSelections({ runId, ids });
    setReviewMessage("");
  }

  function toggleRule(id: string) {
    const next = new Set(selectedIds);

    if (next.has(id)) next.delete(id);
    else next.add(id);

    updateSelection(next);
  }

  function selectFiltered() {
    const next = new Set(selectedIds);

    for (const rule of visibleRules) {
      next.add(rule.id);
    }

    updateSelection(next);
  }

  function clearFiltered() {
    const next = new Set(selectedIds);

    for (const rule of visibleRules) {
      next.delete(rule.id);
    }

    updateSelection(next);
  }

  function clearAll() {
    updateSelection(new Set());
  }

  function resetFilters() {
    setScope("all");
    setTableFilter("all");
    setImpactFilter("all");
    setRelationFilter("all");
    setSearch("");
    setShowOnlySelected(false);
  }

  function changeRun(id: string) {
    setParams({ run: id });
    localStorage.setItem(LAST_RUN_KEY, id);
    setLocallySelectedRun(id);

    setInspectedId(null);
    setEditingRuleId(null);
    setTraditionalOpen(false);
    setCustomOpen(false);
    setSessionSelections({ runId: null, ids: [] });
    setSqlOverrides({ runId: null, entries: {} });

    setReviewError("");
    setReviewMessage("");

    resetFilters();
  }

  // -----------------------------------------------------
  // Traditional checks
  // -----------------------------------------------------

  function onTraditionalSaved(result: TraditionalChecksResponse) {
    queryClient.setQueryData(["traditional-checks", runId], result);

    const grouped: NonNullable<RecommendationsResponse["traditional_rules"]> =
      {};

    for (const rule of result.rules) {
      (grouped[rule.table_name] ??= []).push(rule);
    }

    queryClient.setQueryData<RecommendationsResponse>(
      ["recommendations", runId],
      (previous) =>
        previous
          ? {
              ...previous,
              available: {
                ...previous.available,
                traditional: true,
              },
              traditional_rules: grouped,
            }
          : previous,
    );

    // Select every newly generated per-column check.
    // Preserve already selected LLM and custom rules.
    const next = new Set(
      [...selectedIds].filter((id) => !id.startsWith("traditional:")),
    );

    for (const rule of result.rules) {
      next.add(rule.id);
    }

    updateSelection(next);

    setTraditionalOpen(false);
    setScope("traditional");
    setShowOnlySelected(false);
    setTableFilter("all");
    setImpactFilter("all");
    setRelationFilter("all");
    setSearch("");

    void traditionalQuery.refetch();
    void recommendationsQuery.refetch();
  }

  // -----------------------------------------------------
  // Custom rules
  // -----------------------------------------------------

  function onCustomChanged(createdId?: string, deletedId?: string) {
    const next = new Set(selectedIds);

    if (createdId) next.add(createdId);
    if (deletedId) next.delete(deletedId);

    updateSelection(next);

    void queryClient.invalidateQueries({
      queryKey: ["recommendations", runId],
    });
  }

  // -----------------------------------------------------
  // Persist reviewed selections and SQL
  // -----------------------------------------------------

  async function saveBackendReview() {
    if (!runId || !scopedRun || !reviewReady || reviewSaving) {
      return;
    }

    setReviewSaving(true);
    setReviewError("");
    setReviewMessage("");

    try {
      const snapshot = selectedRules.map((rule) => ({
        id: rule.id,
        reviewed_sql: currentSql(rule).trim() || null,
      }));

      // An empty snapshot intentionally clears a saved review.
      const saved = await reviewApi.save(runId, snapshot);

      queryClient.setQueryData(["saved-review", runId], saved);

      setReviewMessage(
        `${snapshot.length} reviewed rule(s) saved to the backend.`,
      );
    } catch (error) {
      setReviewError(messageFor(error));
    } finally {
      setReviewSaving(false);
    }
  }

  // -----------------------------------------------------
  // Render
  // -----------------------------------------------------

  return (
    <div className="space-y-6 pb-12">
      {traditionalOpen && runId && (
        <TraditionalChecksPanel
          key={runId}
          runId={runId}
          onClose={() => setTraditionalOpen(false)}
          onSaved={onTraditionalSaved}
        />
      )}

      {customOpen && scopedRun && (
        <CustomRulesPanel
          discoveryId={scopedRun.discoveryId}
          recommendationId={scopedRun.recommendationId}
          rules={recommendationsQuery.data?.custom_rules ?? []}
          onClose={() => setCustomOpen(false)}
          onChanged={onCustomChanged}
        />
      )}

      {editingRule && (
        <SqlReviewEditor
          key={`${runId}:${editingRule.id}`}
          ruleId={editingRule.id}
          description={editingRule.description}
          sourceSql={editingRule.validation_sql}
          reviewedSql={currentSql(editingRule)}
          resultMode={
            editingRule.sql_result_mode ??
            (editingRule.scope === "traditional"
              ? "violation_rows"
              : "violation_count")
          }
          onSave={(sql) => updateSql(editingRule, sql)}
          onClose={() => setEditingRuleId(null)}
        />
      )}

      <header className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700">
            <Sparkles size={17} />
            AI-assisted data quality
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Rule Recommendations
          </h1>

          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Review LLM-generated, traditional and custom data quality checks.
            Inspect and edit their SQL, select rules to keep, and export or save
            your review.
          </p>
        </div>

        <div className="w-full xl:w-80">
          <label
            htmlFor="recommendations-run"
            className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500"
          >
            Recommendation run
          </label>

          <div className="relative">
            <select
              id="recommendations-run"
              value={runId ?? ""}
              onChange={(event) => {
                if (event.target.value) {
                  changeRun(event.target.value);
                }
              }}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-3 pl-3 pr-9 text-xs text-slate-800 shadow-sm outline-none focus:border-blue-500"
            >
              {!runId && <option value="">Select a run</option>}

              {runId &&
                !reviewableRuns.some((item) => item.run_id === runId) && (
                  <option value={runId}>{runId.slice(0, 24)}… · current</option>
                )}

              {reviewableRuns.map((item) => (
                <option key={item.run_id} value={item.run_id}>
                  {item.name ?? item.run_id.slice(0, 24)}
                  {" · "}
                  {item.status}
                </option>
              ))}
            </select>

            <ChevronDown
              size={16}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
          </div>
        </div>
      </header>

      {!runId ? (
        <div className="rounded-2xl border border-slate-200 bg-white px-8 py-16 text-center shadow-sm">
          <ClipboardList size={34} className="mx-auto text-blue-600" />

          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            Choose a recommendation run
          </h2>

          <p className="mt-2 text-sm text-slate-500">
            Select an existing recommendation run above or{" "}
            <Link
              to="/reusable-runs"
              className="font-semibold text-blue-700 hover:underline"
            >
              create a named recommendation run
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Selected run
              </span>

              <span className="break-all font-mono text-xs text-slate-800">
                {runId}
              </span>

              {runQuery.data && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600">
                  {runQuery.data.status}
                </span>
              )}

              {isRunning && (
                <LoaderCircle
                  size={15}
                  className="animate-spin text-blue-600"
                  aria-label="Run active"
                />
              )}
            </div>

            <div className="flex flex-wrap gap-4">
              <Link
                to={`/pipeline?run=${encodeURIComponent(runId)}`}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline"
              >
                Open pipeline
                <ArrowRight size={14} />
              </Link>

              {scopedRun && (
                <Link
                  to={`/profiles?run=${encodeURIComponent(scopedRun.discoveryId)}`}
                  className="text-xs font-semibold text-blue-700 hover:underline"
                >
                  Parent profiles
                </Link>
              )}
            </div>
          </section>

          {runQuery.isError && (
            <div
              role="alert"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
            >
              Unable to load run status: {messageFor(runQuery.error)}.
              Recommendation artifacts are requested separately.
            </div>
          )}

          {recommendationsQuery.isPending && (
            <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">
              <LoaderCircle size={19} className="animate-spin text-blue-600" />
              Loading recommendations for this run...
            </div>
          )}

          {recommendationsQuery.isError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"
            >
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={18} />
                {messageFor(recommendationsQuery.error)}
              </span>

              <button
                type="button"
                onClick={() => void recommendationsQuery.refetch()}
                className="inline-flex items-center gap-1.5 font-bold hover:underline"
              >
                <RefreshCw size={15} />
                Retry
              </button>
            </div>
          )}

          {scopedRun && reviewQuery.isPending && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
              <LoaderCircle size={17} className="animate-spin" />
              Loading your saved rule review...
            </div>
          )}

          {scopedRun && reviewQuery.isError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
            >
              <span>
                Unable to load saved review: {messageFor(reviewQuery.error)}
              </span>

              <button
                type="button"
                onClick={() => void reviewQuery.refetch()}
                className="font-semibold underline"
              >
                Retry
              </button>
            </div>
          )}

          {data && reviewReady && (
            <>
              {/* Summary cards */}
              <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Available rules"
                  value={rules.length}
                  footnote="Generated, traditional and custom rules"
                  icon={ClipboardList}
                />

                <StatCard
                  label="Selected to keep"
                  value={selectedRules.length}
                  footnote={
                    scopedRun
                      ? "Review can be saved to the backend"
                      : "Saved locally for this legacy run"
                  }
                  icon={CheckCheck}
                />

                <StatCard
                  label="High impact"
                  value={impactCounts.high}
                  footnote="Across all available rule types"
                  icon={ShieldCheck}
                />

                <StatCard
                  label="Cross-table rules"
                  value={scopeCounts.inter_table}
                  footnote={
                    data.available.inter_table
                      ? "Cross-table output available"
                      : "Branch skipped or not completed"
                  }
                  icon={GitBranch}
                />
              </section>

              {/* Review progress */}
              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col justify-between gap-5 p-5 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <CheckCheck size={18} className="text-blue-700" />
                      Review progress
                    </div>

                    <p className="mt-1 text-xs text-slate-500">
                      {selectedRules.length} of {rules.length} rules selected
                      {" · "}
                      {scopedRun
                        ? "Save Review persists your selection"
                        : "Stored in this browser"}
                    </p>

                    <div
                      role="progressbar"
                      aria-valuenow={selectedRules.length}
                      aria-valuemin={0}
                      aria-valuemax={rules.length || 1}
                      aria-label="Selected recommendations"
                      className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-100"
                    >
                      <div
                        className="h-full rounded-full bg-linear-to-r from-blue-600 to-emerald-500 transition-all"
                        style={{
                          width: `${
                            rules.length
                              ? (100 * selectedRules.length) / rules.length
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="min-w-52 md:w-64">
                    <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      Impact distribution
                    </p>

                    <div
                      className="flex h-3 overflow-hidden rounded-full bg-slate-100"
                      aria-label="Rule counts by impact"
                    >
                      {rules.length > 0 && (
                        <>
                          <div
                            className="bg-rose-500"
                            style={{
                              width: `${
                                (impactCounts.high / rules.length) * 100
                              }%`,
                            }}
                          />

                          <div
                            className="bg-amber-400"
                            style={{
                              width: `${
                                (impactCounts.medium / rules.length) * 100
                              }%`,
                            }}
                          />

                          <div
                            className="bg-sky-400"
                            style={{
                              width: `${
                                (impactCounts.low / rules.length) * 100
                              }%`,
                            }}
                          />
                        </>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap justify-between gap-1 text-[11px] text-slate-500">
                      <span>High {impactCounts.high}</span>
                      <span>Medium {impactCounts.medium}</span>
                      <span>Low {impactCounts.low}</span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Conditional branch availability */}
              {(!data.available.individual || !data.available.inter_table) && (
                <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
                  <Info size={16} className="mt-0.5 shrink-0" />

                  <div>
                    One or more recommendation branches have not completed or
                    were intentionally skipped. Only the available rule outputs
                    are shown. Traditional and custom rules remain separate from
                    graph execution.
                  </div>
                </div>
              )}

              {/* Filters */}
              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">
                        Explore recommendations
                      </h2>

                      <p className="mt-1 text-xs text-slate-500">
                        Filter, inspect and select rules before exporting or
                        saving the review.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={Boolean(
                          scopedRun && runQuery.data?.status !== "completed",
                        )}
                        onClick={() => setTraditionalOpen(true)}
                        className="rounded-lg bg-blue-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-40"
                      >
                        Configure traditional checks
                      </button>

                      {scopedRun && (
                        <button
                          type="button"
                          onClick={() => setCustomOpen(true)}
                          className="rounded-lg border border-blue-200 px-4 py-2.5 text-xs font-semibold text-blue-700 hover:bg-blue-50"
                        >
                          Manage Custom Rules
                        </button>
                      )}

                      {hasFilters && (
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-blue-700"
                        >
                          <FilterX size={16} />
                          Reset filters
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Scope tabs */}
                  <div
                    role="tablist"
                    aria-label="Recommendation scope"
                    className="flex flex-wrap gap-1.5 rounded-xl bg-slate-100 p-1.5"
                  >
                    {(
                      [
                        {
                          id: "all",
                          label: "All rules",
                          value: scopeCounts.all,
                        },
                        {
                          id: "individual",
                          label: "Individual-table",
                          value: scopeCounts.individual,
                        },
                        {
                          id: "inter_table",
                          label: "Inter-table",
                          value: scopeCounts.inter_table,
                        },
                        {
                          id: "traditional",
                          label: "Traditional",
                          value: scopeCounts.traditional,
                        },
                        {
                          id: "custom",
                          label: "Custom",
                          value: scopeCounts.custom,
                        },
                      ] as {
                        id: ScopeFilter;
                        label: string;
                        value: number;
                      }[]
                    ).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={scope === tab.id}
                        onClick={() => {
                          setScope(tab.id);
                          setTableFilter("all");
                        }}
                        className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${
                          scope === tab.id
                            ? "bg-white text-blue-700 shadow-sm"
                            : "text-slate-500 hover:text-slate-800"
                        }`}
                      >
                        {tab.label}
                        <span className="ml-1 tabular-nums opacity-70">
                          {tab.value}
                        </span>
                      </button>
                    ))}
                  </div>

                  {/* Search and attribute filters */}
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(160px,1fr)_180px_150px_180px]">
                    <label className="relative block">
                      <Search
                        size={17}
                        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                      />

                      <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search rule, SQL, impact..."
                        aria-label="Search recommendations"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-blue-500 focus:bg-white"
                      />
                    </label>

                    <select
                      aria-label="Filter by table"
                      value={scope === "inter_table" ? "all" : tableFilter}
                      disabled={scope === "inter_table"}
                      onChange={(event) => setTableFilter(event.target.value)}
                      className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-blue-500 disabled:opacity-50"
                    >
                      <option value="all">All tables</option>

                      {tableNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="Filter by impact"
                      value={impactFilter}
                      onChange={(event) =>
                        setImpactFilter(event.target.value as ImpactFilter)
                      }
                      className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-blue-500"
                    >
                      <option value="all">All impacts</option>
                      <option value="high">High impact</option>
                      <option value="medium">Medium impact</option>
                      <option value="low">Low impact</option>
                    </select>

                    <select
                      aria-label="Filter by relationship category"
                      value={relationFilter}
                      onChange={(event) =>
                        setRelationFilter(event.target.value)
                      }
                      className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-blue-500"
                    >
                      <option value="all">All categories</option>

                      {relationTypes.map((relation) => (
                        <option key={relation} value={relation}>
                          {humanize(relation)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="text-xs font-medium text-slate-500">
                    {generatedSqlCount} of {rules.length} rules have SQL
                    available. SQL is not validated.
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={showOnlySelected}
                        onChange={(event) =>
                          setShowOnlySelected(event.target.checked)
                        }
                        className="h-4 w-4 accent-blue-700"
                      />
                      Show selected only
                    </label>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-2 text-xs text-slate-400">
                        {visibleRules.length} matching
                      </span>

                      <button
                        type="button"
                        disabled={
                          visibleRules.length === 0 || allVisibleSelected
                        }
                        onClick={selectFiltered}
                        className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-bold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Select filtered
                      </button>

                      <button
                        type="button"
                        disabled={
                          !visibleRules.some((rule) => selectedIds.has(rule.id))
                        }
                        onClick={clearFiltered}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Unselect filtered
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              {/* Rule list and inspector */}
              <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(290px,360px)]">
                <section aria-label="Recommendation list" className="space-y-3">
                  {visibleRules.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-12 text-center">
                      <Search size={27} className="mx-auto text-slate-400" />

                      <h3 className="mt-3 font-semibold text-slate-800">
                        {rules.length === 0
                          ? "No recommendations available"
                          : "No matching rules"}
                      </h3>

                      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500">
                        {rules.length === 0
                          ? "This run has no available rule records. Check its Pipeline for branch status."
                          : "Try removing a search term or changing filters."}
                      </p>

                      {hasFilters && (
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="mt-4 text-xs font-semibold text-blue-700 hover:underline"
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  ) : (
                    visibleRules.map((rule) => (
                      <RuleCard
                        key={rule.id}
                        rule={rule}
                        checked={selectedIds.has(rule.id)}
                        focused={inspectedId === rule.id}
                        onToggle={toggleRule}
                        onInspect={setInspectedId}
                        onEditSql={setEditingRuleId}
                        currentSql={currentSql(rule)}
                      />
                    ))
                  )}
                </section>

                <RuleInspector
                  rule={inspectedRule}
                  currentSql={inspectedRule ? currentSql(inspectedRule) : ""}
                  onSqlChange={(sql) => {
                    if (inspectedRule) {
                      updateSql(inspectedRule, sql);
                    }
                  }}
                  onRestoreSql={() => {
                    if (inspectedRule) {
                      restoreSql(inspectedRule);
                    }
                  }}
                  selected={
                    inspectedRule ? selectedIds.has(inspectedRule.id) : false
                  }
                  onToggle={toggleRule}
                  onClear={() => setInspectedId(null)}
                />
              </div>

              {/* Missing saved rule IDs */}
              {staleIdsCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <span>
                    {staleIdsCount} previously selected rule ID(s) are not
                    present in the current response and will not be exported.
                  </span>

                  <button
                    type="button"
                    onClick={() => updateSelection(new Set(selectedIds))}
                    className="font-bold hover:underline"
                  >
                    Discard missing selections
                  </button>
                </div>
              )}

              {/* Review/export actions remain below inspector */}
              <section className="rounded-2xl border border-[#274d87] bg-[#111e35] p-4 text-white shadow-xl shadow-slate-500/20 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/20 text-blue-200">
                      {selectedRules.length > 0 ? (
                        <Check size={23} />
                      ) : (
                        <ClipboardList size={23} />
                      )}
                    </div>

                    <div>
                      <p className="text-sm font-bold">
                        {selectedRules.length} rule
                        {selectedRules.length === 1 ? "" : "s"} selected
                      </p>

                      <p className="text-xs text-slate-300">
                        {scopedRun
                          ? "Review changes are saved when you press Save Review"
                          : "Legacy selection stored locally"}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={selectedRules.length === 0}
                      onClick={clearAll}
                      className="inline-flex items-center gap-1 rounded-lg px-3 py-2.5 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <X size={15} />
                      Clear all
                    </button>

                    <button
                      type="button"
                      disabled={selectedRules.length === 0}
                      onClick={() =>
                        exportSelection(runId, selectedExportRules, "csv")
                      }
                      className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-xs font-bold text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download size={16} />
                      Export CSV
                    </button>

                    <button
                      type="button"
                      disabled={selectedWithSql === 0}
                      onClick={() =>
                        exportSelection(runId, selectedExportRules, "sql")
                      }
                      className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-xs font-bold text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Export selected SQL drafts; SQL is unverified"
                    >
                      <Download size={16} />
                      Export SQL ({selectedWithSql})
                    </button>

                    <button
                      type="button"
                      disabled={selectedRules.length === 0}
                      onClick={() =>
                        exportSelection(runId, selectedExportRules, "json")
                      }
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download size={16} />
                      Export JSON
                    </button>

                    {scopedRun && (
                      <button
                        type="button"
                        disabled={reviewSaving || !reviewReady}
                        onClick={() => void saveBackendReview()}
                        className="inline-flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-40"
                      >
                        {reviewSaving ? (
                          <LoaderCircle size={16} className="animate-spin" />
                        ) : (
                          <CheckCheck size={16} />
                        )}
                        Save Review
                      </button>
                    )}
                  </div>
                </div>
              </section>

              {reviewError && (
                <p
                  role="alert"
                  className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
                >
                  {reviewError}
                </p>
              )}

              {reviewMessage && (
                <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
                  {reviewMessage}
                </p>
              )}

              <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
                <Info size={16} className="mt-0.5 shrink-0" />

                <span>
                  JSON and CSV exports include selected rules and reviewed SQL.
                  SQL exports contain only selected rules with SQL. No SQL is
                  executed or validated here.
                  {scopedRun
                    ? " Save Review persists selected rules and SQL to the backend."
                    : " Legacy selections and drafts remain in the browser."}
                </span>
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
