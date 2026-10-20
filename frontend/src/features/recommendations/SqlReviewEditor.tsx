import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  Check, ClipboardCopy, Code2, RotateCcw, Save, X,
} from "lucide-react";

type Props = {
  ruleId: string;
  description: string;
  sourceSql: string | null;
  reviewedSql: string;
  resultMode: "violation_rows" | "violation_count";
  onSave: (value: string) => void;
  onClose: () => void;
};

function lineNumbers(value: string): string {
  return Array.from(
    { length: Math.max(1, value.split("\n").length) },
    (_, index) => String(index + 1),
  ).join("\n");
}

/** Local draft editor only. No SQL requests or execution. */
export default function SqlReviewEditor({
  ruleId,
  description,
  sourceSql,
  reviewedSql,
  resultMode,
  onSave,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(reviewedSql);
  const [tab, setTab] = useState<"draft" | "source">("draft");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const dirty = draft !== reviewedSql;
  const source = sourceSql ?? "";

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  function commit() {
    onSave(draft);
    onClose();
  }

  function onEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const value = draft.slice(0, start) + "  " + draft.slice(end);
      setDraft(value);
      requestAnimationFrame(() => {
        el.selectionStart = start + 2;
        el.selectionEnd = start + 2;
      });
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  }

  function handleDialogKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-2 backdrop-blur-sm sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="sql-review-dialog-title"
        onKeyDown={handleDialogKey}
        className="flex h-[min(92vh,930px)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-[#101a2e] text-slate-100 shadow-2xl"
      >
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-slate-700 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-300">
              <Code2 size={16} /> Spark SQL review workspace
            </div>
            <h2 id="sql-review-dialog-title" className="mt-2 text-base font-semibold leading-6 text-white">
              {description}
            </h2>
            <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{ruleId}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close SQL editor"
            className="rounded-lg p-2 text-slate-300 hover:bg-white/10 hover:text-white">
            <X size={19} />
          </button>
        </header>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-700 bg-[#16233b] px-5 py-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setTab("draft")}
              className={`rounded-lg px-3 py-2 text-xs font-semibold ${tab === "draft" ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "text-slate-400 hover:text-white"}`}>
              Reviewed SQL {dirty ? "• unsaved" : ""}
            </button>
            <button type="button" onClick={() => setTab("source")}
              className={`rounded-lg px-3 py-2 text-xs font-semibold ${tab === "source" ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "text-slate-400 hover:text-white"}`}>
              Original generated SQL
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="rounded-md bg-amber-500/10 px-2.5 py-1 text-amber-300">Not executed or validated</span>
            <span className="rounded-md bg-slate-700/60 px-2.5 py-1">
              {resultMode === "violation_rows" ? "Returns violating rows" : "Returns violation_count"}
            </span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-400">
              {tab === "draft" ? "Edit your local SQL draft. Changes are saved only when you choose Save draft." : "Read-only original SQL from this recommendation."}
            </p>
            <div className="flex flex-wrap gap-2">
              {tab === "draft" && (
                <button type="button" onClick={() => { setDraft(source); setCopied(false); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-700">
                  <RotateCcw size={14} /> Use original
                </button>
              )}
              <button type="button" onClick={() => void copy(tab === "draft" ? draft : source)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-700">
                {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-600 bg-[#0b1425] font-mono text-[13px] leading-6">
            <pre ref={gutterRef} aria-hidden="true"
              className="min-w-12 select-none overflow-hidden border-r border-slate-700 bg-[#101d33] px-3 py-4 text-right text-slate-500"
            >{lineNumbers(tab === "draft" ? draft : source)}</pre>
            {tab === "draft" ? (
              <textarea
                ref={areaRef}
                aria-label="Edit Spark SQL draft"
                value={draft}
                onChange={(event) => { setDraft(event.target.value); setCopied(false); }}
                onKeyDown={onEditorKeyDown}
                onScroll={(event) => {
                  if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                }}
                spellCheck={false}
                wrap="off"
                placeholder="-- Enter a Spark SQL query to review (nothing will execute)"
                className="h-full min-h-56 w-full flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-4 py-4 text-sky-100 outline-none placeholder:text-slate-600"
              />
            ) : (
              <pre className="h-full min-h-56 w-full flex-1 overflow-auto whitespace-pre px-4 py-4 text-sky-100">{source || "No SQL was generated for this recommendation."}</pre>
            )}
          </div>
          {copyError && <p role="alert" className="mt-2 text-xs text-red-300">Unable to access clipboard.</p>}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-700 bg-[#16233b] px-5 py-4">
          <p className="text-xs text-slate-400">Local-only editor · Tab indents · Ctrl/⌘ + Enter saves · Escape closes</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose}
              className="rounded-lg border border-slate-600 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700">
              Cancel
            </button>
            <button type="button" onClick={commit}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-4 py-2.5 text-xs font-semibold text-white hover:bg-blue-400">
              <Save size={15} /> Save draft
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
