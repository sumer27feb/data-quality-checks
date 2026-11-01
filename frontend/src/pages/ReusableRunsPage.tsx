import { useMemo, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Database, FolderOpen, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { reusableApi, type DiscoveryTable } from "@/features/reusable/api";

const field = "w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500";
const action = "rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-40";

export default function ReusableRunsPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [parentId, setParentId] = useState("");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [context, setContext] = useState("");
  const [individual, setIndividual] = useState(true);
  const [inter, setInter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const discoveryQuery = useQuery({ queryKey: ["discovery-runs"], queryFn: reusableApi.listDiscoveries, refetchInterval: 3000 });
  const parent = discoveryQuery.data?.discovery_runs.find((r) => r.discovery_id === parentId)
    ?? discoveryQuery.data?.discovery_runs[0];
  const activeId = parent?.discovery_id ?? "";
  const tablesQuery = useQuery({ queryKey: ["discovery-tables", activeId], queryFn: () => reusableApi.tables(activeId), enabled: !!activeId && parent?.status === "completed", retry: false });
  const childQuery = useQuery({ queryKey: ["recommendation-runs", activeId], queryFn: () => reusableApi.listRecommendations(activeId), enabled: !!activeId, refetchInterval: 3000 });
  const count = useMemo(() => Object.values(selected).reduce((n, cols) => n + cols.length, 0), [selected]);
  const chosenTables = Object.keys(selected).filter((t) => selected[t].length);
  const tables: DiscoveryTable[] = tablesQuery.data?.tables ?? [];

  async function beginDiscovery() {
    setBusy(true); setError("");
    try {
      const run = await reusableApi.createDiscovery();
      setParentId(run.discovery_id);
      setSelected({});
      await queryClient.invalidateQueries({ queryKey: ["discovery-runs"] });
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  async function beginRecommendation() {
    if (!activeId || !name.trim() || !chosenTables.length || !(individual || inter)) return;
    setBusy(true); setError("");
    try {
      const run = await reusableApi.createRecommendation(activeId, {
        name: name.trim(), selections: Object.fromEntries(chosenTables.map(t => [t, selected[t]])),
        business_context: context, individual, inter_table: inter,
      });
      navigate(`/scoped-recommendations?discovery=${encodeURIComponent(activeId)}&rec=${encodeURIComponent(run.recommendation_id)}`);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  }
  function toggleTable(table: DiscoveryTable) {
    setSelected(previous => {
      const result = { ...previous };
      if (result[table.table_name]?.length) delete result[table.table_name];
      else result[table.table_name] = [...table.columns];
      return result;
    });
  }
  function toggleColumn(table: string, column: string) {
    setSelected(previous => {
      const cols = previous[table] ?? [];
      const next = cols.includes(column) ? cols.filter(c => c !== column) : [...cols, column];
      const result = { ...previous };
      if (next.length) result[table] = next;
      else delete result[table];
      return result;
    });
  }
  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/\.(txt|md|json)$/i.test(file.name) || file.size > 50000) { setError("Use .txt, .md or .json files up to 50 KB"); return; }
    setContext(await file.text()); setError("");
  }
  return <div className="space-y-6 pb-12">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm font-semibold text-blue-700">Reusable dataset analysis</p><h1 className="text-3xl font-bold text-slate-900">Discovery & Recommendation Runs</h1><p className="mt-2 text-sm text-slate-500">Profile a dataset once, then create independently named recommendation runs for different table/column selections.</p></div>
      <button type="button" className={action} disabled={busy} onClick={() => void beginDiscovery()}><Play size={16} className="mr-2 inline"/>New Discovery Run</button>
    </header>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-3 flex items-center gap-2 font-bold text-slate-900"><Database size={18}/> Discovery Profiles</h2>
      {discoveryQuery.isLoading && <p className="text-sm text-slate-500">Loading previous discovery runs…</p>}
      {discoveryQuery.data?.discovery_runs.length === 0 && <p className="text-sm text-slate-500">No reusable profiles yet. Start a discovery run above.</p>}
      {parent && <><select className={field} value={activeId} onChange={e => {setParentId(e.target.value);setSelected({});}} aria-label="Choose discovery run">
        {discoveryQuery.data?.discovery_runs.map(d => <option key={d.discovery_id} value={d.discovery_id}>{d.discovery_id} · {d.status}</option>)}
      </select><div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500"><span>Catalog: {parent.catalog}.{parent.schema}</span><span>Status: <strong className="text-slate-800">{parent.status}</strong></span><span>{new Date(parent.created_at).toLocaleString()}</span></div>
      {parent.status === "running" || parent.status === "queued" ? <p className="mt-3 flex items-center gap-2 text-sm text-blue-700"><LoaderCircle size={16} className="animate-spin"/>Profiling the dataset…</p> : null}
      {parent.error && <p className="mt-3 text-sm text-red-700">{parent.error}</p>}</>}
    </section>
    {parent?.status === "completed" && <>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-bold text-slate-900">Start a Named Recommendation Run</h2>
        <p className="mt-1 text-xs text-slate-500">Each selection creates a separate folder under the discovery run. Profiling is not repeated.</p>
        <label className="mt-4 block text-sm font-semibold text-slate-700">Run name<input className={`mt-1.5 ${field}`} value={name} maxLength={80} placeholder="e.g. Payment Integrity Checks" onChange={e=>setName(e.target.value)}/></label>
        <div className="mt-5 flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-800">Tables and columns</h3><span className="text-xs text-slate-500">{chosenTables.length} tables · {count} target columns</span></div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {tables.map(table => <div key={table.table_name} className="rounded-xl border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-800"><input type="checkbox" checked={(selected[table.table_name]?.length ?? 0) === table.columns.length} onChange={() => toggleTable(table)} />{table.table_name}<span className="ml-auto text-xs font-normal text-slate-400">{selected[table.table_name]?.length ?? 0}/{table.columns.length}</span></label>
            <div className="mt-3 grid max-h-48 grid-cols-2 gap-2 overflow-y-auto border-t border-slate-100 pt-3">
              {table.columns.map(column => <label key={column} className="flex min-w-0 items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={!!selected[table.table_name]?.includes(column)} onChange={() => toggleColumn(table.table_name,column)}/><span className="truncate" title={column}>{column}</span></label>)}
            </div>
          </div>)}
        </div>
        <label className="mt-5 block text-sm font-semibold text-slate-700">Business context (optional)<textarea className={`mt-1.5 min-h-28 ${field}`} value={context} maxLength={50000} onChange={e=>setContext(e.target.value)} placeholder="Describe any business rules, domain policies, or constraints that matter for this selection."/></label>
        <label className="mt-2 block text-xs text-slate-500">Or load context from .txt, .md or .json <input className="mt-1 block text-xs" type="file" accept=".txt,.md,.json" onChange={e => void loadFile(e)}/></label>
        <div className="mt-4 flex flex-wrap items-center gap-5 text-sm"><label><input type="checkbox" checked={individual} onChange={e=>setIndividual(e.target.checked)}/> Individual-table recommendations</label><label><input type="checkbox" checked={inter} onChange={e=>setInter(e.target.checked)}/> Cross-table recommendations</label></div>
        <button type="button" className={`mt-5 ${action}`} disabled={busy || !name.trim() || count === 0 || !(individual || inter)} onClick={() => void beginRecommendation()}>Generate Rules for Selection <ArrowRight size={16} className="ml-1 inline"/></button>
      </section>
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="mb-3 flex items-center gap-2 font-bold text-slate-900"><FolderOpen size={18}/> Recommendation Runs in this Discovery</h2>
        {childQuery.data?.recommendation_runs.length === 0 && <p className="text-sm text-slate-500">No recommendation runs created yet.</p>}
        <div className="space-y-2">{childQuery.data?.recommendation_runs.map(r => <Link to={`/scoped-recommendations?discovery=${encodeURIComponent(activeId)}&rec=${encodeURIComponent(r.recommendation_id)}`} key={r.recommendation_id} className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 text-sm hover:border-blue-300 hover:bg-blue-50"><span className="font-semibold text-slate-800">{r.name}<span className="ml-2 text-xs font-normal text-slate-400">{r.recommendation_id}</span></span><span className="flex items-center gap-2 text-xs text-slate-500">{r.status}<ArrowRight size={14}/></span></Link>)}</div>
      </section>
    </>}
    <button type="button" className="inline-flex items-center gap-2 text-xs text-blue-700" onClick={() => {void queryClient.invalidateQueries({queryKey:["discovery-runs"]});void queryClient.invalidateQueries({queryKey:["recommendation-runs",activeId]});}}><RefreshCw size={14}/> Refresh</button>
  </div>;
}
