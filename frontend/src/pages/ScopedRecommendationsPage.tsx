import { useMemo, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ClipboardList, Download, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { reusableApi, type ScopedRecommendations, type CustomRule, type TraditionalSelection } from "@/features/reusable/api";
import { exportSelection, type ExportFormat } from "@/features/recommendations/export";
import { normalizeRecommendations, type ReviewRule } from "@/features/recommendations/api";
import SqlReviewEditor from "@/features/recommendations/SqlReviewEditor";

const field = "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500";
const action = "rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:opacity-40";
type Level = "low" | "medium" | "high";
type RuleWithSql = ReviewRule & { reviewed_sql: string | null };

function combinedRules(data: ScopedRecommendations | undefined): ReviewRule[] {
  if (!data) return [];
  const rec = normalizeRecommendations({
    run_id: data.recommendation_id, status: data.status,
    available: { individual: true, inter_table: true, traditional: false },
    individual_rules: data.individual_rules, inter_table_rules: data.inter_table_rules,
  });
  const traditional = data.traditional_rules.map((r, i): ReviewRule => ({
    ...r, scope: "traditional", table_name: r.table_name, position: i + 1,
    sql_result_mode: "violation_rows", column_name: r.column_name,
    check_type: r.check_type as ReviewRule["check_type"],
  }));
  const custom = data.custom_rules.map((r, i): ReviewRule => ({
    id: r.id, scope: "custom", table_name: r.tables.length === 1 ? r.tables[0] : null,
    position: i + 1, rule: r.name, description: r.description,
    validation_sql: r.validation_sql, sql_generation_note: "User-authored; not executed or SQL-validated",
    proposed_relation: "user_defined", sql_result_mode: r.sql_result_mode,
    impact: { level: r.impact_level, reason: "Impact chosen by user" },
  }));
  return [...rec, ...traditional, ...custom];
}

export default function ScopedRecommendationsPage() {
  const [params] = useSearchParams();
  const discoveryId = params.get("discovery") ?? "";
  const recId = params.get("rec") ?? "";
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [loadedReviewKey, setLoadedReviewKey] = useState("");
  const [editor, setEditor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [customTables, setCustomTables] = useState("");
  const [customScope, setCustomScope] = useState<"individual" | "inter_table">("individual");
  const [customImpact, setCustomImpact] = useState<Level>("medium");
  const [customSql, setCustomSql] = useState("");
  const [customResultMode, setCustomResultMode] = useState<"violation_rows" | "violation_count">("violation_rows");
  const [tradTable, setTradTable] = useState("");
  const [tradCol, setTradCol] = useState("");
  const [tradCheck, setTradCheck] = useState<TraditionalSelection["check"]>("not_null");

  const statusQuery = useQuery({ queryKey: ["scoped-run", discoveryId, recId], queryFn: () => reusableApi.getRecommendation(discoveryId, recId), enabled: !!(discoveryId && recId), refetchInterval: query => ["completed", "failed"].includes(query.state.data?.status ?? "") ? false : 2000 });
  const resultQuery = useQuery({ queryKey: ["scoped-recommendations", discoveryId, recId], queryFn: () => reusableApi.recommendations(discoveryId, recId), enabled: !!(discoveryId && recId), refetchInterval: statusQuery.data?.status === "running" ? 3000 : false });
  const reviewQuery = useQuery({ queryKey: ["scoped-review", discoveryId, recId], queryFn: () => reusableApi.getReview(discoveryId, recId), enabled: !!(discoveryId && recId) });
  const tablesQuery = useQuery({ queryKey: ["discovery-tables", discoveryId], queryFn: () => reusableApi.tables(discoveryId), enabled: !!discoveryId });
  const rules = useMemo(() => combinedRules(resultQuery.data), [resultQuery.data]);
  const runKey = `${discoveryId}/${recId}`;
  const sourceRun = statusQuery.data;
  const tables = tablesQuery.data?.tables ?? [];
  const activeTable = tradTable || tables[0]?.table_name || "";
  const columns = tables.find(t => t.table_name === activeTable)?.columns ?? [];
  const selectedRules = rules.filter(r => selected.has(r.id));
  const editingRule = rules.find(r => r.id === editor);

  useEffect(() => {
    if (!reviewQuery.data || loadedReviewKey === runKey) return;
    setSelected(new Set(reviewQuery.data.rules.map(r => r.id)));
    setEdits(Object.fromEntries(reviewQuery.data.rules.map(r => [r.id, r.reviewed_sql])));
    setLoadedReviewKey(runKey);
  }, [reviewQuery.data, loadedReviewKey, runKey]);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["scoped-recommendations", discoveryId, recId] }),
      queryClient.invalidateQueries({ queryKey: ["scoped-run", discoveryId, recId] }),
    ]);
  }
  async function saveReview(nextSelection = selected, nextEdits = edits) {
    if (!recId) return;
    setBusy(true); setError(""); setSuccess("");
    try {
      const snapshot = rules.filter(r => nextSelection.has(r.id)).map(r => ({ id: r.id, reviewed_sql: nextEdits[r.id] ?? r.validation_sql }));
      await reusableApi.saveReview(discoveryId, recId, snapshot);
      setSuccess("Selections and reviewed SQL saved to backend.");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  function exportRules(format: ExportFormat) {
    const entries: RuleWithSql[] = selectedRules.map(r => ({ ...r, reviewed_sql: edits[r.id] ?? r.validation_sql }));
    exportSelection(recId, entries, format);
  }
  async function addCustom() {
    const targets = [...new Set(customTables.split(",").map(t => t.trim()).filter(Boolean))];
    if (!customName.trim() || !customDescription.trim() || !customSql.trim() || !targets.length) {setError("Fill in the required custom rule fields");return;}
    setBusy(true);setError("");setSuccess("");
    try {
      const input: Omit<CustomRule, "id" | "source"> = {
        name: customName, description: customDescription, scope: customScope,
        tables: targets, columns: {}, impact_level: customImpact,
        validation_sql: customSql, sql_result_mode: customResultMode,
      };
      const result = editingCustomId
        ? await reusableApi.updateCustom(discoveryId, recId, editingCustomId, input)
        : await reusableApi.createCustom(discoveryId, recId, input);
      const next = new Set(selected).add(result.id);
      setSelected(next);
      await refresh();
      setAddOpen(false);setEditingCustomId(null);setCustomName("");setCustomDescription("");setCustomTables("");setCustomSql("");
      setSuccess("Custom rule added. Save your selection after reviewing.");
    } catch(e){setError(String(e));}finally{setBusy(false);}
  }
  function editCustom(id: string) {
    const rule = resultQuery.data?.custom_rules.find(item => item.id === id);
    if (!rule) return;
    setEditingCustomId(id);setCustomName(rule.name);setCustomDescription(rule.description);setCustomTables(rule.tables.join(", "));
    setCustomScope(rule.scope);setCustomImpact(rule.impact_level);setCustomSql(rule.validation_sql);setCustomResultMode(rule.sql_result_mode);
    setAddOpen(true);window.scrollTo({top:0,behavior:"smooth"});
  }
  async function deleteCustom(id: string) {
    setBusy(true);setError("");
    try {await reusableApi.deleteCustom(discoveryId,recId,id);setSelected(previous=>{const next=new Set(previous);next.delete(id);return next;});await refresh();}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  async function addTraditional() {
    if (!activeTable || !tradCol) return;
    setBusy(true);setError("");
    try {
      const existing = await reusableApi.getTraditional(discoveryId,recId);
      const next = [...existing.selections, {table:activeTable,column:tradCol,check:tradCheck,params:{},impact_level:"medium" as const}];
      const saved = await reusableApi.saveTraditional(discoveryId,recId,next);
      setSelected(previous=>{const result=new Set(previous);for(const r of saved.rules)result.add(r.id);return result;});
      await refresh();setSuccess("Traditional check added. Save selection to persist it.");
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <div className="space-y-5 pb-16">
    <Link to="/reusable-runs" className="inline-flex items-center gap-2 text-sm text-blue-700"><ArrowLeft size={16}/> Discovery and recommendation runs</Link>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Named Recommendation Run</p><h1 className="mt-1 text-3xl font-bold text-slate-900">{sourceRun?.name ?? recId}</h1><p className="mt-2 break-all text-xs text-slate-500">{recId} · Parent: {discoveryId}</p></div><span className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">{sourceRun?.status ?? "Loading"}</span></div>
    {sourceRun?.status === "running" || sourceRun?.status === "queued" ? <div className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800"><LoaderCircle className="animate-spin" size={17}/> Generating recommendations from the saved profile. Discovery and profiling are not re-running.</div> : null}
    {sourceRun?.error && <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{sourceRun.error}</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {success && <p className="rounded-xl bg-blue-50 p-4 text-sm text-blue-800">{success}</p>}
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="flex items-center gap-2 font-bold"><ClipboardList size={18}/> Selection used for recommendations</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-2">{Object.entries(sourceRun?.config?.selections ?? {}).map(([table,cols])=><div key={table} className="rounded-lg bg-slate-50 p-3"><p className="font-mono text-sm font-semibold">{table} · {cols.length}</p><p className="mt-1 break-words text-xs text-slate-500">{cols.join(", ")}</p></div>)}</div>
      <p className="mt-3 text-xs text-slate-500">Stages: {Object.entries(sourceRun?.stages ?? {}).map(([stage,st])=>`${stage}: ${st}`).join(" · ")}</p></section>
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold text-slate-900">Rule collection ({rules.length})</h2><div className="flex flex-wrap gap-2"><button type="button" className={action} onClick={()=>{setEditingCustomId(null);setAddOpen(v=>!v);}}><Plus size={15} className="mr-1 inline"/>Custom Rule</button><button type="button" disabled={busy} className={action} onClick={()=>void saveReview()}><Save size={15} className="mr-1 inline"/>Save Review</button></div></div>
    {addOpen && <section className="space-y-3 rounded-xl border border-blue-200 bg-white p-5"><h3 className="font-bold text-slate-900">{editingCustomId ? "Edit custom DQ rule" : "Create a complete DQ rule"}</h3><div className="grid gap-3 md:grid-cols-2"><input className={field} placeholder="Rule name" value={customName} onChange={e=>setCustomName(e.target.value)}/><input className={field} placeholder="Tables (comma-separated)" value={customTables} onChange={e=>setCustomTables(e.target.value)}/></div><textarea className={field} placeholder="What does this rule check?" value={customDescription} onChange={e=>setCustomDescription(e.target.value)}/><div className="grid gap-3 md:grid-cols-3"><select className={field} value={customScope} onChange={e=>setCustomScope(e.target.value as "individual"|"inter_table")}><option value="individual">Individual table</option><option value="inter_table">Cross-table</option></select><select className={field} value={customImpact} onChange={e=>setCustomImpact(e.target.value as Level)}><option value="low">Low impact</option><option value="medium">Medium impact</option><option value="high">High impact</option></select><select className={field} value={customResultMode} onChange={e=>setCustomResultMode(e.target.value as typeof customResultMode)}><option value="violation_rows">SQL returns violation rows</option><option value="violation_count">SQL returns violation count</option></select></div><textarea className={`${field} min-h-36 font-mono`} placeholder="SELECT * FROM ... WHERE ..." value={customSql} onChange={e=>setCustomSql(e.target.value)}/><div className="flex gap-2"><button type="button" className={action} disabled={busy} onClick={()=>void addCustom()}>{editingCustomId ? "Save Custom Rule" : "Add Custom Rule"}</button><button type="button" className="px-4 text-sm text-slate-500" onClick={()=>{setAddOpen(false);setEditingCustomId(null);}}>Cancel</button></div><p className="text-xs text-amber-700">SQL is stored and exported only; no SQL execution or semantic verification.</p></section>}
    <section className="rounded-xl border border-slate-200 bg-white p-4"><h3 className="font-semibold text-slate-800">Add a traditional check</h3><div className="mt-3 grid gap-2 sm:grid-cols-4"><select aria-label="Traditional check table" className={field} value={activeTable} onChange={e=>{setTradTable(e.target.value);setTradCol("");}}>{tables.map(t=><option key={t.table_name} value={t.table_name}>{t.table_name}</option>)}</select><select aria-label="Traditional check column" className={field} value={tradCol} onChange={e=>setTradCol(e.target.value)}><option value="">Select column</option>{columns.map(col=><option key={col} value={col}>{col}</option>)}</select><select aria-label="Traditional check type" className={field} value={tradCheck} onChange={e=>setTradCheck(e.target.value as typeof tradCheck)}><option value="not_null">Not null</option><option value="unique">Unique</option><option value="not_blank">Not blank</option><option value="trimmed">Trimmed</option><option value="non_negative">Non-negative</option><option value="positive">Positive</option></select><button type="button" className={action} disabled={busy || !tradCol || sourceRun?.status !== "completed"} onClick={()=>void addTraditional()}>Add traditional check</button></div></section>
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-slate-600">{selectedRules.length} selected · {rules.length} available</p><div className="flex gap-2">{(["csv","json","sql"] as ExportFormat[]).map(format=><button key={format} type="button" className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-blue-700 disabled:opacity-40" disabled={!selectedRules.length} onClick={()=>exportRules(format)}><Download size={14} className="mr-1 inline"/>Export {format.toUpperCase()}</button>)}</div></div>
    <div className="space-y-3">{rules.map(rule=><div key={rule.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-start gap-3"><input aria-label={`Select ${rule.id}`} type="checkbox" checked={selected.has(rule.id)} onChange={()=>setSelected(previous=>{const next=new Set(previous);if(next.has(rule.id))next.delete(rule.id);else next.add(rule.id);return next;})} className="mt-1"/><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-bold uppercase text-blue-700">{rule.scope.replace("_"," ")}</span><span className="text-xs text-slate-400">{rule.impact.level} impact</span></div><h3 className="mt-1 text-sm font-semibold text-slate-900">{rule.description}</h3><p className="mt-1 font-mono text-xs text-slate-500">{rule.table_name ?? "cross-table"}</p>{(edits[rule.id] ?? rule.validation_sql) && <pre className="mt-3 max-h-24 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{(edits[rule.id] ?? rule.validation_sql)?.slice(0,1200)}</pre>}<div className="mt-3 flex gap-3"><button type="button" className="text-xs font-semibold text-blue-700" onClick={()=>setEditor(rule.id)}>Edit / View SQL</button>{rule.scope === "custom" && <button type="button" disabled={busy} className="text-xs font-semibold text-blue-700" onClick={()=>editCustom(rule.id)}>Edit details</button>}{rule.scope === "custom" && <button type="button" disabled={busy} className="flex items-center gap-1 text-xs font-semibold text-red-600" onClick={()=>void deleteCustom(rule.id)}><Trash2 size={13}/>Delete</button>}</div></div></div></div>)}</div>
    {rules.length === 0 && sourceRun?.status === "completed" && <p className="rounded-xl bg-white p-6 text-sm text-slate-500">No recommended rules were produced. You can still add custom or traditional rules.</p>}
    {editingRule && <SqlReviewEditor key={editingRule.id} ruleId={editingRule.id} description={editingRule.description} sourceSql={editingRule.validation_sql} reviewedSql={edits[editingRule.id] ?? editingRule.validation_sql ?? ""} resultMode={editingRule.sql_result_mode ?? (editingRule.scope === "traditional" ? "violation_rows" : "violation_count")} onSave={sql=>setEdits(previous=>({...previous,[editingRule.id]:sql}))} onClose={()=>setEditor(null)}/>}
    <p className="text-xs text-slate-400">SQL updates and selections become persistent when you click Save Review. Exports use your currently selected and edited rules.</p>
  </div>;
}
