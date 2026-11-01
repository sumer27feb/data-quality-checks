import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2, X } from "lucide-react";

import { reusableApi, type CustomRule } from "@/features/reusable/api";

type Scope = "individual" | "inter_table";
type Impact = "low" | "medium" | "high";

interface Props {
  discoveryId: string;
  recommendationId: string;
  rules: CustomRule[];
  onClose: () => void;
  onChanged: (createdId?: string, deletedId?: string) => void;
}

const inputStyle =
  "mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500";

export default function CustomRulesPanel({
  discoveryId,
  recommendationId,
  rules,
  onClose,
  onChanged,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<Scope>("individual");
  const [tables, setTables] = useState<string[]>([]);
  const [impact, setImpact] = useState<Impact>("medium");
  const [sql, setSql] = useState("");
  const [resultMode, setResultMode] = useState<
    "violation_rows" | "violation_count"
  >("violation_rows");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const runQuery = useQuery({
    queryKey: ["custom-rule-run", discoveryId, recommendationId],
    queryFn: () => reusableApi.getRecommendation(discoveryId, recommendationId),
  });

  const availableTables = Object.keys(runQuery.data?.config?.selections ?? {});

  function clearForm() {
    setEditingId(null);
    setName("");
    setDescription("");
    setScope("individual");
    setTables([]);
    setImpact("medium");
    setSql("");
    setResultMode("violation_rows");
  }

  function edit(rule: CustomRule) {
    setEditingId(rule.id);
    setName(rule.name);
    setDescription(rule.description);
    setScope(rule.scope);
    setTables([...rule.tables]);
    setImpact(rule.impact_level);
    setSql(rule.validation_sql);
    setResultMode(rule.sql_result_mode);
    setError("");
    setSuccess("");
  }

  function toggleTable(table: string) {
    setTables((previous) => {
      if (previous.includes(table)) {
        return previous.filter((name) => name !== table);
      }

      if (scope === "individual") {
        return [table];
      }

      return [...previous, table];
    });
  }

  async function save() {
    setError("");
    setSuccess("");

    if (!name.trim() || !description.trim() || !sql.trim()) {
      setError("Name, description, and validation SQL are required.");
      return;
    }

    if (
      (scope === "individual" && tables.length !== 1) ||
      (scope === "inter_table" && tables.length < 2)
    ) {
      setError(
        scope === "individual"
          ? "Select exactly one table."
          : "Select at least two tables.",
      );
      return;
    }

    const payload: Omit<CustomRule, "id" | "source"> = {
      name: name.trim(),
      description: description.trim(),
      scope,
      tables,
      columns: {},
      impact_level: impact,
      validation_sql: sql.trim(),
      sql_result_mode: resultMode,
    };

    setBusy(true);

    try {
      const result = editingId
        ? await reusableApi.updateCustom(
            discoveryId,
            recommendationId,
            editingId,
            payload,
          )
        : await reusableApi.createCustom(
            discoveryId,
            recommendationId,
            payload,
          );

      // Only new rules are automatically added to the review selection.
      onChanged(editingId ? undefined : result.id);
      setSuccess(editingId ? "Rule updated." : "Rule created.");
      clearForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: CustomRule) {
    if (!window.confirm(`Delete custom rule "${rule.name}"?`)) {
      return;
    }

    setBusy(true);
    setError("");

    try {
      await reusableApi.deleteCustom(discoveryId, recommendationId, rule.id);

      onChanged(undefined, rule.id);

      if (editingId === rule.id) {
        clearForm();
      }

      setSuccess("Custom rule deleted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Manage custom rules"
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-200 p-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Custom Data Quality Rules
            </h2>
            <p className="text-xs text-slate-500">
              Create or edit rules without rerunning Graph 2.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto p-5">
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </p>
          )}
          {success && (
            <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700">
              {success}
            </p>
          )}

          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">
              Existing custom rules ({rules.length})
            </h3>
            <div className="space-y-2">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 p-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-slate-800">
                      {rule.name}
                    </p>
                    <p className="truncate text-xs text-slate-500">
                      {rule.scope} · {rule.tables.join(", ")}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => edit(rule)}
                      className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(rule)}
                      className="rounded-lg border border-red-200 px-2.5 py-1.5 text-red-700"
                      aria-label={`Delete ${rule.name}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
              {rules.length === 0 && (
                <p className="text-sm text-slate-500">
                  No custom rules have been added.
                </p>
              )}
            </div>
          </section>

          <section className="space-y-4 border-t border-slate-200 pt-4">
            <div className="flex justify-between">
              <h3 className="font-semibold text-slate-900">
                {editingId ? "Edit rule" : "Create rule"}
              </h3>
              {editingId && (
                <button
                  type="button"
                  onClick={clearForm}
                  className="text-xs text-blue-700"
                >
                  Cancel editing
                </button>
              )}
            </div>

            <label className="block text-sm font-medium">
              Rule name
              <input
                className={inputStyle}
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="block text-sm font-medium">
              Description
              <textarea
                className={inputStyle}
                maxLength={2000}
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm font-medium">
                Scope
                <select
                  className={inputStyle}
                  value={scope}
                  onChange={(e) => {
                    const next = e.target.value as Scope;
                    setScope(next);
                    if (next === "individual") {
                      setTables((prev) => prev.slice(0, 1));
                    }
                  }}
                >
                  <option value="individual">Individual table</option>
                  <option value="inter_table">Cross-table</option>
                </select>
              </label>

              <label className="text-sm font-medium">
                Impact
                <select
                  className={inputStyle}
                  value={impact}
                  onChange={(e) => setImpact(e.target.value as Impact)}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>

              <label className="text-sm font-medium">
                SQL result mode
                <select
                  className={inputStyle}
                  value={resultMode}
                  onChange={(e) =>
                    setResultMode(
                      e.target.value as "violation_rows" | "violation_count",
                    )
                  }
                >
                  <option value="violation_rows">Violation rows</option>
                  <option value="violation_count">Violation count</option>
                </select>
              </label>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Target tables</p>
              {runQuery.isPending && (
                <p className="text-xs text-slate-500">
                  Loading selected tables...
                </p>
              )}
              {runQuery.isError && (
                <p className="text-xs text-red-700">
                  Could not load recommendation scope.
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {availableTables.map((table) => (
                  <label
                    key={table}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={tables.includes(table)}
                      onChange={() => toggleTable(table)}
                    />
                    {table}
                  </label>
                ))}
              </div>
            </div>

            <label className="block text-sm font-medium">
              Validation SQL
              <textarea
                className={`${inputStyle} font-mono text-xs`}
                rows={7}
                maxLength={25000}
                spellCheck={false}
                placeholder="SELECT * FROM ..."
                value={sql}
                onChange={(e) => setSql(e.target.value)}
              />
            </label>
            <p className="text-xs text-slate-500">
              Only one read-only SELECT statement is accepted by the backend.
              SQL is stored for review, not executed.
            </p>
          </section>
        </div>

        <footer className="flex justify-end gap-3 border-t border-slate-200 p-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm"
          >
            Close
          </button>
          <button
            type="button"
            disabled={busy || runQuery.isPending || runQuery.isError}
            onClick={() => void save()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? (
              <LoaderCircle size={16} className="animate-spin" />
            ) : (
              <Plus size={16} />
            )}
            {editingId ? "Update rule" : "Create rule"}
          </button>
        </footer>
      </section>
    </div>
  );
}
