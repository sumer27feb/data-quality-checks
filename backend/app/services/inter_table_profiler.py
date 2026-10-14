"""Build one compact YAML for cross-table relationship inference.

Reads per-table consolidated YAML files and a relationships JSON.
Does not query Databricks or call an LLM.

artifacts_root is the dataset directory itself, for example:
    artifacts/workspace.data_quality_rules

Inputs:
    <artifacts_root>/consolidated_profiles/<table>.yaml
    <artifacts_root>/discovery/relationships.json

Output:
    <artifacts_root>/consolidated_profiles/inter_table_consolidated.yaml

Run from backend/:
    python -m app.services.inter_table_profiler

Requires PyYAML.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.config import ARTIFACTS_ROOT


OUTPUT_FILENAME = "inter_table_consolidated.yaml"
DEFAULT_RELATIONSHIPS_RELATIVE_PATH = (
    Path("discovery") / "relationships.json"
)


class InterTableConsolidationError(ValueError):
    """Missing, malformed, or inconsistent consolidation input."""


@dataclass(frozen=True)
class InterTableConsolidationResult:
    output_path: Path
    table_count: int
    foreign_key_count: int


def _object(
    value: Any,
    location: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InterTableConsolidationError(
            f"{location} must be an object"
        )

    return value


def _text(
    obj: dict[str, Any],
    field: str,
    location: str,
) -> str:
    value = obj.get(field)

    if not isinstance(value, str) or not value.strip():
        raise InterTableConsolidationError(
            f"{location}.{field} must be a non-empty string"
        )

    return value


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        content = yaml.safe_load(
            path.read_text(encoding="utf-8")
        )
    except (OSError, UnicodeDecodeError, yaml.YAMLError) as exc:
        raise InterTableConsolidationError(
            f"Cannot read YAML {path}: {exc}"
        ) from exc

    return _object(content, str(path))


def _load_json(path: Path) -> dict[str, Any]:
    try:
        content = json.loads(
            path.read_text(encoding="utf-8-sig")
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InterTableConsolidationError(
            f"Cannot read relationships JSON {path}: {exc}"
        ) from exc

    return _object(content, str(path))


def build_inter_table_profile(
    per_table_profiles: dict[str, dict[str, Any]],
    relationships: dict[str, Any],
) -> dict[str, Any]:
    """Build the compact YAML-ready object without I/O.

    per_table_profiles maps filename stems to consolidated table objects.
    Datatypes come from the expected types in those profiles.
    """
    if not per_table_profiles:
        raise InterTableConsolidationError(
            "No per-table consolidated profiles provided"
        )

    tables: dict[str, Any] = {}

    for filename_stem, raw_profile in sorted(
        per_table_profiles.items()
    ):
        profile_location = f"profile {filename_stem}"
        profile = _object(raw_profile, profile_location)

        table_name = _text(
            profile,
            "table_name",
            profile_location,
        )

        if table_name != filename_stem:
            raise InterTableConsolidationError(
                "Profile filename/table mismatch: "
                f"{filename_stem!r} vs {table_name!r}"
            )

        semantics_location = f"{table_name}.table_semantics"

        semantics = _object(
            profile.get("table_semantics"),
            semantics_location,
        )
        source_columns = _object(
            profile.get("columns"),
            f"{table_name}.columns",
        )

        if not source_columns:
            raise InterTableConsolidationError(
                f"{table_name}.columns cannot be empty"
            )

        columns: dict[str, dict[str, str]] = {}

        for column_name, raw_column in source_columns.items():
            if (
                not isinstance(column_name, str)
                or not column_name.strip()
            ):
                raise InterTableConsolidationError(
                    f"Invalid column name in {table_name}.columns"
                )

            column_location = (
                f"{table_name}.columns.{column_name}"
            )
            column = _object(raw_column, column_location)

            columns[column_name] = {
                "datatype": _text(
                    column,
                    "datatype",
                    column_location,
                ),
                "description": _text(
                    column,
                    "description",
                    column_location,
                ),
            }

        tables[table_name] = {
            "description": _text(
                semantics,
                "description",
                semantics_location,
            ),
            "row_grain": _text(
                semantics,
                "row_grain",
                semantics_location,
            ),
            "columns": columns,
        }

    relationship_object = _object(
        relationships,
        "relationships",
    )
    foreign_keys = relationship_object.get("foreign_keys")

    if not isinstance(foreign_keys, list):
        raise InterTableConsolidationError(
            "relationships.foreign_keys must be a list"
        )

    checked_keys: list[dict[str, str]] = []
    required_fields = (
        "from_table",
        "from_column",
        "to_table",
        "to_column",
        "cardinality",
    )

    for index, entry in enumerate(foreign_keys):
        location = f"relationships.foreign_keys[{index}]"
        relation = _object(entry, location)

        validated = {
            field: _text(relation, field, location)
            for field in required_fields
        }

        for side in ("from", "to"):
            table_name = validated[f"{side}_table"]
            column_name = validated[f"{side}_column"]

            if table_name not in tables:
                raise InterTableConsolidationError(
                    f"{location}.{side}_table references "
                    f"missing table {table_name!r}"
                )

            if column_name not in tables[table_name]["columns"]:
                raise InterTableConsolidationError(
                    f"{location}.{side}_column references "
                    f"missing column {table_name}.{column_name}"
                )

        # Cardinality is supplied metadata, not a verified fact.
        # Do not enforce datatype equality or invent relationships.
        checked_keys.append(validated)

    return {
        "tables": tables,
        "relationships": {
            "foreign_keys": checked_keys,
        },
    }


def generate_inter_table_profile(
    artifacts_root: str | Path | None = None,
    relationships_json_path: str | Path | None = None,
) -> InterTableConsolidationResult:
    """Read per-table profiles and write the inter-table YAML.

    artifacts_root is the dataset directory itself.
    An explicit argument overrides the app.config default.

    Without an override, relationships are read from:
        <artifacts_root>/discovery/relationships.json

    An explicit relative relationships_json_path is resolved against
    the current working directory, not against artifacts_root.

    All inputs are validated before writing the output.
    """
    root = Path(
        artifacts_root
        if artifacts_root is not None
        else ARTIFACTS_ROOT
    ).resolve()

    profile_dir = root / "consolidated_profiles"

    if not profile_dir.is_dir():
        raise InterTableConsolidationError(
            f"Input directory does not exist: {profile_dir}"
        )

    source_files = sorted(
        path
        for path in profile_dir.glob("*.yaml")
        if path.name != OUTPUT_FILENAME
    )

    if not source_files:
        raise InterTableConsolidationError(
            f"No per-table consolidated YAMLs in {profile_dir}"
        )

    profiles = {
        path.stem: _load_yaml(path)
        for path in source_files
    }

    relationships_path = (
        Path(relationships_json_path).resolve()
        if relationships_json_path is not None
        else root / DEFAULT_RELATIONSHIPS_RELATIVE_PATH
    )

    consolidated = build_inter_table_profile(
        profiles,
        _load_json(relationships_path),
    )

    # Serialize before opening the existing output for writing.
    yaml_content = yaml.safe_dump(
        consolidated,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=120,
    )

    target = profile_dir / OUTPUT_FILENAME
    target.write_text(
        yaml_content,
        encoding="utf-8",
    )

    return InterTableConsolidationResult(
        output_path=target,
        table_count=len(consolidated["tables"]),
        foreign_key_count=len(
            consolidated["relationships"]["foreign_keys"]
        ),
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Generate a cross-table consolidated YAML "
            "from per-table profiles and relationships JSON"
        )
    )
    parser.add_argument(
        "--artifacts-root",
        default=ARTIFACTS_ROOT,
        type=Path,
        help=(
            "Dataset artifacts directory containing "
            "consolidated_profiles/"
        ),
    )
    parser.add_argument(
        "--relationships-json",
        type=Path,
        default=None,
        help=(
            "Override the relationships JSON path "
            "(default: <artifacts-root>/discovery/relationships.json)"
        ),
    )

    args = parser.parse_args()

    result = generate_inter_table_profile(
        artifacts_root=args.artifacts_root,
        relationships_json_path=args.relationships_json,
    )

    print(
        f"Wrote {result.output_path} "
        f"({result.table_count} tables, "
        f"{result.foreign_key_count} foreign keys)"
    )


if __name__ == "__main__":
    main()