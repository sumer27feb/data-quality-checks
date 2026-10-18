import { useState } from "react";
import {
  Check,
  ClipboardCopy,
  Code2,
  Info,
  Layers3,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReviewRule } from "./api";
import { impactStyle, humanize } from "./RuleCard";

interface Props {
  rule: ReviewRule | null;
  selected: boolean;
  onToggle: (id: string) => void;
  onClear: () => void;
}

export default function RuleInspector({
  rule,
  selected,
  onToggle,
  onClear,
}: Props) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);

  async function copySql(value: ReviewRule) {
    try {
      await navigator.clipboard.writeText(value.rule);
      setCopiedId(value.id);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  return (
    <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:sticky lg:top-6">
      {!rule ? (
        <div className="px-7 py-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
            <Layers3 size={27} />
          </div>
          <h3 className="mt-5 text-lg font-bold text-slate-900">
            Rule Inspector
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Inspect any recommendation to read its full SQL predicate, business
            impact, and explanation.
          </p>
        </div>
      ) : (
        <>
          <div className="border-b border-slate-100 bg-linear-to-br from-white to-blue-50/60 px-6 py-5">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-blue-700">
                <ShieldCheck size={17} /> Rule inspector
              </span>
              <button
                type="button"
                onClick={onClear}
                aria-label="Close rule inspector"
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>
            <h3 className="mt-4 text-lg font-bold leading-7 text-slate-900">
              {rule.description}
            </h3>
            <div className="mt-4 flex flex-wrap gap-2">
              <span
                className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase ring-1 ring-inset ${impactStyle[rule.impact.level]}`}
              >
                {rule.impact.level} impact
              </span>
              <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                {rule.scope === "individual" ? rule.table_name : "Cross-table"}
              </span>
            </div>
          </div>
          <div className="space-y-5 p-6">
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Relationship category
              </h4>
              <p className="mt-2 text-sm font-medium text-slate-800">
                {humanize(rule.proposed_relation)}
              </p>
            </div>
            <div className="border-t border-slate-100 pt-5">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Why this matters
              </h4>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                {rule.impact.reason}
              </p>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#111e35] text-white">
              <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-blue-200">
                  <Code2 size={15} /> SQL predicate
                </span>
                <button
                  type="button"
                  onClick={() => void copySql(rule)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-white/20"
                >
                  {copiedId === rule.id ? (
                    <Check size={14} />
                  ) : (
                    <ClipboardCopy size={14} />
                  )}
                  {copiedId === rule.id ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-break-word px-4 py-5 font-mono text-xs leading-6 text-sky-100">
                <code>{rule.rule}</code>
              </pre>
            </div>
            {copyError && (
              <p role="alert" className="text-xs text-red-700">
                Clipboard access failed. You can select and copy the SQL above
                manually.
              </p>
            )}
            <button
              type="button"
              onClick={() => onToggle(rule.id)}
              className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ${
                selected
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  : "bg-blue-700 text-white hover:bg-blue-800"
              }`}
            >
              {selected ? <Check size={18} /> : <ShieldCheck size={18} />}
              {selected ? "Selected — click to remove" : "Keep this rule"}
            </button>
            <div className="flex items-start gap-2 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-500">
              <Info size={15} className="mt-0.5 shrink-0" />
              <p>
                This is a generated recommendation, not an executed or validated
                data-quality check. Selection only affects local review and
                export.
              </p>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
