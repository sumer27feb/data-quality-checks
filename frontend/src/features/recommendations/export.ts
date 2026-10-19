import type { ReviewRule } from "./api";

export type ExportFormat = "json" | "csv" | "sql";
export interface ExportableRule extends ReviewRule {
  // The locally reviewed text, which may differ from generated validation_sql.
  reviewed_sql: string | null;
}

function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? "" : String(value);
  // Protect spreadsheet consumers without changing JSON or .sql exports.
  if (/^[\s\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportSelection(
  runId: string,
  rules: ExportableRule[],
  format: ExportFormat,
): void {
  if (!rules.length) return;
  const exportedAt = new Date().toISOString();
  const name = `dq-rules-${runId}-${exportedAt.replace(/[:.]/g, "-")}`;
  const items = rules.map((r) => ({
    id: r.id,
    scope: r.scope,
    table_name: r.table_name,
    rule: r.rule,
    validation_sql: r.validation_sql,
    sql_generation_note: r.sql_generation_note,
    reviewed_sql: r.reviewed_sql,
    sql_modified: r.reviewed_sql !== r.validation_sql,
    description: r.description,
    proposed_relation: r.proposed_relation,
    impact: r.impact,
  }));

  if (format === "json") {
    download(
      `${name}.json`,
      JSON.stringify(
        {
          format: "dq_studio_rule_selection",
          version: 2,
          run_id: runId,
          exported_at: exportedAt,
          selection_count: items.length,
          sql_available_count: items.filter((r) => r.reviewed_sql?.trim())
            .length,
          sql_validation_performed: false,
          rules: items,
        },
        null,
        2,
      ) + "\n",
      "application/json;charset=utf-8",
    );
    return;
  }

  if (format === "csv") {
    const fields = [
      "rule_id",
      "scope",
      "table_name",
      "impact_level",
      "proposed_relation",
      "description",
      "rule",
      "validation_sql",
      "sql_generation_note",
      "reviewed_sql",
      "sql_modified",
      "impact_reason",
    ];
    const lines = [fields.map(csvCell).join(",")];
    for (const r of items) {
      lines.push(
        [
          r.id,
          r.scope,
          r.table_name,
          r.impact.level,
          r.proposed_relation,
          r.description,
          r.rule,
          r.validation_sql,
          r.sql_generation_note,
          r.reviewed_sql,
          String(r.sql_modified),
          r.impact.reason,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    download(
      `${name}.csv`,
      "\uFEFF" + lines.join("\r\n") + "\r\n",
      "text/csv;charset=utf-8",
    );
    return;
  }

  // SQL export includes only rules with nonempty reviewed SQL; nothing executes here.
  // The original generated SQL remains available in JSON alongside local edits.
  const available = items.filter((r) => r.reviewed_sql?.trim());
  if (!available.length) return;
  const omitted = items.length - available.length;
  const parts = [
    `-- DQ Studio | Run: ${runId}`,
    `-- Exported: ${exportedAt}`,
    "-- REVIEW REQUIRED: SQL has not been parsed, analyzed or executed by this app.",
    "-- Confirm catalog/schema and business meaning before running.",
    `-- Included: ${available.length}; omitted (no SQL): ${omitted}`,
  ];
  for (const r of available) {
    // IDs are generated locally and have no newlines in the existing contract.
    parts.push(
      "",
      `-- Rule: ${r.id}`,
      `-- Source: ${r.sql_modified ? "locally edited" : "LLM generated"}`,
      `${r.reviewed_sql!.trim().replace(/;+\s*$/, "")};`,
    );
  }
  download(`${name}.sql`, parts.join("\n") + "\n", "text/plain;charset=utf-8");
}
