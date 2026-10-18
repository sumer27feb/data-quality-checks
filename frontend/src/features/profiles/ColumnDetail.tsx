import {
  BarChart3,
  BrainCircuit,
  Database,
  Info,
  Sparkles,
} from "lucide-react";
import type { SemanticColumn, StatisticalColumn, StatValue } from "./api";

interface Props {
  name: string;
  rowCount: number | null;
  statistical?: StatisticalColumn;
  semantic?: SemanticColumn;
}

function formatNumber(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function display(value: StatValue | undefined): string {
  if (value === undefined || value === null) return "Not available";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} reported`;
  return String(value);
}
function humanize(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function ColumnDetail({
  name,
  rowCount,
  statistical,
  semantic,
}: Props) {
  const stats = statistical?.statistics ?? {};
  const topValues = Array.isArray(stats.top_values) ? stats.top_values : [];
  const maxCount = Math.max(0, ...topValues.map((item) => item.count));
  const otherStatistics = Object.entries(stats).filter(
    ([key]) => key !== "top_values",
  );
  const nullRate =
    typeof statistical?.null_count === "number" &&
    rowCount !== null &&
    rowCount > 0
      ? (statistical.null_count / rowCount) * 100
      : null;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-indigo-50 p-2.5 text-indigo-700">
            <Database size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Column inspector
            </p>
            <h3 className="break-all font-mono text-base font-semibold text-slate-900">
              {name}
            </h3>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {statistical?.physical_type && (
            <span className="rounded-md bg-slate-100 px-2.5 py-1 font-mono text-xs text-slate-700">
              {statistical.physical_type}
            </span>
          )}
          {semantic?.semantic_role && (
            <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
              {humanize(semantic.semantic_role)}
            </span>
          )}
          {statistical?.profiling_status && (
            <span className="rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              {statistical.profiling_status}
            </span>
          )}
        </div>
      </div>

      {statistical && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2 font-semibold text-slate-900">
            <BarChart3 size={18} className="text-blue-600" /> Statistical
            summary
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["Null values", statistical.null_count],
                ["Valid values", statistical.valid_count],
                ["Invalid values", statistical.invalid_count],
                [
                  "Distinct values",
                  typeof stats.distinct_count === "number"
                    ? stats.distinct_count
                    : null,
                ],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-xl bg-slate-50 p-3">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">
                  {value === null ? "—" : formatNumber(value)}
                </p>
              </div>
            ))}
          </div>
          {nullRate !== null && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500">Null proportion</span>
                <span className="font-semibold tabular-nums text-slate-800">
                  {formatNumber(nullRate)}%
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-amber-400"
                  style={{ width: `${Math.min(100, Math.max(0, nullRate))}%` }}
                />
              </div>
            </div>
          )}
          <div className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Expected datatype</span>
              <span className="text-right font-mono text-xs font-semibold text-slate-800">
                {statistical.expected_type}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-slate-500">Physical datatype</span>
              <span className="text-right font-mono text-xs font-semibold text-slate-800">
                {statistical.physical_type}
              </span>
            </div>
            {statistical.conversion_success_rate !== null && (
              <div className="flex justify-between gap-3">
                <span className="text-slate-500">Conversion success rate</span>
                <span className="font-semibold text-slate-800">
                  {display(statistical.conversion_success_rate)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {semantic && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2 font-semibold text-slate-900">
            <BrainCircuit size={18} className="text-violet-600" /> Semantic
            interpretation
          </div>
          <p className="text-sm leading-6 text-slate-700">
            {semantic.description}
          </p>
          <dl className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
            {(
              [
                ["Semantic type", semantic.semantic_type],
                ["Business entity", semantic.entity],
                ["Inferred confidence", semantic.confidence],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="flex items-start justify-between gap-3"
              >
                <dt className="text-slate-500">{label}</dt>
                <dd className="max-w-[58%] wrap-break-word text-right font-medium text-slate-800">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-slate-500">
            <Sparkles size={14} className="mt-0.5 shrink-0" /> Descriptions and
            confidence are LLM-inferred, not verified data constraints.
          </p>
        </div>
      )}

      {statistical && otherStatistics.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-3 font-semibold text-slate-900">
            Detailed statistics
          </h3>
          <div className="divide-y divide-slate-100">
            {otherStatistics.map(([key, value]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 py-2.5 text-sm"
              >
                <span className="text-slate-500">{humanize(key)}</span>
                <span className="break-all text-right font-medium tabular-nums text-slate-900">
                  {display(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {topValues.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-1 flex items-center gap-2 font-semibold text-slate-900">
            <BarChart3 size={17} className="text-blue-600" /> Most frequent
            values
          </div>
          <p className="mb-4 text-xs text-slate-500">
            Only values returned by the statistical profiler are shown.
          </p>
          <div className="space-y-3">
            {topValues.map((item, i) => (
              <div key={`${String(item.value)}-${i}`}>
                <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                  <span
                    title={String(item.value)}
                    className="max-w-[72%] truncate font-medium text-slate-700"
                  >
                    {String(item.value)}
                  </span>
                  <span className="tabular-nums text-slate-500">
                    {formatNumber(item.count)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{
                      width: `${maxCount > 0 ? (item.count / maxCount) * 100 : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!statistical && !semantic && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
          <Info size={16} className="mb-2" /> No statistical or semantic profile
          is available for this column yet.
        </div>
      )}
    </div>
  );
}
