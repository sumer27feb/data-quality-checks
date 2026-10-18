import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
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
  type ImpactLevel,
  type RuleScope,
} from "@/features/recommendations/api";
import { exportSelection } from "@/features/recommendations/export";
import RuleCard, { humanize } from "@/features/recommendations/RuleCard";
import RuleInspector from "@/features/recommendations/RuleInspector";

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
    const value: unknown = JSON.parse(
      localStorage.getItem(SELECTION_PREFIX + runId) || "[]",
    );
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
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
  const [params, setParams] = useSearchParams();
  const urlRunId = params.get("run");
  const [locallySelectedRun, setLocallySelectedRun] = useState<string | null>(
    () => localStorage.getItem(LAST_RUN_KEY),
  );
  const runId = urlRunId || locallySelectedRun;

  const [scope, setScope] = useState<ScopeFilter>("all");
  const [search, setSearch] = useState("");
  const [tableFilter, setTableFilter] = useState("all");
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>("all");
  const [relationFilter, setRelationFilter] = useState("all");
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [sessionSelections, setSessionSelections] = useState<{
    runId: string | null;
    ids: string[];
  }>(() => ({
    runId: localStorage.getItem(LAST_RUN_KEY),
    ids: savedSelections(localStorage.getItem(LAST_RUN_KEY)),
  }));

  const historyQuery = useQuery({
    queryKey: ["run-history"],
    queryFn: ({ signal }) => runsApi.listRuns(signal),
    retry: 1,
  });
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => runsApi.getRun(runId!, signal),
    enabled: Boolean(runId),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "queued" || status === "running") return 2500;
      return false;
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

  const data = recommendationsQuery.data;
  const rules = useMemo(
    () => (data ? normalizeRecommendations(data) : []),
    [data],
  );
  const knownIds = useMemo(() => new Set(rules.map((r) => r.id)), [rules]);
  const savedIds =
    sessionSelections.runId === runId
      ? sessionSelections.ids
      : savedSelections(runId);
  const selectedIds = useMemo(
    () => new Set(savedIds.filter((id) => knownIds.has(id))),
    [savedIds, knownIds],
  );
  const staleIdsCount = savedIds.length - selectedIds.size;

  const scopeCounts = useMemo(
    () => ({
      all: rules.length,
      individual: rules.filter((rule) => rule.scope === "individual").length,
      inter_table: rules.filter((rule) => rule.scope === "inter_table").length,
    }),
    [rules],
  );
  const tableNames = useMemo(
    () =>
      Array.from(
        new Set(rules.filter((r) => r.table_name).map((r) => r.table_name!)),
      ).sort(),
    [rules],
  );
  const relationTypes = useMemo(
    () =>
      Array.from(
        new Set(
          rules
            .map((r) => r.proposed_relation)
            .filter((r): r is string => Boolean(r)),
        ),
      ).sort(),
    [rules],
  );
  const impactCounts = useMemo(
    () => ({
      high: rules.filter((r) => r.impact.level === "high").length,
      medium: rules.filter((r) => r.impact.level === "medium").length,
      low: rules.filter((r) => r.impact.level === "low").length,
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

  const selectedRules = useMemo(
    () => rules.filter((r) => selectedIds.has(r.id)),
    [rules, selectedIds],
  );
  const inspectedRule = rules.find((rule) => rule.id === inspectedId) ?? null;
  const allVisibleSelected =
    visibleRules.length > 0 && visibleRules.every((r) => selectedIds.has(r.id));
  const hasFilters = Boolean(
    search ||
    scope !== "all" ||
    tableFilter !== "all" ||
    impactFilter !== "all" ||
    relationFilter !== "all" ||
    showOnlySelected,
  );

  function updateSelection(next: Set<string>) {
    if (!runId) return;
    const ids = [...next];
    localStorage.setItem(SELECTION_PREFIX + runId, JSON.stringify(ids));
    setSessionSelections({ runId, ids });
  }
  function toggleRule(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    updateSelection(next);
  }
  function selectFiltered() {
    const next = new Set(selectedIds);
    for (const rule of visibleRules) next.add(rule.id);
    updateSelection(next);
  }
  function clearFiltered() {
    const next = new Set(selectedIds);
    for (const rule of visibleRules) next.delete(rule.id);
    updateSelection(next);
  }
  function clearAll() {
    updateSelection(new Set());
  }
  function changeRun(id: string) {
    setParams({ run: id });
    localStorage.setItem(LAST_RUN_KEY, id);
    setLocallySelectedRun(id);
    setInspectedId(null);
    setShowOnlySelected(false);
    setSearch("");
    setScope("all");
    setTableFilter("all");
    setImpactFilter("all");
    setRelationFilter("all");
  }
  function resetFilters() {
    setScope("all");
    setTableFilter("all");
    setImpactFilter("all");
    setRelationFilter("all");
    setSearch("");
    setShowOnlySelected(false);
  }

  return (
    <div className="space-y-6 pb-28">
      <header className="flex flex-col justify-between gap-5 xl:flex-row xl:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700">
            <Sparkles size={17} /> AI-assisted data quality
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Rule Recommendations
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Review proposed data-quality checks, choose which to keep, and
            export a curated rule collection for downstream use.
          </p>
        </div>
        <div className="w-full xl:w-80">
          <label
            htmlFor="recommendations-run"
            className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500"
          >
            Analysis run
          </label>
          <div className="relative">
            <select
              id="recommendations-run"
              value={runId ?? ""}
              onChange={(event) =>
                event.target.value && changeRun(event.target.value)
              }
              className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-3 pl-3 pr-9 font-mono text-xs text-slate-800 shadow-sm outline-none focus:border-blue-500"
            >
              {!runId && <option value="">Select a run</option>}
              {runId &&
                !historyQuery.data?.runs.some((r) => r.run_id === runId) && (
                  <option value={runId}>
                    {runId.slice(0, 12)}… · current selection
                  </option>
                )}
              {historyQuery.data?.runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_id.slice(0, 12)}… · {r.status}
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
            Choose an analysis run
          </h2>
          <p className="mt-2 text-sm text-slate-500">
            Select a run above or{" "}
            <Link
              to="/"
              className="font-semibold text-blue-700 hover:underline"
            >
              start an analysis on Overview
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
            <Link
              to={`/pipeline?run=${encodeURIComponent(runId)}`}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:underline"
            >
              Open pipeline <ArrowRight size={14} />
            </Link>
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
              <LoaderCircle size={19} className="animate-spin text-blue-600" />{" "}
              Loading recommendations for this run…
            </div>
          )}
          {recommendationsQuery.isError && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800"
            >
              <span className="inline-flex items-center gap-2">
                <AlertCircle size={18} />{" "}
                {messageFor(recommendationsQuery.error)}
              </span>
              <button
                type="button"
                onClick={() => void recommendationsQuery.refetch()}
                className="inline-flex items-center gap-1.5 font-bold hover:underline"
              >
                <RefreshCw size={15} /> Retry
              </button>
            </div>
          )}

          {data && (
            <>
              <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  label="Available rules"
                  value={rules.length}
                  footnote="Loaded from generated recommendation files"
                  icon={ClipboardList}
                />
                <StatCard
                  label="Selected to keep"
                  value={selectedRules.length}
                  footnote="Locally curated for this run"
                  icon={CheckCheck}
                />
                <StatCard
                  label="High impact"
                  value={impactCounts.high}
                  footnote="Impact assigned by the recommender"
                  icon={ShieldCheck}
                />
                <StatCard
                  label="Cross-table rules"
                  value={
                    data.available.inter_table ? scopeCounts.inter_table : "—"
                  }
                  footnote={
                    data.available.inter_table
                      ? "Recommendation output available"
                      : "Branch output not available yet"
                  }
                  icon={GitBranch}
                />
              </section>

              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col justify-between gap-5 p-5 md:flex-row md:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <CheckCheck size={18} className="text-blue-700" /> Review
                      progress
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {selectedRules.length} of {rules.length} available rules
                      selected · saved in this browser, scoped to this run
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
                          width: `${rules.length ? (100 * selectedRules.length) / rules.length : 0}%`,
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
                              width: `${(impactCounts.high / rules.length) * 100}%`,
                            }}
                          />
                          <div
                            className="bg-amber-400"
                            style={{
                              width: `${(impactCounts.medium / rules.length) * 100}%`,
                            }}
                          />
                          <div
                            className="bg-sky-400"
                            style={{
                              width: `${(impactCounts.low / rules.length) * 100}%`,
                            }}
                          />
                        </>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-1 text-[11px] text-slate-500">
                      <span>🔴 High {impactCounts.high}</span>
                      <span>🟠 Medium {impactCounts.medium}</span>
                      <span>🔵 Low {impactCounts.low}</span>
                    </div>
                  </div>
                </div>
              </section>

              {(!data.available.individual || !data.available.inter_table) && (
                <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <div>
                    Outputs not yet available:
                    {!data.available.individual && (
                      <span className="ml-1 font-semibold">
                        individual-table
                      </span>
                    )}
                    {!data.available.individual &&
                      !data.available.inter_table &&
                      ","}
                    {!data.available.inter_table && (
                      <span className="ml-1 font-semibold">inter-table</span>
                    )}
                    . Only currently available recommendations are displayed.
                  </div>
                </div>
              )}

              <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-4 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">
                        Explore recommendations
                      </h2>
                      <p className="mt-1 text-xs text-slate-500">
                        Filter and inspect before selecting the rules to keep.
                      </p>
                    </div>
                    {hasFilters && (
                      <button
                        type="button"
                        onClick={resetFilters}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-blue-700"
                      >
                        <FilterX size={16} /> Reset filters
                      </button>
                    )}
                  </div>

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
                      ] as { id: ScopeFilter; label: string; value: number }[]
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
                        className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors ${scope === tab.id ? "bg-white text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                      >
                        {tab.label}{" "}
                        <span className="ml-1 tabular-nums opacity-70">
                          {tab.value}
                        </span>
                      </button>
                    ))}
                  </div>

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
                        placeholder="Search rule, SQL, impact…"
                        aria-label="Search recommendations"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-blue-500 focus:bg-white"
                      />
                    </label>
                    <select
                      aria-label="Filter by table"
                      value={scope === "inter_table" ? "all" : tableFilter}
                      disabled={scope === "inter_table"}
                      onChange={(e) => setTableFilter(e.target.value)}
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
                      onChange={(e) =>
                        setImpactFilter(e.target.value as ImpactFilter)
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
                      onChange={(e) => setRelationFilter(e.target.value)}
                      className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-blue-500"
                    >
                      <option value="all">All categories</option>
                      {relationTypes.map((name) => (
                        <option key={name} value={name}>
                          {humanize(name)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                    <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={showOnlySelected}
                        onChange={(e) => setShowOnlySelected(e.target.checked)}
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
                          !visibleRules.some((r) => selectedIds.has(r.id))
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
                          ? data.available.individual &&
                            data.available.inter_table
                            ? "Both recommendation outputs are available, but no rules were returned."
                            : "The selected run has no currently available rule records. Check its pipeline for branch status."
                          : "Try removing a search term or changing the filters."}
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
                      />
                    ))
                  )}
                </section>
                <RuleInspector
                  rule={inspectedRule}
                  selected={
                    inspectedRule ? selectedIds.has(inspectedRule.id) : false
                  }
                  onToggle={toggleRule}
                  onClear={() => setInspectedId(null)}
                />
              </div>

              {staleIdsCount > 0 && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                  <span>
                    {staleIdsCount} previously selected rule ID(s) are not
                    present in the current API response. They are excluded from
                    export.
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

              <section className="sticky bottom-4 z-30 rounded-2xl border border-[#274d87] bg-[#111e35] p-4 text-white shadow-xl shadow-slate-500/20 sm:px-5">
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
                        Local review selection · not submitted or executed
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
                      <X size={15} /> Clear all
                    </button>
                    <button
                      type="button"
                      disabled={selectedRules.length === 0}
                      onClick={() =>
                        exportSelection(runId, selectedRules, "csv")
                      }
                      className="inline-flex items-center gap-2 rounded-xl border border-white/20 px-4 py-2.5 text-xs font-bold text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download size={16} /> Export CSV
                    </button>
                    <button
                      type="button"
                      disabled={selectedRules.length === 0}
                      onClick={() =>
                        exportSelection(runId, selectedRules, "json")
                      }
                      className="inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2.5 text-xs font-bold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Download size={16} /> Export JSON
                    </button>
                  </div>
                </div>
              </section>

              <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
                <Info size={16} className="mt-0.5 shrink-0" />
                JSON preserves exact generated predicates and nested metadata
                for future processing. CSV is intended for spreadsheet review
                and applies formula-injection escaping. Selection stays in this
                browser for each run; there is no server-side approval or rule
                execution.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
