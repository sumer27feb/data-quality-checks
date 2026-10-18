import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams, Link } from "react-router";
import {
  AlertCircle,
  ArrowRight,
  BookOpenText,
  BrainCircuit,
  Check,
  ChevronRight,
  ClipboardCopy,
  Code2,
  Database,
  FileCode2,
  GitBranch,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Table2,
  BarChart3,
  Info,
} from "lucide-react";
import { runsApi } from "@/features/runs/api";
import {
  profilesApi,
  type ProfileSources,
  type TableProfile,
} from "@/features/profiles/api";
import ColumnDetail from "@/features/profiles/ColumnDetail";

const LAST_RUN_KEY = "dq-studio:latest-run-id";
type View =
  | "statistics"
  | "semantics"
  | "discovery"
  | "consolidated"
  | "relationships";

const views: { id: View; label: string; icon: typeof Database }[] = [
  { id: "statistics", label: "Statistics", icon: BarChart3 },
  { id: "semantics", label: "Semantics", icon: BrainCircuit },
  { id: "discovery", label: "Discovery", icon: Search },
  { id: "consolidated", label: "Consolidated", icon: FileCode2 },
  { id: "relationships", label: "Relationships", icon: GitBranch },
];
const evidenceTypes: { key: keyof ProfileSources; label: string }[] = [
  { key: "discovery", label: "D" },
  { key: "statistical", label: "S" },
  { key: "semantic", label: "M" },
  { key: "consolidated", label: "C" },
];
function readable(n: number | null | undefined) {
  return typeof n === "number" ? n.toLocaleString() : "—";
}
function pretty(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected request error";
}
function EmptyPanel({ title, details }: { title: string; details: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
      <Info size={24} className="mx-auto text-slate-400" />
      <h3 className="mt-3 font-semibold text-slate-800">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500">
        {details}
      </p>
    </div>
  );
}
function SummaryCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: number | string | null | undefined;
  subtitle: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-slate-900">
        {typeof value === "number" ? readable(value) : (value ?? "—")}
      </p>
      <p className="mt-1 text-xs text-slate-400">{subtitle}</p>
    </div>
  );
}
function AvailabilityDots({ available }: { available: ProfileSources }) {
  return (
    <div
      className="flex gap-1"
      aria-label="Generated artifacts: discovery, statistics, semantics, consolidated"
    >
      {evidenceTypes.map(({ key, label }) => (
        <span
          key={key}
          title={`${pretty(key)}: ${available[key] ? "available" : "not yet available"}`}
          className={`flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${available[key] ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-300"}`}
        >
          {label}
        </span>
      ))}
    </div>
  );
}
function ColumnList({
  profile,
  mode,
  selected,
  onSelect,
}: {
  profile: TableProfile;
  mode: "statistics" | "semantics";
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const names =
    mode === "statistics"
      ? Object.keys(profile.statistical?.columns ?? {})
      : Object.keys(profile.semantic?.columns ?? {});
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h3 className="font-semibold text-slate-900">Columns</h3>
        <span className="text-xs text-slate-500">
          {names.length} in {mode}
        </span>
      </div>
      <div className="max-h-185 overflow-y-auto p-2">
        {names.map((name) => {
          const stat = profile.statistical?.columns[name];
          const semantic = profile.semantic?.columns[name];
          const active = name === selected;
          return (
            <button
              type="button"
              key={name}
              onClick={() => onSelect(name)}
              className={`mb-1 flex w-full items-start justify-between gap-2 rounded-xl px-3 py-3 text-left transition-colors ${active ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-slate-50"}`}
            >
              <span className="min-w-0">
                <span
                  className={`block truncate font-mono text-sm font-semibold ${active ? "text-blue-800" : "text-slate-800"}`}
                >
                  {name}
                </span>
                <span className="mt-1 block truncate text-xs text-slate-500">
                  {mode === "statistics"
                    ? (stat?.physical_type ?? "Type unavailable")
                    : (semantic?.description ?? "Description unavailable")}
                </span>
              </span>
              <ChevronRight
                size={16}
                className={`mt-1 shrink-0 ${active ? "text-blue-700" : "text-slate-300"}`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
function ArtifactYaml({ content, label }: { content: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copyYaml() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <Code2 size={18} className="text-blue-700" />
          <div>
            <h3 className="font-semibold text-slate-900">{label}</h3>
            <p className="text-xs text-slate-500">
              Exact generated YAML, read-only
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void copyYaml()}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {copied ? <Check size={15} /> : <ClipboardCopy size={15} />}
          {copied ? "Copied" : "Copy YAML"}
        </button>
      </div>
      <pre className="max-h-165 overflow-auto bg-[#111e35] p-6 font-mono text-xs leading-6 text-blue-100">
        <code>{content}</code>
      </pre>
    </div>
  );
}

export default function ProfilesPage() {
  const [params, setParams] = useSearchParams();
  const urlRun = params.get("run");
  const [localRun, setLocalRun] = useState<string | null>(() =>
    localStorage.getItem(LAST_RUN_KEY),
  );
  const runId = urlRun || localRun;
  const [view, setView] = useState<View>("statistics");
  const [filter, setFilter] = useState("");
  const [tableSelection, setTableSelection] = useState<string | null>(null);
  const [columnSelection, setColumnSelection] = useState<string | null>(null);

  const historyQuery = useQuery({
    queryKey: ["run-history"],
    queryFn: ({ signal }) => runsApi.listRuns(signal),
    retry: 1,
  });
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: ({ signal }) => runsApi.getRun(runId!, signal),
    enabled: !!runId,
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "queued" || s === "running" || !s ? 2500 : false;
    },
  });
  const active =
    runQuery.data?.status === "running" || runQuery.data?.status === "queued";
  const indexQuery = useQuery({
    queryKey: ["profiles-index", runId],
    queryFn: ({ signal }) => profilesApi.list(runId!, signal),
    enabled: !!runId,
    retry: 1,
    refetchInterval: active ? 4000 : false,
  });
  const tableEntries = indexQuery.data?.tables ?? [];
  const selectedTable =
    tableSelection && tableEntries.some((t) => t.table_name === tableSelection)
      ? tableSelection
      : (tableEntries[0]?.table_name ?? null);
  const detailQuery = useQuery({
    queryKey: ["table-profile", runId, selectedTable],
    queryFn: ({ signal }) =>
      profilesApi.getTable(runId!, selectedTable!, signal),
    enabled: !!runId && !!selectedTable && view !== "relationships",
    retry: 1,
    refetchInterval: active && view !== "relationships" ? 4000 : false,
  });
  const relationsQuery = useQuery({
    queryKey: ["profile-relationships", runId],
    queryFn: ({ signal }) => profilesApi.getRelationships(runId!, signal),
    enabled: !!runId && view === "relationships",
    retry: 1,
    refetchInterval: active && view === "relationships" ? 4000 : false,
  });
  const profile = detailQuery.data;
  const visibleTables = tableEntries.filter((item) =>
    item.table_name.toLowerCase().includes(filter.toLowerCase()),
  );
  const columnNames =
    view === "semantics"
      ? Object.keys(profile?.semantic?.columns ?? {})
      : Object.keys(profile?.statistical?.columns ?? {});
  const selectedColumn =
    columnSelection && columnNames.includes(columnSelection)
      ? columnSelection
      : (columnNames[0] ?? null);
  const stat = profile?.statistical;
  const semantic = profile?.semantic;
  const available = tableEntries.find(
    (entry) => entry.table_name === selectedTable,
  )?.available;

  function selectRun(id: string) {
    setParams({ run: id });
    localStorage.setItem(LAST_RUN_KEY, id);
    setLocalRun(id);
    setTableSelection(null);
    setColumnSelection(null);
  }

  useEffect(() => {
    if (urlRun) localStorage.setItem(LAST_RUN_KEY, urlRun);
  }, [urlRun]);

  return (
    <div className="space-y-6 pb-12">
      <header className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700">
            <Layers3 size={17} /> Data intelligence
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">
            Dataset Profiles
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            Explore discovered schemas, measured statistics, inferred business
            meaning, and the exact artifacts generated for a run.
          </p>
        </div>
        <div className="min-w-0 lg:w-80">
          <label
            htmlFor="profile-run"
            className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500"
          >
            Analysis run
          </label>
          <select
            id="profile-run"
            value={runId ?? ""}
            onChange={(e) => {
              if (e.target.value) selectRun(e.target.value);
            }}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 font-mono text-xs text-slate-800 shadow-sm outline-none focus:border-blue-500"
          >
            {!runId && <option value="">Select a run</option>}
            {runId &&
              !historyQuery.data?.runs.some(
                (item) => item.run_id === runId,
              ) && (
                <option value={runId}>{runId.slice(0, 12)}… (selected)</option>
              )}
            {historyQuery.data?.runs.map((item) => (
              <option key={item.run_id} value={item.run_id}>
                {item.run_id.slice(0, 12)}… · {item.status}
              </option>
            ))}
          </select>
        </div>
      </header>

      {!runId && (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
          <Database className="mx-auto text-blue-500" size={30} />
          <h2 className="mt-3 text-lg font-semibold">Choose an analysis run</h2>
          <p className="mt-1 text-sm text-slate-500">
            Select an existing run above or{" "}
            <Link
              className="font-semibold text-blue-700 hover:underline"
              to="/"
            >
              start an analysis from Overview
            </Link>
            .
          </p>
        </div>
      )}

      {runId && runQuery.isError && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          Unable to load run: {errorMessage(runQuery.error)}. Select another run
          or retry.
        </div>
      )}
      {runId && indexQuery.isError && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <span>
            Unable to load profile inventory: {errorMessage(indexQuery.error)}
          </span>
          <button
            type="button"
            onClick={() => void indexQuery.refetch()}
            className="flex shrink-0 items-center gap-1 font-semibold hover:underline"
          >
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      )}

      {runId && runQuery.data && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="font-semibold uppercase tracking-wide text-slate-500">
              Selected run
            </span>
            <span className="font-mono text-slate-800">{runId}</span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize ${runQuery.data.status === "completed" ? "bg-emerald-50 text-emerald-700" : active ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-600"}`}
            >
              {runQuery.data.status}
            </span>
            <Link
              to={`/pipeline?run=${encodeURIComponent(runId)}`}
              className="flex items-center gap-1 text-xs font-semibold text-blue-700 hover:underline"
            >
              View pipeline <ArrowRight size={14} />
            </Link>
          </div>
          {runQuery.data.status === "archived" && (
            <p className="w-full text-xs text-slate-500">
              This run is archived. Artifact availability is known; the original
              execution status is not.
            </p>
          )}
        </div>
      )}

      {runId && !indexQuery.isError && (
        <>
          <section className="grid gap-3 sm:grid-cols-3">
            <SummaryCard
              label="Tables with artifacts"
              value={indexQuery.data?.tables.length}
              subtitle="Discovered from this run's files"
            />
            <SummaryCard
              label="Statistical profiles"
              value={
                indexQuery.data?.tables.filter((t) => t.available.statistical)
                  .length
              }
              subtitle="JSON profile files available"
            />
            <SummaryCard
              label="Semantic profiles"
              value={
                indexQuery.data?.tables.filter((t) => t.available.semantic)
                  .length
              }
              subtitle="LLM-generated profile files available"
            />
          </section>

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm">
            <div className="flex min-w-max gap-1">
              {views.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    type="button"
                    key={tab.id}
                    onClick={() => setView(tab.id)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors ${view === tab.id ? "bg-[#244a82] text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {indexQuery.isPending && (
            <div className="flex items-center gap-2 rounded-xl bg-white p-5 text-sm text-slate-500">
              <LoaderCircle className="animate-spin" size={17} /> Loading
              available profiles...
            </div>
          )}

          {view === "relationships" ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center gap-2">
                  <GitBranch size={19} className="text-blue-700" />
                  <h2 className="text-lg font-semibold text-slate-900">
                    Declared foreign-key relationships
                  </h2>
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  Relationships supplied in the dataset configuration. These are
                  not inferred referential-integrity test results.
                </p>
              </div>
              {relationsQuery.isPending && (
                <div className="flex gap-2 rounded-xl bg-white p-5 text-sm text-slate-500">
                  <LoaderCircle className="animate-spin" size={17} /> Loading
                  relationships...
                </div>
              )}
              {relationsQuery.isError && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  {errorMessage(relationsQuery.error)}{" "}
                  <button
                    type="button"
                    onClick={() => void relationsQuery.refetch()}
                    className="ml-2 font-semibold underline"
                  >
                    Retry
                  </button>
                </div>
              )}
              {relationsQuery.data && (
                <>
                  <div className="grid gap-3 md:grid-cols-2">
                    {relationsQuery.data.foreign_keys.map((fk, index) => (
                      <div
                        key={`${fk.from_table}-${fk.from_column}-${fk.to_table}-${index}`}
                        className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                            Foreign key
                          </span>
                          {fk.cardinality && (
                            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-700">
                              {fk.cardinality}
                            </span>
                          )}
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-slate-800">
                              {fk.from_table}
                            </p>
                            <p className="truncate font-mono text-xs text-slate-500">
                              {fk.from_column}
                            </p>
                          </div>
                          <ArrowRight
                            size={19}
                            className="shrink-0 text-blue-500"
                          />
                          <div className="min-w-0 flex-1 text-right">
                            <p className="truncate font-semibold text-slate-800">
                              {fk.to_table}
                            </p>
                            <p className="truncate font-mono text-xs text-slate-500">
                              {fk.to_column}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {relationsQuery.data.foreign_keys.length === 0 && (
                    <EmptyPanel
                      title="No declared foreign keys"
                      details={
                        relationsQuery.data.configuration_available
                          ? "The relationship configuration contains no foreign keys."
                          : "No relationships configuration artifact is available for this run."
                      }
                    />
                  )}
                  {relationsQuery.data.inter_table_yaml && (
                    <ArtifactYaml
                      content={relationsQuery.data.inter_table_yaml}
                      label="Inter-table consolidated profile"
                    />
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="grid items-start gap-5 lg:grid-cols-[245px_minmax(0,1fr)]">
              <aside className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2">
                  <Table2 size={19} className="text-blue-700" />
                  <h2 className="font-semibold text-slate-900">Tables</h2>
                  <span className="ml-auto text-xs text-slate-500">
                    {tableEntries.length}
                  </span>
                </div>
                <div className="relative mt-4">
                  <Search
                    size={16}
                    className="absolute left-3 top-3 text-slate-400"
                  />
                  <input
                    aria-label="Search tables"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Search tables..."
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"
                  />
                </div>
                <div className="mt-3 max-h-167.5 space-y-1 overflow-y-auto">
                  {visibleTables.map((table) => (
                    <button
                      type="button"
                      key={table.table_name}
                      onClick={() => {
                        setTableSelection(table.table_name);
                        setColumnSelection(null);
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-3 text-left text-sm transition-colors ${selectedTable === table.table_name ? "bg-blue-50 font-semibold text-blue-800 ring-1 ring-blue-200" : "text-slate-700 hover:bg-slate-50"}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate">
                          {table.table_name}
                        </span>
                        <span className="mt-1.5 block">
                          <AvailabilityDots available={table.available} />
                        </span>
                      </span>
                      <ChevronRight
                        size={16}
                        className="shrink-0 text-slate-400"
                      />
                    </button>
                  ))}
                  {!visibleTables.length && (
                    <p className="p-3 text-xs text-slate-500">
                      No matching tables found.
                    </p>
                  )}
                </div>
                <p className="mt-4 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-400">
                  D = Discovery · S = Statistics · M = Semantics · C =
                  Consolidated. Green indicates an artifact exists.
                </p>
              </aside>
              <div className="min-w-0 space-y-5">
                {selectedTable && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                          Selected table
                        </p>
                        <h2 className="mt-1 break-all text-2xl font-bold tracking-tight text-slate-900">
                          {selectedTable}
                        </h2>
                      </div>
                      {available && <AvailabilityDots available={available} />}
                    </div>
                    {semantic?.table_semantics?.description && (
                      <p className="mt-3 text-sm leading-6 text-slate-600">
                        {semantic.table_semantics.description}
                      </p>
                    )}
                    {semantic?.table_semantics && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {semantic.table_semantics.business_entity && (
                          <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
                            Entity: {semantic.table_semantics.business_entity}
                          </span>
                        )}
                        {semantic.table_semantics.row_grain && (
                          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                            Grain: {semantic.table_semantics.row_grain}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {detailQuery.isPending && selectedTable && (
                  <div className="flex items-center gap-2 rounded-xl bg-white p-5 text-sm text-slate-500">
                    <LoaderCircle size={17} className="animate-spin" /> Loading{" "}
                    {selectedTable} profile...
                  </div>
                )}
                {detailQuery.isError && (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                    <span>{errorMessage(detailQuery.error)}</span>
                    <button
                      type="button"
                      onClick={() => void detailQuery.refetch()}
                      className="flex items-center gap-1 font-semibold"
                    >
                      <RefreshCw size={15} /> Retry
                    </button>
                  </div>
                )}
                {!selectedTable && !indexQuery.isPending && (
                  <EmptyPanel
                    title="No table profiles yet"
                    details="When discovery or profiling produces artifacts for this run, its tables will appear here."
                  />
                )}

                {selectedTable && profile && view === "discovery" && (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <SummaryCard
                        label="Discovered columns"
                        value={profile.discovery?.columns.length}
                        subtitle="Unity Catalog metadata"
                      />
                      <SummaryCard
                        label="Configured columns"
                        value={profile.config?.columns.length}
                        subtitle="Dataset configuration"
                      />
                      <SummaryCard
                        label="Column mismatches"
                        value={
                          profile.discovery
                            ? profile.column_mismatches.length
                            : null
                        }
                        subtitle="Compared column names"
                      />
                    </div>
                    {profile.column_mismatches.length > 0 && (
                      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        {profile.column_mismatches.map((issue, index) => (
                          <p key={`${issue.column}-${index}`}>
                            {issue.column}: {pretty(issue.issue)}
                          </p>
                        ))}
                      </div>
                    )}
                    {profile.discovery && (
                      <p className="break-all rounded-xl bg-blue-50 p-3 font-mono text-xs text-blue-900">
                        {profile.discovery.full_name}
                      </p>
                    )}
                    {profile.config?.primary_key && (
                      <p className="flex items-start gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                        <ShieldCheck
                          size={17}
                          className="shrink-0 text-blue-700"
                        />
                        Declared primary key:{" "}
                        <span className="font-mono font-semibold">
                          {profile.config.primary_key.join(", ")}
                        </span>
                      </p>
                    )}
                    {profile.discovery || profile.config ? (
                      <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                        <table className="w-full min-w-140 text-left text-sm">
                          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="px-4 py-3">Column</th>
                              <th className="px-4 py-3">Configured type</th>
                              <th className="px-4 py-3">Nullable</th>
                              <th className="px-4 py-3">Discovered</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {Array.from(
                              new Set([
                                ...(profile.discovery?.columns.map(
                                  (c) => c.name,
                                ) ?? []),
                                ...(profile.config?.columns.map(
                                  (c) => c.name,
                                ) ?? []),
                              ]),
                            ).map((name) => {
                              const cfg = profile.config?.columns.find(
                                (c) => c.name === name,
                              );
                              const found = profile.discovery?.columns.some(
                                (c) => c.name === name,
                              );
                              return (
                                <tr key={name}>
                                  <td className="px-4 py-3 font-mono font-medium text-slate-800">
                                    {name}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-xs text-slate-600">
                                    {cfg?.datatype ?? "—"}
                                  </td>
                                  <td className="px-4 py-3 text-slate-600">
                                    {cfg?.nullable === true
                                      ? "Yes"
                                      : cfg?.nullable === false
                                        ? "No"
                                        : "—"}
                                  </td>
                                  <td className="px-4 py-3">
                                    {found ? (
                                      <span className="font-medium text-emerald-700">
                                        Yes
                                      </span>
                                    ) : (
                                      <span className="text-slate-400">No</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyPanel
                        title="Discovery artifacts unavailable"
                        details="This run has not produced table discovery or configuration files for the selected table."
                      />
                    )}
                  </div>
                )}

                {selectedTable &&
                  profile &&
                  (view === "statistics" || view === "semantics") && (
                    <div className="space-y-4">
                      {view === "statistics" && stat && (
                        <div className="grid gap-3 sm:grid-cols-3">
                          <SummaryCard
                            label="Rows profiled"
                            value={stat.row_count}
                            subtitle="Aggregate count in profile"
                          />
                          <SummaryCard
                            label="Columns profiled"
                            value={stat.column_count}
                            subtitle="Statistical profile"
                          />
                          <SummaryCard
                            label="Datatype matches"
                            value={
                              Object.values(stat.columns).filter(
                                (col) =>
                                  col.expected_type === col.physical_type,
                              ).length
                            }
                            subtitle="Expected equals physical"
                          />
                        </div>
                      )}
                      {view === "semantics" && semantic && (
                        <div className="grid gap-3 sm:grid-cols-3">
                          <SummaryCard
                            label="Semantic columns"
                            value={Object.keys(semantic.columns).length}
                            subtitle="LLM-inferred profiles"
                          />
                          <SummaryCard
                            label="Business entity"
                            value={semantic.table_semantics.business_entity}
                            subtitle="Inferred table semantics"
                          />
                          <SummaryCard
                            label="Row grain"
                            value={semantic.table_semantics.row_grain}
                            subtitle="Inferred record meaning"
                          />
                        </div>
                      )}
                      {(view === "statistics" && stat) ||
                      (view === "semantics" && semantic) ? (
                        <div className="grid items-start gap-4 xl:grid-cols-[minmax(260px,1fr)_minmax(300px,1.08fr)]">
                          <ColumnList
                            profile={profile}
                            mode={view}
                            selected={selectedColumn}
                            onSelect={setColumnSelection}
                          />
                          {selectedColumn && (
                            <ColumnDetail
                              key={`${selectedTable}-${selectedColumn}`}
                              name={selectedColumn}
                              rowCount={stat?.row_count ?? null}
                              statistical={stat?.columns[selectedColumn]}
                              semantic={semantic?.columns[selectedColumn]}
                            />
                          )}
                        </div>
                      ) : (
                        <EmptyPanel
                          title={
                            view === "statistics"
                              ? "Statistical profile not available"
                              : "Semantic profile not available"
                          }
                          details="This stage has not generated a profile artifact for the selected table. If the run is active, the page will update when a file is available."
                        />
                      )}
                    </div>
                  )}
                {selectedTable &&
                  profile &&
                  view === "consolidated" &&
                  (profile.consolidated_yaml ? (
                    <ArtifactYaml
                      key={selectedTable}
                      content={profile.consolidated_yaml}
                      label={`${selectedTable}.yaml`}
                    />
                  ) : (
                    <EmptyPanel
                      title="Consolidated YAML not available"
                      details="The table consolidation stage has not produced this profile artifact."
                    />
                  ))}
              </div>
            </div>
          )}
        </>
      )}
      <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
        <BookOpenText size={15} className="mt-0.5 shrink-0" /> Statistics are
        read from saved aggregate profiles. Semantic descriptions are generated
        interpretations. No data quality rules are executed by this page.
      </p>
    </div>
  );
}
