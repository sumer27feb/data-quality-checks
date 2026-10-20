import { useState } from "react";
import {
  Check,
  ClipboardCopy,
  Code2,
  ExternalLink,
  Info,
  Layers3,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReviewRule } from "./api";
import { impactStyle, humanize } from "./RuleCard";
import SqlReviewEditor from "./SqlReviewEditor";

type Props = {
  rule: ReviewRule | null;
  selected: boolean;
  currentSql: string;
  onSqlChange: (value: string) => void;
  onRestoreSql: () => void;
  onToggle: (id: string) => void;
  onClear: () => void;
};

export default function RuleInspector({
  rule,
  selected,
  currentSql,
  onSqlChange,
  onRestoreSql,
  onToggle,
  onClear,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);

  async function copy(value: string, kind: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  if (!rule) {
    return (
      <aside className="rounded-2xl border border-slate-200 bg-white px-7 py-14 text-center shadow-sm lg:sticky lg:top-6">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
          <Layers3 size={26} />
        </div>
        <h3 className="mt-4 text-lg font-bold text-slate-900">
          Rule Inspector
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Choose a recommendation to review its business predicate and generated
          SQL.
        </p>
      </aside>
    );
  }

  const mode =
    rule.sql_result_mode ??
    (rule.scope === "traditional" ? "violation_rows" : "violation_count");
  const edited = currentSql !== (rule.validation_sql ?? "");
  const scopeLabel =
    rule.scope === "traditional"
      ? "Traditional · deterministic"
      : rule.scope === "inter_table"
        ? "Cross-table · AI"
        : "Individual · AI";
  const copyKey = `${rule.id}:sql`;

  return (
    <>
      <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:sticky lg:top-6">
        <header className="border-b border-slate-100 bg-linear-to-br from-white to-blue-50 px-5 py-5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-blue-700">
              <ShieldCheck size={17} /> Rule inspector
            </span>
            <button
              type="button"
              onClick={onClear}
              aria-label="Close rule inspector"
              className="rounded-lg p-1.5 text-slate-500 hover:bg-white"
            >
              <X size={18} />
            </button>
          </div>
          <h3 className="mt-3 text-base font-bold leading-6 text-slate-900">
            {rule.description}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ring-1 ring-inset ${impactStyle[rule.impact.level]}`}
            >
              {rule.impact.level} impact
            </span>
            <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-slate-200">
              {scopeLabel}
            </span>
          </div>
          <p
            className="mt-2 break-all font-mono text-[10px] text-slate-500"
            title={rule.id}
          >
            {rule.id}
          </p>
        </header>

        <div className="space-y-4 p-5">
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Relationship category
            </h4>
            <p className="mt-1 text-sm text-slate-800">
              {humanize(rule.proposed_relation)}
            </p>
            {rule.table_name && (
              <p className="mt-1 font-mono text-xs text-slate-500">
                {rule.table_name}
                {rule.column_name ? `.${rule.column_name}` : ""}
              </p>
            )}
          </div>
          <div className="border-t border-slate-100 pt-4">
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
              Why this matters
            </h4>
            <p className="mt-1 text-sm leading-5 text-slate-700">
              {rule.impact.reason}
            </p>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-600">
                Logical predicate
              </span>
              <button
                type="button"
                aria-label="Copy logical predicate"
                onClick={() => void copy(rule.rule, `${rule.id}:predicate`)}
                className="rounded-md p-1.5 text-slate-500 hover:bg-slate-200"
              >
                <ClipboardCopy size={14} />
              </button>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-slate-200 px-3 py-3 font-mono text-xs leading-5 text-slate-800">
              {rule.rule}
            </pre>
          </div>

          <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111e35] text-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-sky-200">
                <Code2 size={15} /> Spark SQL
              </div>
              <span className="text-[10px] text-slate-300">
                {mode === "violation_rows"
                  ? "SELECT * · violation rows"
                  : "violation_count"}
              </span>
            </div>
            <p className="px-3 pt-3 text-[11px] text-amber-300">
              {edited
                ? "Locally edited · unverified"
                : rule.scope === "traditional"
                  ? "Deterministic template · unverified"
                  : rule.validation_sql
                    ? "AI generated · unverified"
                    : "SQL unavailable"}
            </p>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-3 font-mono text-[11px] leading-5 text-sky-100">
              {currentSql ||
                "No SQL available. Open editor to write a local draft."}
            </pre>
            <div className="flex flex-wrap gap-2 border-t border-white/10 p-3">
              <button
                type="button"
                onClick={() => setEditingId(rule.id)}
                className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-blue-500 px-3 py-2.5 text-xs font-semibold hover:bg-blue-400"
              >
                <ExternalLink size={14} /> Open SQL editor
              </button>
              <button
                type="button"
                aria-label="Copy reviewed SQL"
                disabled={!currentSql.trim()}
                onClick={() => void copy(currentSql, copyKey)}
                className="rounded-lg border border-white/20 px-3 py-2.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40"
              >
                {copied === copyKey ? (
                  <Check size={15} />
                ) : (
                  <ClipboardCopy size={15} />
                )}
              </button>
              <button
                type="button"
                aria-label="Restore original SQL"
                disabled={!edited}
                onClick={onRestoreSql}
                className="rounded-lg border border-white/20 px-3 py-2.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-40"
              >
                <RotateCcw size={15} />
              </button>
            </div>
          </div>

          {rule.sql_generation_note && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] font-semibold uppercase text-amber-900">
                Generation note
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-amber-800">
                {rule.sql_generation_note}
              </p>
            </div>
          )}
          {copyError && (
            <p role="alert" className="text-xs text-red-700">
              Clipboard access failed.
            </p>
          )}

          <button
            type="button"
            onClick={() => onToggle(rule.id)}
            className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ${selected ? "border border-emerald-200 bg-emerald-50 text-emerald-800" : "bg-blue-700 text-white hover:bg-blue-800"}`}
          >
            {selected ? <Check size={17} /> : <ShieldCheck size={17} />}
            {selected ? "Selected — click to remove" : "Select this rule"}
          </button>
          <div className="flex items-start gap-2 text-xs leading-5 text-slate-500">
            <Info className="mt-0.5 shrink-0" size={14} />
            <p>
              Edits stay in this browser and are included in reviewed exports.
              No SQL is executed or validated.
            </p>
          </div>
        </div>
      </aside>

      {editingId === rule.id && (
        <SqlReviewEditor
          key={rule.id}
          ruleId={rule.id}
          description={rule.description}
          sourceSql={rule.validation_sql}
          reviewedSql={currentSql}
          resultMode={mode}
          onSave={onSqlChange}
          onClose={() => setEditingId(null)}
        />
      )}
    </>
  );
}
