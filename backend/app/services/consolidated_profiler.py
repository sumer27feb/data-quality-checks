"""Merge statistical and semantic profile JSONs into compact table YAML files.

Run from the backend directory:
    python -m services.consolidated_profile_service \
        --artifacts-root artifacts/workspace.data_quality_rules

Dependency: PyYAML (pip install PyYAML)
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class ProfileConsolidationError(ValueError):
    """Raised when input profiles are missing or inconsistent."""


@dataclass(frozen=True)
class ConsolidationResult:
    output_dir: Path
    files: tuple[Path, ...]

    @property
    def table_count(self) -> int:
        return len(self.files)


def _required_object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProfileConsolidationError(f"{location} must be a JSON object")
    return value


def _required_text(obj: dict[str, Any], field: str, location: str) -> str:
    value = obj.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ProfileConsolidationError(f"{location}.{field} must be a non-empty string")
    return value


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return _required_object(json.loads(path.read_text(encoding="utf-8")), str(path))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProfileConsolidationError(f"Cannot read {path}: {exc}") from exc


def build_consolidated_profile(
    statistical: dict[str, Any], semantic: dict[str, Any]
) -> dict[str, Any]:
    """Build one table's YAML-ready data without I/O or LLM calls."""
    stats_table = _required_text(statistical, "table_name", "statistical profile")
    semantic_table = _required_text(semantic, "table_name", "semantic profile")
    if stats_table != semantic_table:
        raise ProfileConsolidationError(
            f"Table mismatch: statistical={stats_table!r}, semantic={semantic_table!r}"
        )

    stats_columns = _required_object(statistical.get("columns"), f"{stats_table}.stats.columns")
    semantic_columns = _required_object(semantic.get("columns"), f"{stats_table}.semantics.columns")
    if not stats_columns:
        raise ProfileConsolidationError(f"{stats_table}: statistical profile has no columns")

    stats_names, semantic_names = set(stats_columns), set(semantic_columns)
    if stats_names != semantic_names:
        raise ProfileConsolidationError(
            f"{stats_table}: column mismatch: "
            f"missing in semantic={sorted(stats_names - semantic_names)}, "
            f"missing in statistical={sorted(semantic_names - stats_names)}"
        )

    table_semantics = _required_object(
        semantic.get("table_semantics"), f"{stats_table}.table_semantics"
    )
    consolidated: dict[str, Any] = {
        "table_name": stats_table,
        "table_semantics": {
            field: _required_text(table_semantics, field, f"{stats_table}.table_semantics")
            for field in ("description", "business_entity", "row_grain")
        },
        "columns": {},
    }

    for column_name, stats_value in stats_columns.items():
        stats_col = _required_object(stats_value, f"{stats_table}.stats.{column_name}")
        semantic_col = _required_object(
            semantic_columns[column_name], f"{stats_table}.semantics.{column_name}"
        )

        # Reject contradictory column identifiers; a missing duplicate identifier is fine.
        for source, column in (("statistical", stats_col), ("semantic", semantic_col)):
            embedded_name = column.get("column_name")
            if embedded_name is not None and embedded_name != column_name:
                raise ProfileConsolidationError(
                    f"{stats_table}.{column_name}: {source} column_name="
                    f"{embedded_name!r} does not match the column key"
                )

        consolidated["columns"][column_name] = {
            # Expected / Silver datatype is authoritative, not the physical Bronze type.
            "datatype": _required_text(
                stats_col, "expected_type", f"{stats_table}.stats.{column_name}"
            ),
            "description": _required_text(
                semantic_col, "description", f"{stats_table}.semantics.{column_name}"
            ),
            "semantic_role": _required_text(
                semantic_col, "semantic_role", f"{stats_table}.semantics.{column_name}"
            ),
            "semantic_type": _required_text(
                semantic_col, "semantic_type", f"{stats_table}.semantics.{column_name}"
            ),
            "entity": _required_text(
                semantic_col, "entity", f"{stats_table}.semantics.{column_name}"
            ),
        }

    return consolidated


def generate_consolidated_profiles(artifacts_root: str | Path) -> ConsolidationResult:
    """Write one <table>.yaml per matching pair of <table>.json profile files.

    Expected directories under artifacts_root:
        statistical_profiles/
        semantic_profiles/
    Generated directory:
        consolidated_profiles/

    Existing generated YAML files are overwritten; stale .yaml files are removed
    after successful input validation and writing.
    """
    root = Path(artifacts_root)
    statistical_dir = root / "statistical_profiles"
    semantic_dir = root / "semantic_profiles"
    output_dir = root / "consolidated_profiles"

    for directory in (statistical_dir, semantic_dir):
        if not directory.is_dir():
            raise ProfileConsolidationError(f"Input directory does not exist: {directory}")

    statistical_files = {p.stem: p for p in statistical_dir.glob("*.json")}
    semantic_files = {p.stem: p for p in semantic_dir.glob("*.json")}

    if not statistical_files:
        raise ProfileConsolidationError(f"No statistical profile JSON files in {statistical_dir}")
    if statistical_files.keys() != semantic_files.keys():
        raise ProfileConsolidationError(
            "Profile files do not match: "
            f"missing semantic={sorted(statistical_files.keys() - semantic_files.keys())}, "
            f"missing statistical={sorted(semantic_files.keys() - statistical_files.keys())}"
        )

    # Validate the entire batch before modifying output files.
    profiles: dict[str, dict[str, Any]] = {}
    for table_name in sorted(statistical_files):
        combined = build_consolidated_profile(
            _read_json(statistical_files[table_name]),
            _read_json(semantic_files[table_name]),
        )
        if combined["table_name"] != table_name:
            raise ProfileConsolidationError(
                f"Filename mismatch: {table_name}.json contains "
                f"table_name={combined['table_name']!r}"
            )
        profiles[table_name] = combined

    output_dir.mkdir(parents=True, exist_ok=True)
    written_files: list[Path] = []
    for table_name, profile in profiles.items():
        output_file = output_dir / f"{table_name}.yaml"
        output_file.write_text(
            yaml.safe_dump(
                profile,
                sort_keys=False,
                allow_unicode=True,
                default_flow_style=False,
                width=120,
            ),
            encoding="utf-8",
        )
        written_files.append(output_file)

    # Prevent previous-run table YAML from being consumed on the next run.
    current_filenames = {file.name for file in written_files}
    for old_file in output_dir.glob("*.yaml"):
        if old_file.name not in current_filenames:
            old_file.unlink()

    return ConsolidationResult(output_dir=output_dir, files=tuple(written_files))


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate compact consolidated table YAML profiles")
    parser.add_argument(
        "--artifacts-root",
        required=True,
        type=Path,
        help="Dataset artifacts folder containing statistical_profiles and semantic_profiles",
    )
    args = parser.parse_args()
    result = generate_consolidated_profiles(args.artifacts_root)
    print(f"Generated {result.table_count} consolidated profile(s) in {result.output_dir}")
    for file in result.files:
        print(f"  {file}")


if __name__ == "__main__":
    main()
