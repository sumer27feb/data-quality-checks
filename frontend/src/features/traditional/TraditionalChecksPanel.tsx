import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, LoaderCircle, Save, X } from "lucide-react";
import { profilesApi } from "@/features/profiles/api";
import {
  traditionalChecksApi,
  type TraditionalCheckType,
  type TraditionalChecksResponse,
  type TraditionalSelection,
} from "@/features/recommendations/api";

type Props = {
  runId: string;
  onClose: () => void;
  onSaved: (result: TraditionalChecksResponse) => void;
};

const OPTIONS: { id: TraditionalCheckType; label: string; kind: "any" | "scalar" | "string" | "number" }[] = [
  { id: "not_null", label: "Not null", kind: "any" },
  { id: "unique", label: "Unique", kind: "scalar" },
  { id: "not_blank", label: "Not blank", kind: "string" },
  { id: "trimmed", label: "Trimmed", kind: "string" },
  { id: "non_negative", label: "Non-negative", kind: "number" },
  { id: "positive", label: "Positive", kind: "number" },
  { id: "range", label: "Numeric range", kind: "number" },
  { id: "length", label: "String length", kind: "string" },
  { id: "allowed_values", label: "Allowed values", kind: "string" },
];

function kindOf(datatype: string | null | undefined): "string" | "number" | "scalar" | "unknown" {
  if (!datatype) return "unknown";
  if (/^(?:VAR)?CHAR\b|^STRING\b/i.test(datatype)) return "string";
  if (/^(?:TINYINT|SMALLINT|INT|INTEGER|BIGINT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC|LONG|SHORT)\b/i.test(datatype)) return "number";
  if (/^(?:DATE|TIMESTAMP|BOOLEAN)\b/i.test(datatype)) return "scalar";
  return "unknown";
}
function allowed(kind: string, datatype: string | null | undefined): boolean {
  const t = kindOf(datatype);
  return kind === "any" || (kind === "scalar" && t !== "unknown") || kind === t;
}
function key(s: Pick<TraditionalSelection, "table" | "column" | "check">): string {
  return `${s.table}\u0000${s.column}\u0000${s.check}`;
}
function initialParams(type: TraditionalCheckType): Record<string, unknown> {
  if (type === "allowed_values") return { values: [] };
  return {};
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to save check configuration";
}

