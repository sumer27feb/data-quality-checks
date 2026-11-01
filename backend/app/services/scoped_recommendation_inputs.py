"""Produce independent recommendation input snapshots without re-profiling.

Individual LLM sees precisely selected columns. Cross-table context additionally
includes declared FK join columns, but does not introduce unselected tables.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import yaml

from app.services.reusable_run_store import read_json, write_json


class SelectionError(ValueError):
    pass


def prepare_inputs(parent: Path, child: Path | None, selections: dict[str, list[str]]) -> dict[str, Any]:
    matching = read_json(parent / "discovery" / "matching_results.json")
    matched = set(matching.get("columns_matched_tables", []))
    if not matched or not selections:
        raise SelectionError("No matched tables or no table selection")
    if len(selections) > 200 or sum(len(v) for v in selections.values()) > 10000:
        raise SelectionError("Selection exceeds supported limits")

    originals: dict[str, dict[str, Any]] = {}
    individual: dict[str, dict[str, Any]] = {}
    chosen: dict[str, set[str]] = {}
    for table, columns in selections.items():
        if table not in matched or not isinstance(columns, list) or not columns:
            raise SelectionError(f"Missing, unmatched, or empty table selection: {table}")
        if not all(isinstance(c, str) and c for c in columns) or len(set(columns)) != len(columns):
            raise SelectionError(f"Invalid or duplicate columns selected for {table}")
        path = parent / "consolidated_profiles" / f"{table}.yaml"
        if not path.is_file() or table in {".", ".."} or "/" in table or "\\" in table:
            raise SelectionError(f"Missing profile for {table}")
        source = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(source, dict) or source.get("table_name") != table or not isinstance(source.get("columns"), dict):
            raise SelectionError(f"Malformed consolidated profile for {table}")
        missing = set(columns) - set(source["columns"])
        if missing:
            raise SelectionError(f"Unknown columns for {table}: {', '.join(sorted(missing))}")
        originals[table] = source
        chosen[table] = set(columns)
        individual[table] = {
            **source,
            "columns": {name: source["columns"][name] for name in columns},
        }

    source_relationships = read_json(parent / "discovery" / "relationships.json")
    filtered_fks = []
    context_fields: dict[str, set[str]] = {name: set() for name in chosen}
    for rel in source_relationships.get("foreign_keys", []):
        if not isinstance(rel, dict):
            raise SelectionError("Malformed foreign key definition")
        a, b = rel.get("from_table"), rel.get("to_table")
        col_a, col_b = rel.get("from_column"), rel.get("to_column")
        if a not in originals or b not in originals:
            continue
        if col_a not in originals[a]["columns"] or col_b not in originals[b]["columns"]:
            raise SelectionError(f"Relationship refers to a missing column: {a}.{col_a} -> {b}.{col_b}")
        # Preserve declared joins between the chosen tables as support context.
        filtered_fks.append(rel)
        context_fields[a].add(col_a)
        context_fields[b].add(col_b)

    cross_ready = len(individual) >= 2 and bool(filtered_fks)
    if child is None:
        return {"tables": sorted(individual), "target_column_count": sum(len(s) for s in chosen.values()), "cross_table_ready": cross_ready}

    individual_dir = child / "consolidated_profiles"
    individual_dir.mkdir(parents=True, exist_ok=True)
    for table, source in individual.items():
        (individual_dir / f"{table}.yaml").write_text(
            yaml.safe_dump(source, sort_keys=False, allow_unicode=True), encoding="utf-8"
        )

    # Existing deterministic traditional rule service uses per-run discovery
    # artifacts, so copy just the selected table's light metadata, not profiles.
    discovery_dir = child / "discovery"
    (discovery_dir / "tables").mkdir(parents=True, exist_ok=True)
    (discovery_dir / "configs").mkdir(parents=True, exist_ok=True)
    for table in individual:
        src = parent / "discovery" / "tables" / f"{table}.json"
        if src.is_file():
            shutil.copyfile(src, discovery_dir / "tables" / f"{table}.json")
    for src in (parent / "discovery" / "configs").glob("*.json"):
        if src.name == "relationships.json":
            continue
        try:
            config = read_json(src)
        except ValueError:
            continue
        if config.get("table_name") in individual:
            shutil.copyfile(src, discovery_dir / "configs" / src.name)
    write_json(discovery_dir / "matching_results.json", {
        **matching,
        "columns_matched_tables": sorted(individual),
    })
    write_json(discovery_dir / "relationships.json", {"foreign_keys": filtered_fks})

    # Cross-table YAML is generated separately: it has FK support columns not
    # exposed to the individual-table rule recommender.
    if cross_ready:
        from app.services.inter_table_profiler import build_inter_table_profile
        cross_profiles = {
            table: {
                **originals[table],
                "columns": {
                    name: col for name, col in originals[table]["columns"].items()
                    if name in chosen[table] or name in context_fields[table]
                },
            }
            for table in individual
        }
        cross_yaml = build_inter_table_profile(cross_profiles, {"foreign_keys": filtered_fks})
        for table, block in cross_yaml["tables"].items():
            for col, column in block["columns"].items():
                column["recommendation_target"] = col in chosen[table]
        (individual_dir / "inter_table_consolidated.yaml").write_text(
            yaml.safe_dump(cross_yaml, sort_keys=False, allow_unicode=True), encoding="utf-8"
        )

    output = {
        "tables": sorted(individual),
        "target_column_count": sum(len(s) for s in chosen.values()),
        "supporting_join_columns": {k: sorted(v - chosen[k]) for k, v in context_fields.items()},
        "included_relationship_count": len(filtered_fks),
        "cross_table_ready": cross_ready,
    }
    write_json(child / "selection_snapshot.json", {
        "selections": selections,
        "context": output,
    })
    return output


def validate_selection(parent: Path, selections: dict[str, list[str]]) -> dict[str, Any]:
    """Validate a selection without writing child artifacts."""
    return prepare_inputs(parent, None, selections)
