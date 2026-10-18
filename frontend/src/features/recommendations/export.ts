import type { ReviewRule } from "./api";

export type ExportFormat = "json" | "csv";

function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  // Protect spreadsheet users from formula injection. The original SQL and
  // descriptions remain completely unchanged in the JSON export.
  if (/^[\s\uFEFF]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportSelection(
  runId: string,
  rules: ReviewRule[],
  format: ExportFormat,
): void {
  if (rules.length === 0) return;

  const exportedAt = new Date().toISOString();
  const name = `dq-rules-${runId}-${exportedAt.replace(/[:.]/g, "-")}`;

  const selectedRules = rules.map((r) => ({
    id: r.id,
    scope: r.scope,
    table_name: r.table_name,
    rule: r.rule,
    description: r.description,
    proposed_relation: r.proposed_relation,
    impact: {
      level: r.impact.level,
      reason: r.impact.reason,
    },
  }));

  let blob: Blob;
  if (format === "json") {
    blob = new Blob(
      [
        JSON.stringify(
          {
            format: "dq_studio_rule_selection",
            version: 1,
            run_id: runId,
            exported_at: exportedAt,
            selection_count: selectedRules.length,
            rules: selectedRules,
          },
          null,
          2,
        ),
      ],
      { type: "application/json;charset=utf-8" },
    );
  } else {
    const fields = [
      "rule_id",
      "scope",
      "table_name",
      "impact_level",
      "proposed_relation",
      "description",
      "rule",
      "impact_reason",
    ];
    const lines = [fields.map(csvCell).join(",")];
    for (const r of rules) {
      lines.push(
        [
          r.id,
          r.scope,
          r.table_name,
          r.impact.level,
          r.proposed_relation,
          r.description,
          r.rule,
          r.impact.reason,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    blob = new Blob(["\uFEFF", lines.join("\r\n"), "\r\n"], {
      type: "text/csv;charset=utf-8",
    });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