export default function TraditionalChecksPanel({ runId, onClose, onSaved }: Props) {
  const [table, setTable] = useState<string>("");
  const [search, setSearch] = useState("");
  const [selections, setSelections] = useState<TraditionalSelection[]>([]);
  const [initialized, setInitialized] = useState(false);
  const configQuery = useQuery({
    queryKey: ["traditional-checks", runId],
    queryFn: ({ signal }) => traditionalChecksApi.get(runId, signal),
    retry: 1,
  });
  const tablesQuery = useQuery({
    queryKey: ["profiles-index", runId],
    queryFn: ({ signal }) => profilesApi.list(runId, signal),
    retry: 1,
  });
  const tables = tablesQuery.data?.tables ?? [];
  const selectedTable = table || tables[0]?.table_name || "";
  const profileQuery = useQuery({
    queryKey: ["table-profile", runId, selectedTable],
    queryFn: ({ signal }) => profilesApi.getTable(runId, selectedTable, signal),
    enabled: !!selectedTable,
    retry: 1,
  });
  const saveMutation = useMutation({
    mutationFn: (next: TraditionalSelection[]) => traditionalChecksApi.save(runId, next),
    onSuccess: onSaved,
  });

  useEffect(() => {
    if (!initialized && configQuery.data) {
      setSelections(configQuery.data.selections);
      setInitialized(true);
    }
  }, [configQuery.data, initialized]);

  const profile = profileQuery.data;
  const cols = (profile?.discovery?.columns ?? []).map((column) => {
    const name = column.name;
    const configured = profile?.config?.columns.find((c) => c.name === name)?.datatype;
    const physical = profile?.statistical?.columns[name]?.physical_type;
    return { name, datatype: physical || configured || null };
  }).filter((col) => col.name.toLowerCase().includes(search.toLowerCase()));
  const selectedKeys = new Set(selections.map(key));

  function toggle(column: string, check: TraditionalCheckType) {
    const id = key({ table: selectedTable, column, check });
    if (selectedKeys.has(id)) setSelections((old) => old.filter((s) => key(s) !== id));
    else setSelections((old) => [...old, {
      table: selectedTable, column, check, params: initialParams(check), impact_level: "medium",
    }]);
  }
  function modify(column: string, check: TraditionalCheckType, params: Record<string, unknown>) {
    setSelections((old) => old.map((s) =>
      s.table === selectedTable && s.column === column && s.check === check
        ? { ...s, params } : s,
    ));
  }
  function editBound(s: TraditionalSelection, bound: "min" | "max", value: string) {
    const next = { ...s.params };
    if (value.trim() === "") delete next[bound];
    else if (s.check === "length") next[bound] = /^\d+$/.test(value) ? Number(value) : value;
    else next[bound] = value;
    modify(s.column, s.check, next);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="presentation">
      <section role="dialog" aria-modal="true" aria-label="Configure traditional data quality checks"
        className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Traditional data quality checks</h2>
            <p className="mt-1 text-xs text-slate-500">Configure multiple checks per column. SQL will return violating rows using SELECT *; nothing is executed.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X size={20}/></button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[215px_minmax(0,1fr)]">
          <aside className="border-b border-slate-200 p-4 md:overflow-y-auto md:border-b-0 md:border-r">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tables</p>
            {tablesQuery.isPending && <p className="text-sm text-slate-400">Loading tables…</p>}
            {tables.map((t) => (
              <button type="button" key={t.table_name} onClick={() => { setTable(t.table_name); setSearch(""); }}
                className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-mono text-xs ${selectedTable === t.table_name ? "bg-blue-50 text-blue-800" : "hover:bg-slate-100"}`}>
                <span>{t.table_name}</span>
                <span className="text-slate-500">{selections.filter((s) => s.table === t.table_name).length}</span>
              </button>
            ))}
          </aside>
          <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold text-slate-800">{selectedTable || "Choose a table"}</div>
              <input type="search" aria-label="Search columns" placeholder="Search columns…" value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500" />
            </div>
            {profileQuery.isPending && <p className="text-sm text-slate-500">Loading columns…</p>}
            {profileQuery.isError && <p role="alert" className="text-sm text-red-700">{message(profileQuery.error)}</p>}
            <div className="space-y-4">
              {cols.map((col) => {
                const active = selections.filter((s) => s.table === selectedTable && s.column === col.name);
                return (
                  <div key={col.name} className="rounded-xl border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-800">{col.name}</span>
                      <span className="text-xs text-slate-500">{col.datatype ?? "Unknown datatype"}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-3">
                      {OPTIONS.map((opt) => (
                        <label key={opt.id} className={`inline-flex items-center gap-1.5 text-xs ${allowed(opt.kind,col.datatype) ? "cursor-pointer text-slate-700" : "cursor-not-allowed text-slate-300"}`}>
                          <input type="checkbox" checked={selectedKeys.has(key({table:selectedTable,column:col.name,check:opt.id}))}
                            disabled={!allowed(opt.kind,col.datatype)} onChange={() => toggle(col.name,opt.id)} className="h-4 w-4 accent-blue-700" />
                          {opt.label}
                        </label>
                      ))}
                    </div>
                    {active.filter((s) => ["range", "length", "allowed_values"].includes(s.check)).map((s) => (
                      <div key={s.check} className="mt-3 rounded-lg bg-slate-50 p-3">
                        <div className="mb-2 text-xs font-semibold text-slate-700">{OPTIONS.find((o) => o.id === s.check)?.label} parameters</div>
                        {s.check === "allowed_values" ? (
                          <label className="block text-xs text-slate-600">Comma-separated allowed strings
                            <input value={Array.isArray(s.params.values) ? (s.params.values as string[]).join(",") : ""}
                              onChange={(e) => modify(col.name, s.check, { values: e.target.value.split(",").map((v) => v.trim()).filter(Boolean) })}
                              placeholder="ACTIVE,INACTIVE" className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" />
                          </label>
                        ) : (
                          <div className="flex flex-wrap gap-3">
                            {(["min", "max"] as const).map((bound) => (
                              <label key={bound} className="text-xs text-slate-600">{bound === "min" ? "Minimum" : "Maximum"} (optional)
                                <input type="number" step={s.check === "length" ? "1" : "any"}
                                  value={typeof s.params[bound] === "string" || typeof s.params[bound] === "number" ? String(s.params[bound]) : ""}
                                  onChange={(e) => editBound(s,bound,e.target.value)}
                                  className="mt-1 block w-40 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" />
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-4">
          <div className="text-xs text-slate-500">{selections.length} configured checks across all tables · Saved per analysis run</div>
          <div className="flex items-center gap-3">
            {(configQuery.isError || tablesQuery.isError || saveMutation.isError) && (
              <span role="alert" className="max-w-64 text-xs text-red-700">{message(saveMutation.error || configQuery.error || tablesQuery.error)}</span>
            )}
            <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium">Cancel</button>
            <button type="button" disabled={!initialized || tablesQuery.isPending || saveMutation.isPending}
              onClick={() => saveMutation.mutate(selections)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {saveMutation.isPending ? <LoaderCircle size={16} className="animate-spin"/> : <Save size={16}/>} Save & generate checks
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
