"""Safely patch only the latest committed RecommendationsPage.tsx.

The backend and editor files in this ZIP are full replacements. This script
makes two small, guarded edits to the user's current page instead of replacing
a 900-line component with an out-of-date copy. No GitHub access or SQL execution.
"""
from __future__ import annotations

import argparse
from pathlib import Path


def replace_once(source: str, before: str, after: str, filename: Path) -> str:
    if after in source:
        return source
    n = source.count(before)
    if n != 1:
        raise RuntimeError(
            f"{filename}: expected exactly one anchor but found {n}: {before[:85]!r}. "
            "No files were changed."
        )
    return source.replace(before, after, 1)


def patch(source: str, filename: Path) -> str:
    source = replace_once(
        source,
        'import { useQuery } from "@tanstack/react-query";',
        'import { useQuery, useQueryClient } from "@tanstack/react-query";',
        filename,
    )
    source = replace_once(
        source,
        '  type TraditionalChecksResponse,\n',
        '  type TraditionalChecksResponse,\n  type RecommendationsResponse,\n',
        filename,
    )
    source = replace_once(
        source,
        'export default function RecommendationsPage() {\n',
        'export default function RecommendationsPage() {\n  const queryClient = useQueryClient();\n',
        filename,
    )
    before = '''  function onTraditionalSaved(result: TraditionalChecksResponse) {
    const next = new Set([...selectedIds].filter((id) => !id.startsWith("traditional:")));
    for (const item of result.rules) next.add(item.id);
    updateSelection(next);
    setTraditionalOpen(false);
    void recommendationsQuery.refetch();
  }'''
    after = '''  function onTraditionalSaved(result: TraditionalChecksResponse) {
    // The POST response already contains the complete generated rules. Update
    // React Query immediately so IDs are known BEFORE selection is refreshed.
    const grouped: NonNullable<RecommendationsResponse["traditional_rules"]> = {};
    for (const rule of result.rules) {
      (grouped[rule.table_name] ??= []).push(rule);
    }
    queryClient.setQueryData<RecommendationsResponse>(
      ["recommendations", runId],
      (previous) => previous && ({
        ...previous,
        available: { ...previous.available, traditional: true },
        traditional_rules: grouped,
      }),
    );

    // Existing checks keep their selected/unselected review state. New checks
    // are selected automatically; removed checks are dropped from selection.
    const previousTrad = new Set(
      rules.filter((rule) => rule.scope === "traditional").map((rule) => rule.id),
    );
    const nextIds = new Set(result.rules.map((rule) => rule.id));
    const next = new Set(selectedIds);
    for (const id of previousTrad) {
      if (!nextIds.has(id)) next.delete(id);
    }
    for (const id of nextIds) {
      if (!previousTrad.has(id)) next.add(id);
    }
    updateSelection(next);
    setTraditionalOpen(false);
    void recommendationsQuery.refetch();
  }'''
    source = replace_once(source, before, after, filename)
    return source


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("repo", nargs="?", default=".", help="Repository root")
    args = parser.parse_args()
    root = Path(args.repo).resolve()
    target = root / "frontend/src/pages/RecommendationsPage.tsx"
    if not target.is_file():
        raise SystemExit(f"Missing {target}")
    original = target.read_text(encoding="utf-8")
    updated = patch(original, target)
    if updated != original:
        target.write_text(updated, encoding="utf-8")
        print(f"Updated {target.relative_to(root)}")
    else:
        print("RecommendationsPage.tsx already patched")
    print("No GitHub changes. No SQL execution.")


if __name__ == "__main__":
    main()
