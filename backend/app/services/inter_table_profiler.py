"""Build one compact YAML for cross-table relationship inference.

Reads the per-table consolidated YAML files and the user-provided relationships
JSON. Does not query Databricks or call an LLM.

Run from backend/:
    python -m services.inter_table_consolidation_service \
        --artifacts-root artifacts/workspace.data_quality_rules \
        --relationships-json artifacts/workspace.data_quality_rules/discovery/configs/relationships.json

Requires PyYAML.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


OUTPUT_FILENAME = "inter_table_consolidated.yaml"
DEFAULT_RELATIONSHIPS_RELATIVE_PATH = Path("discovery/configs/relationships.json")


class InterTableConsolidationError(ValueError):
    """Missing, malformed, or inconsistent consolidation input."""


@dataclass(frozen=True)
class InterTableConsolidationResult:
    output_path: Path
    table_count: int
    foreign_key_count: int


def _object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InterTableConsolidationError(f"{location} must be an object")
    return value


def _text(obj: dict[str, Any], field: str, location: str) -> str:
    value = obj.get(field)
    if not isinstance(value, str) or not value.strip():
        raise InterTableConsolidationError(f"{location}.{field} must be a non-empty string")
    return value


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        return _object(yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
    except (OSError, yaml.YAMLError) as exc:
        raise InterTableConsolidationError(f"Cannot read YAML {path}: {exc}") from exc


def _load_json(path: Path) -> dict[str, Any]:
    try:
        return _object(json.loads(path.read_text(encoding="utf-8")), str(path))
    except (OSError, json.JSONDecodeError) as exc:
        raise InterTableConsolidationError(f"Cannot read relationships JSON {path}: {exc}") from exc


def build_inter_table_profile(
    per_table_profiles: dict[str, dict[str, Any]],
    relationships: dict[str, Any],
) -> dict[str, Any]:
    """Make the compact, YAML-ready object. No I/O.

    `per_table_profiles` maps filename stems to prior consolidated table objects.
    The existing per-table profiles already source datatype from expected_type.
    """
    if not per_table_profiles:
        raise InterTableConsolidationError("No per-table consolidated profiles provided")

    tables: dict[str, Any] = {}
    for filename_stem, raw_profile in sorted(per_table_profiles.items()):
        profile = _object(raw_profile, f"profile {filename_stem}")
        table_name = _text(profile, "table_name", f"profile {filename_stem}")
        if table_name != filename_stem:
            raise InterTableConsolidationError(
                f"Profile filename/table mismatch: {filename_stem!r} vs {table_name!r}"
            )

        semantics = _object(profile.get("table_semantics"), f"{table_name}.table_semantics")
        source_columns = _object(profile.get("columns"), f"{table_name}.columns")
        if not source_columns:
            raise InterTableConsolidationError(f"{table_name}.columns cannot be empty")

        columns: dict[str, dict[str, str]] = {}
        for column_name, raw_column in source_columns.items():
            if not isinstance(column_name, str) or not column_name.strip():
                raise InterTableConsolidationError(f"Invalid column name in {table_name}.columns")
            column = _object(raw_column, f"{table_name}.columns.{column_name}")
            columns[column_name] = {
                "datatype": _text(column, "datatype", f"{table_name}.columns.{column_name}"),
                "description": _text(column, "description", f"{table_name}.columns.{column_name}"),
            }

        tables[table_name] = {
            "description": _text(semantics, "description", f"{table_name}.table_semantics"),
            "row_grain": _text(semantics, "row_grain", f"{table_name}.table_semantics"),
            "columns": columns,
        }

    relationship_object = _object(relationships, "relationships")
    foreign_keys = relationship_object.get("foreign_keys")
    if not isinstance(foreign_keys, list):
        raise InterTableConsolidationError("relationships.foreign_keys must be a list")

    checked_keys: list[dict[str, str]] = []
    required = ("from_table", "from_column", "to_table", "to_column", "cardinality")
    for index, entry in enumerate(foreign_keys):
        location = f"relationships.foreign_keys[{index}]"
        relation = _object(entry, location)
        validated = {field: _text(relation, field, location) for field in required}

        for side in ("from", "to"):
            table_name = validated[f"{side}_table"]
            column_name = validated[f"{side}_column"]
            if table_name not in tables:
                raise InterTableConsolidationError(
                    f"{location}.{side}_table references missing table {table_name!r}"
                )
            if column_name not in tables[table_name]["columns"]:
                raise InterTableConsolidationError(
                    f"{location}.{side}_column references missing column "
                    f"{table_name}.{column_name}"
                )

        # Preserve the supplied cardinality as metadata, not a verified fact.
        # Do not enforce datatype equality or make up missing relationships.
        checked_keys.append(validated)

    return {"tables": tables, "relationships": {"foreign_keys": checked_keys}}


def generate_inter_table_profile(
    artifacts_root: str | Path,
    relationships_json_path: str | Path | None = None,
) -> InterTableConsolidationResult:
    """Read <table>.yaml files and write consolidated_profiles/inter_table_consolidated.yaml.

    By default, looks for the ER file under discovery/configs/relationships.json;
    pass relationships_json_path to use the actual filename/path if different.
    Existing output is overwritten only after all inputs validate successfully.
    """
    root = Path(artifacts_root)
    profile_dir = root / "consolidated_profiles"
    if not profile_dir.is_dir():
        raise InterTableConsolidationError(f"Input directory does not exist: {profile_dir}")

    source_files = sorted(
        path for path in profile_dir.glob("*.yaml") if path.name != OUTPUT_FILENAME
    )
    if not source_files:
        raise InterTableConsolidationError(f"No per-table consolidated YAMLs in {profile_dir}")

    profiles = {path.stem: _load_yaml(path) for path in source_files}
    er_path = (
        Path(relationships_json_path)
        if relationships_json_path is not None
        else root / DEFAULT_RELATIONSHIPS_RELATIVE_PATH
    )
    consolidated = build_inter_table_profile(profiles, _load_json(er_path))

    target = profile_dir / OUTPUT_FILENAME
    target.write_text(
        yaml.safe_dump(
            consolidated,
            sort_keys=False,
            allow_unicode=True,
            default_flow_style=False,
            width=120,
        ),
        encoding="utf-8",
    )
    return InterTableConsolidationResult(
        output_path=target,
        table_count=len(consolidated["tables"]),
        foreign_key_count=len(consolidated["relationships"]["foreign_keys"]),
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate one cross-table consolidated YAML from existing per-table YAMLs and ER JSON"
    )
    parser.add_argument(
        "--artifacts-root",
        required=True,
        type=Path,
        help="Dataset artifacts directory containing consolidated_profiles/",
    )
    parser.add_argument(
        "--relationships-json",
        type=Path,
        default=None,
        help="Path to ER relationships JSON (default: <artifacts-root>/discovery/configs/relationships.json)",
    )
    args = parser.parse_args()
    result = generate_inter_table_profile(args.artifacts_root, args.relationships_json)
    print(
        f"Wrote {result.output_path} "
        f"({result.table_count} tables, {result.foreign_key_count} foreign keys)"
    )


if __name__ == "__main__":
    main()
