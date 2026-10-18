import { History, RefreshCw } from "lucide-react";
import type { RunListItem, RunStatus } from "./api";

export interface SavedRun {
  run_id: string;
  saved_at: string;
}

interface RecentRunsProps {
  runs: RunListItem[];
  savedRuns: SavedRun[];
  selectedRunId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (runId: string) => void;
  onRetry: () => void;
}

const statusColors: Record<RunStatus, string> = {
  queued: "bg-amber-50 text-amber-700",
  running: "bg-blue-50 text-blue-700",
  completed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  archived: "bg-slate-100 text-slate-600",
};

function displayDate(value: string | null) {
  if (!value) return "Unavailable";

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}

export default function RecentRuns({
  runs,
  savedRuns,
  selectedRunId,
  loading,
  error,
  onSelect,
  onRetry,
}: RecentRunsProps) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="rounded-xl bg-blue-50 p-3 text-blue-700">
          <History size={21} />
        </div>

        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Recent Analysis Runs
          </h2>
          <p className="text-sm text-slate-500">
            Runs recorded by FastAPI and available artifact folders
          </p>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-slate-500">Loading run history...</p>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-800">{error}</p>

          <button
            type="button"
            onClick={onRetry}
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-red-800 hover:underline"
          >
            <RefreshCw size={15} />
            Retry
          </button>
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="py-10 text-center text-sm text-slate-500">
          No analysis runs found.
        </div>
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs font-medium text-slate-500">
              <tr>
                <th className="px-3 py-3">Run ID</th>
                <th className="px-3 py-3">Timestamp</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Stages</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody>
              {runs.map((run) => {
                const saved = savedRuns.find(
                  (item) => item.run_id === run.run_id,
                );

                const timestamp =
                  run.created_at ?? saved?.saved_at ?? run.artifact_modified_at;

                const timestampSource = run.created_at
                  ? "Created"
                  : saved
                    ? "Saved in browser"
                    : "Artifact folder modified";

                const selected = selectedRunId === run.run_id;

                return (
                  <tr
                    key={run.run_id}
                    className="border-b border-slate-100 last:border-none hover:bg-slate-50"
                  >
                    <td className="px-3 py-4 font-mono text-xs text-slate-700">
                      <span title={run.run_id}>
                        {run.run_id.slice(0, 12)}...
                      </span>
                    </td>

                    <td className="px-3 py-4">
                      <p className="text-slate-800">
                        {displayDate(timestamp ?? null)}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {timestampSource}
                      </p>
                    </td>

                    <td className="px-3 py-4">
                      <span
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-medium capitalize ${statusColors[run.status]}`}
                      >
                        {run.status}
                      </span>
                    </td>

                    <td className="px-3 py-4 text-slate-600">
                      {run.completed_stages === null
                        ? "Unknown"
                        : `${run.completed_stages} completed`}
                    </td>

                    <td className="px-3 py-4 text-right">
                      <button
                        type="button"
                        onClick={() => onSelect(run.run_id)}
                        disabled={selected}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-default disabled:bg-blue-50 disabled:text-blue-500"
                      >
                        {selected ? "Selected" : "View Run"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
