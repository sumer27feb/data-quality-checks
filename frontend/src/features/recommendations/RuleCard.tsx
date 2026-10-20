import { ArrowUpRight, Check, Code2 } from "lucide-react";
import type { ReviewRule } from "./api";

export const impactStyle = {
  high: "bg-rose-50 text-rose-700 ring-rose-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  low: "bg-sky-50 text-sky-700 ring-sky-200",
} as const;

export function humanize(value: string | null): string {
  if (!value) return "Unclassified";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RuleCardProps {
  rule: ReviewRule;
  checked: boolean;
  focused: boolean;
  onToggle: (id: string) => void;
  onInspect: (id: string) => void;
  onEditSql: (id: string) => void;
  currentSql: string;
}

export default function RuleCard({
  rule,
  checked,
  focused,
  onToggle,
  onInspect,
  onEditSql,
  currentSql,
}: RuleCardProps) {
  return (
    <article
      className={`group overflow-hidden rounded-2xl border bg-white transition-all duration-150 ${
        focused
          ? "border-blue-400 shadow-md ring-2 ring-blue-100"
          : checked
            ? "border-emerald-200 shadow-sm"
            : "border-slate-200 shadow-sm hover:border-slate-300 hover:shadow-md"
      }`}
    >
      <div className="flex items-start gap-3 px-5 pt-5">
        <label className="relative mt-0.5 flex shrink-0 cursor-pointer items-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(rule.id)}
            aria-label={`Keep recommendation: ${rule.description}`}
            className="peer h-5 w-5 cursor-pointer appearance-none rounded-md border-2 border-slate-300 bg-white checked:border-emerald-600 checked:bg-emerald-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          />
          <Check
            size={14}
            strokeWidth={3}
            className="pointer-events-none absolute left-0.75 top-0.75 text-white opacity-0 peer-checked:opacity-100"
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ring-inset ${impactStyle[rule.impact.level]}`}
            >
              {rule.impact.level} impact
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[11px] font-semibold text-slate-600">
              {rule.scope === "individual" || rule.scope === "traditional" ? rule.table_name : "Cross-table"}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${rule.validation_sql ? "bg-blue-50 text-blue-700" : "bg-slate-100 text-slate-500"}`}
            >
              {rule.scope === "traditional" ? "SELECT * · violation rows" : rule.validation_sql ? "Spark SQL generated" : "SQL unavailable"}
            </span>
            {checked && (
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">
                Selected to keep
              </span>
            )}
          </div>
          <h3 className="mt-3 text-[15px] font-semibold leading-6 text-slate-900">
            {rule.description}
          </h3>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">
            {humanize(rule.proposed_relation)}
          </p>
        </div>
      </div>
      <div className="mx-5 mt-4 rounded-xl border border-slate-200 bg-[#f5f8fc] px-4 py-3">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          <Code2 size={12} /> SQL predicate
        </div>
        <p className="line-clamp-2 break-all font-mono text-xs leading-5 text-slate-700">
          {rule.rule}
        </p>
      </div>
      <details className="mx-5 mt-3 overflow-hidden rounded-xl border border-blue-100 bg-slate-50">
        <summary className="cursor-pointer px-4 py-2.5 text-xs font-semibold text-blue-700 hover:bg-blue-50">
          View reviewed SQL {currentSql !== (rule.validation_sql ?? "") ? "· locally edited" : rule.scope === "traditional" ? "· SELECT * violation rows" : "· violation count"}
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-blue-100 px-4 py-3 font-mono text-xs leading-5 text-slate-700">
          {currentSql || "No SQL available for this rule."}
        </pre>
      </details>
      <div className="mt-4 flex items-center justify-between border-t border-slate-100 px-5 py-3">
        <span className="text-xs text-slate-400">
          {rule.scope === "traditional" ? "Traditional check" : rule.scope === "individual" ? "Table rule" : "Inter-table rule"} · #
          {rule.position}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onEditSql(rule.id)}
            className="rounded-lg bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600"
          >
            View / edit SQL
          </button>
        <button
          type="button"
          onClick={() => onInspect(rule.id)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500"
        >
          Inspect rule <ArrowUpRight size={15} />
        </button>
        </div>
      </div>
    </article>
  );
}
