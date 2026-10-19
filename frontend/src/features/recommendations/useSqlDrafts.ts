import { useState } from "react";
import type { ReviewRule } from "./api";

// Drafts never replace the original recommendation or generated SQL.
// They are scoped to a run and only reused if the source SQL still matches.
const PREFIX = "dq-studio:sql-drafts:";
interface Draft { source: string | null; text: string }
type Drafts = Record<string, Draft>;

function readDrafts(runId: string | null): Drafts {
  if (!runId) return {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFIX + runId) || "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const records: Drafts = {};
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rec = value as Record<string, unknown>;
      if (typeof rec.text !== "string") continue;
      if (rec.source !== null && typeof rec.source !== "string") continue;
      records[id] = { source: rec.source as string | null, text: rec.text };
    }
    return records;
  } catch {
    return {};
  }
}

export function useSqlDrafts(runId: string | null) {
  const [state, setState] = useState<{ runId: string | null; drafts: Drafts }>(
    () => ({ runId, drafts: readDrafts(runId) }),
  );
  const drafts = state.runId === runId ? state.drafts : readDrafts(runId);

  function currentSql(rule: ReviewRule): string {
    const original = rule.validation_sql ?? null;
    const saved = drafts[rule.id];
    return saved && saved.source === original ? saved.text : (original ?? "");
  }

  function setDraft(rule: ReviewRule, text: string) {
    if (!runId) return;
    const original = rule.validation_sql ?? null;
    const next = { ...drafts };
    if (text === (original ?? "")) delete next[rule.id];
    else next[rule.id] = { source: original, text };
    try { localStorage.setItem(PREFIX + runId, JSON.stringify(next)); }
    catch { /* Editing remains usable if storage is unavailable. */ }
    setState({ runId, drafts: next });
  }

  function restore(rule: ReviewRule) {
    setDraft(rule, rule.validation_sql ?? "");
  }

  return { currentSql, setDraft, restore };
}
