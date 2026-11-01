
"""Prepare isolated, scoped recommendation inputs from saved profiles.

The parent discovery run is always read-only.

Individual-table preparation and inter-table consolidation are separate
operations so they can become independent Graph 2 nodes.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

import yaml

from app.services.reusable_run_store import read_json, write_json
from app.services.inter_table_profiler import build_inter_table_profile


class SelectionError(ValueError):
    """Invalid table/column selection or missing profile context."""


def prepare_inputs(
    parent: Path,
    child: Path | None,
    selections: dict[str, list[str]],
    *,
    include_inter_table: bool = True,
) -> dict[str, Any]:
    """Validate selections and prepare isolated recommendation inputs.

    include_inter_table=True preserves the existing API behavior.
    Graph 2 will instead call prepare_scoped_inputs().
    """

    matching = read_json(
        parent / "discovery" / "matching_results.json"
    )
    matched = set(matching.get("columns_matched_tables", []))

    if not matched or not selections:
        raise SelectionError(
            "No matched tables or no table selection"
        )

    if (
        len(selections) > 200
        or sum(len(v) for v in selections.values()) > 10000
    ):
        raise SelectionError("Selection exceeds supported limits")

    originals: dict[str, dict[str, Any]] = {}
    individual: dict[str, dict[str, Any]] = {}
    chosen: dict[str, set[str]] = {}

    # 1. Load and validate selected table profiles.
    for table, columns in selections.items():
        if (
            table not in matched
            or not isinstance(columns, list)
            or not columns
        ):
            raise SelectionError(
                f"Missing, unmatched, or empty table selection: {table}"
            )

        if (
            not all(isinstance(c, str) and c for c in columns)
            or len(set(columns)) != len(columns)
        ):
            raise SelectionError(
                f"Invalid or duplicate columns selected for {table}"
            )

        if (
            table in {".", ".."}
            or "/" in table
            or "\\" in table
        ):
            raise SelectionError(f"Invalid table name: {table}")

        path = (
            parent / "consolidated_profiles" / f"{table}.yaml"
        )

        if not path.is_file():
            raise SelectionError(
                f"Missing profile for {table}"
            )

        source = yaml.safe_load(
            path.read_text(encoding="utf-8")
        )

        if (
            not isinstance(source, dict)
            or source.get("table_name") != table
            or not isinstance(source.get("columns"), dict)
        ):
            raise SelectionError(
                f"Malformed consolidated profile for {table}"
            )

        missing = set(columns) - set(source["columns"])

        if missing:
            raise SelectionError(
                f"Unknown columns for {table}: "
                f"{', '.join(sorted(missing))}"
            )

        originals[table] = source
        chosen[table] = set(columns)

        # Only selected columns enter individual LLM prompts.
        individual[table] = {
            **source,
            "columns": {
                name: source["columns"][name]
                for name in columns
            },
        }

    # 2. Identify relevant relationships and supporting join keys.
    source_relationships = read_json(
        parent / "discovery" / "relationships.json"
    )

    filtered_fks: list[dict[str, Any]] = []
    context_fields: dict[str, set[str]] = {
        name: set() for name in chosen
    }

    for relation in source_relationships.get(
        "foreign_keys", []
    ):
        if not isinstance(relation, dict):
            raise SelectionError(
                "Malformed foreign key definition"
            )

        from_table = relation.get("from_table")
        to_table = relation.get("to_table")
        from_column = relation.get("from_column")
        to_column = relation.get("to_column")

        # Relationships involving unselected tables are excluded.
        if (
            from_table not in originals
            or to_table not in originals
        ):
            continue

        if (
            from_column not in originals[from_table]["columns"]
            or to_column not in originals[to_table]["columns"]
        ):
            raise SelectionError(
                "Relationship refers to a missing column: "
                f"{from_table}.{from_column} -> "
                f"{to_table}.{to_column}"
            )

        filtered_fks.append(relation)

        context_fields[from_table].add(from_column)
        context_fields[to_table].add(to_column)

    cross_ready = (
        len(individual) >= 2
        and bool(filtered_fks)
    )

    summary = {
        "tables": sorted(individual),
        "target_column_count": sum(
            len(columns) for columns in chosen.values()
        ),
        "supporting_join_columns": {
            table: sorted(context_fields[table] - chosen[table])
            for table in chosen
        },
        "included_relationship_count": len(filtered_fks),
        "cross_table_ready": cross_ready,
    }

    # Validation only: do not create any artifacts.
    if child is None:
        return summary

    # 3. Save selected per-table YAMLs in the child run.
    individual_dir = child / "consolidated_profiles"
    individual_dir.mkdir(parents=True, exist_ok=True)

    # Never leave an old inter-table result after preparing a scope.
    (
        individual_dir / "inter_table_consolidated.yaml"
    ).unlink(missing_ok=True)

    for table, profile in individual.items():
        target = individual_dir / f"{table}.yaml"

        target.write_text(
            yaml.safe_dump(
                profile,
                sort_keys=False,
                allow_unicode=True,
            ),
            encoding="utf-8",
        )

    # 4. Copy only lightweight discovery metadata required
    # by the existing traditional-check service.
    discovery_dir = child / "discovery"

    (discovery_dir / "tables").mkdir(
        parents=True, exist_ok=True
    )
    (discovery_dir / "configs").mkdir(
        parents=True, exist_ok=True
    )

    for table in individual:
        source = (
            parent / "discovery" / "tables" / f"{table}.json"
        )

        if source.is_file():
            shutil.copyfile(
                source,
                discovery_dir / "tables" / f"{table}.json",
            )

    for source in (
        parent / "discovery" / "configs"
    ).glob("*.json"):
        if source.name == "relationships.json":
            continue

        try:
            config = read_json(source)
        except ValueError:
            continue

        if config.get("table_name") in individual:
            shutil.copyfile(
                source,
                discovery_dir / "configs" / source.name,
            )

    write_json(
        discovery_dir / "matching_results.json",
        {
            **matching,
            "columns_matched_tables": sorted(individual),
        },
    )

    write_json(
        discovery_dir / "relationships.json",
        {"foreign_keys": filtered_fks},
    )

    # 5. Persist the exact selection and its relationship context.
    write_json(
        child / "selection_snapshot.json",
        {
            "selections": selections,
            "context": summary,
        },
    )

    # Compatibility with the current reusable_routes.py:
    # the legacy caller still prepares both inputs at once.
    if cross_ready and include_inter_table:
        consolidate_scoped_inter_table(parent, child)

    return summary


def prepare_scoped_inputs(
    parent: Path,
    child: Path,
    selections: dict[str, list[str]],
) -> dict[str, Any]:
    """Graph 2 preparation: produce individual YAMLs only.

    Inter-table consolidation is deliberately NOT executed here.
    """

    return prepare_inputs(
        parent,
        child,
        selections,
        include_inter_table=False,
    )


def consolidate_scoped_inter_table(
    parent: Path,
    child: Path,
) -> dict[str, Any] | None:
    """Create the scoped inter-table YAML as a separate operation.

    Reads the selection snapshot from the child and original profiles
    from the immutable parent.

    Returns None when cross-table consolidation is not applicable.
    """

    snapshot = read_json(
        child / "selection_snapshot.json"
    )

    selections = snapshot.get("selections")
    context = snapshot.get("context")

    if (
        not isinstance(selections, dict)
        or not isinstance(context, dict)
    ):
        raise SelectionError(
            "Invalid recommendation selection snapshot"
        )

    if not context.get("cross_table_ready"):
        return None

    supporting = context.get("supporting_join_columns")

    if not isinstance(supporting, dict):
        raise SelectionError(
            "Missing supporting relationship columns"
        )

    # 1. Build cross-table profiles with target + join columns.
    cross_profiles: dict[str, dict[str, Any]] = {}

    for table, columns in selections.items():
        if (
            not isinstance(table, str)
            or table in {".", ".."}
            or "/" in table
            or "\\" in table
            or not isinstance(columns, list)
        ):
            raise SelectionError("Invalid saved table selection")

        source_path = (
            parent / "consolidated_profiles" / f"{table}.yaml"
        )

        source = yaml.safe_load(
            source_path.read_text(encoding="utf-8")
        )

        if (
            not isinstance(source, dict)
            or source.get("table_name") != table
            or not isinstance(source.get("columns"), dict)
        ):
            raise SelectionError(
                f"Invalid parent profile for {table}"
            )

        allowed_columns = (
            set(columns)
            | set(supporting.get(table, []))
        )

        if not allowed_columns <= set(source["columns"]):
            raise SelectionError(
                f"Unknown scoped columns for {table}"
            )

        cross_profiles[table] = {
            **source,
            "columns": {
                name: details
                for name, details in source["columns"].items()
                if name in allowed_columns
            },
        }

    # 2. Use the existing inter-table consolidation algorithm.
    relationships = read_json(
        child / "discovery" / "relationships.json"
    )

    combined = build_inter_table_profile(
        cross_profiles,
        relationships,
    )

    # 3. Distinguish recommendation targets from supporting joins.
    for table, block in combined["tables"].items():
        selected_columns = set(selections[table])

        for column_name, column in block["columns"].items():
            column["recommendation_target"] = (
                column_name in selected_columns
            )

    # 4. Save into this recommendation run, never the parent.
    output_path = (
        child
        / "consolidated_profiles"
        / "inter_table_consolidated.yaml"
    )

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    output_path.write_text(
        yaml.safe_dump(
            combined,
            sort_keys=False,
            allow_unicode=True,
        ),
        encoding="utf-8",
    )

    return {
        "inter_table_profile_path": str(
            output_path.resolve()
        ),
        "inter_table_profile_table_count": len(
            combined["tables"]
        ),
        "inter_table_profile_foreign_key_count": len(
            combined["relationships"]["foreign_keys"]
        ),
    }


def validate_selection(
    parent: Path,
    selections: dict[str, list[str]],
) -> dict[str, Any]:
    """Validate without writing any child artifacts."""

    return prepare_inputs(
        parent,
        None,
        selections,
    )
