"""Merge statistical and semantic profiles into compact table YAML files.

artifacts_root is the dataset directory itself, for example:
    artifacts/workspace.data_quality_rules

Inputs:
    <artifacts_root>/statistical_profiles/
    <artifacts_root>/semantic_profiles/

Output:
    <artifacts_root>/consolidated_profiles/

Run from backend/:
    python -m app.services.consolidated_profiler

Dependency:
    PyYAML
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from app.config import ARTIFACTS_ROOT


class ProfileConsolidationError(ValueError):
    """Raised when input profiles are missing or inconsistent."""


@dataclass(frozen=True)
class ConsolidationResult:
    output_dir: Path
    files: tuple[Path, ...]

    @property
    def table_count(self) -> int:
        return len(self.files)


def _required_object(
    value: Any,
    location: str,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ProfileConsolidationError(
            f"{location} must be a JSON object"
        )

    return value


def _required_text(
    obj: dict[str, Any],
    field: str,
    location: str,
) -> str:
    value = obj.get(field)

    if not isinstance(value, str) or not value.strip():
        raise ProfileConsolidationError(
            f"{location}.{field} must be a non-empty string"
        )

    return value


def _read_json(path: Path) -> dict[str, Any]:
    try:
        content = json.loads(
            path.read_text(encoding="utf-8")
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProfileConsolidationError(
            f"Cannot read {path}: {exc}"
        ) from exc

    return _required_object(content, str(path))


def build_consolidated_profile(
    statistical: dict[str, Any],
    semantic: dict[str, Any],
) -> dict[str, Any]:
    """Build one table's YAML-ready data without I/O or LLM calls."""
    stats_table = _required_text(
        statistical,
        "table_name",
        "statistical profile",
    )
    semantic_table = _required_text(
        semantic,
        "table_name",
        "semantic profile",
    )

    if stats_table != semantic_table:
        raise ProfileConsolidationError(
            f"Table mismatch: statistical={stats_table!r}, "
            f"semantic={semantic_table!r}"
        )

    stats_columns = _required_object(
        statistical.get("columns"),
        f"{stats_table}.stats.columns",
    )
    semantic_columns = _required_object(
        semantic.get("columns"),
        f"{stats_table}.semantics.columns",
    )

    if not stats_columns:
        raise ProfileConsolidationError(
            f"{stats_table}: statistical profile has no columns"
        )

    stats_names = set(stats_columns)
    semantic_names = set(semantic_columns)

    if stats_names != semantic_names:
        raise ProfileConsolidationError(
            f"{stats_table}: column mismatch: "
            f"missing in semantic={sorted(stats_names - semantic_names)}, "
            f"missing in statistical={sorted(semantic_names - stats_names)}"
        )

    table_semantics = _required_object(
        semantic.get("table_semantics"),
        f"{stats_table}.table_semantics",
    )

    consolidated: dict[str, Any] = {
        "table_name": stats_table,
        "table_semantics": {
            field: _required_text(
                table_semantics,
                field,
                f"{stats_table}.table_semantics",
            )
            for field in (
                "description",
                "business_entity",
                "row_grain",
            )
        },
        "columns": {},
    }

    for column_name, stats_value in stats_columns.items():
        stats_location = f"{stats_table}.stats.{column_name}"
        semantic_location = f"{stats_table}.semantics.{column_name}"

        stats_column = _required_object(
            stats_value,
            stats_location,
        )
        semantic_column = _required_object(
            semantic_columns[column_name],
            semantic_location,
        )

        # If a profile repeats its column name, it must match its key.
        for source, column in (
            ("statistical", stats_column),
            ("semantic", semantic_column),
        ):
            embedded_name = column.get("column_name")

            if (
                embedded_name is not None
                and embedded_name != column_name
            ):
                raise ProfileConsolidationError(
                    f"{stats_table}.{column_name}: "
                    f"{source} column_name={embedded_name!r} "
                    "does not match the column key"
                )

        consolidated["columns"][column_name] = {
            # Use the configured expected type.
            "datatype": _required_text(
                stats_column,
                "expected_type",
                stats_location,
            ),
            "description": _required_text(
                semantic_column,
                "description",
                semantic_location,
            ),
            "semantic_role": _required_text(
                semantic_column,
                "semantic_role",
                semantic_location,
            ),
            "semantic_type": _required_text(
                semantic_column,
                "semantic_type",
                semantic_location,
            ),
            "entity": _required_text(
                semantic_column,
                "entity",
                semantic_location,
            ),
        }

    return consolidated


def generate_consolidated_profiles(
    artifacts_root: str | Path | None = None,
) -> ConsolidationResult:
    """Write one YAML file per matching pair of JSON profiles.

    artifacts_root is the dataset directory itself.
    An explicit argument overrides the app.config default.

    All input profiles are validated before writing output.
    Stale YAML files are removed after all new files are written.
    """
    root = Path(
        artifacts_root
        if artifacts_root is not None
        else ARTIFACTS_ROOT
    ).resolve()

    statistical_dir = root / "statistical_profiles"
    semantic_dir = root / "semantic_profiles"
    output_dir = root / "consolidated_profiles"

    for directory in (statistical_dir, semantic_dir):
        if not directory.is_dir():
            raise ProfileConsolidationError(
                f"Input directory does not exist: {directory}"
            )

    statistical_files = {
        path.stem: path
        for path in statistical_dir.glob("*.json")
    }
    semantic_files = {
        path.stem: path
        for path in semantic_dir.glob("*.json")
    }

    if not statistical_files:
        raise ProfileConsolidationError(
            "No statistical profile JSON files in "
            f"{statistical_dir}"
        )

    if statistical_files.keys() != semantic_files.keys():
        missing_semantic = sorted(
            statistical_files.keys() - semantic_files.keys()
        )
        missing_statistical = sorted(
            semantic_files.keys() - statistical_files.keys()
        )

        raise ProfileConsolidationError(
            "Profile files do not match: "
            f"missing semantic={missing_semantic}, "
            f"missing statistical={missing_statistical}"
        )

    # Validate the complete batch before modifying output files.
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

    # Remove outputs for tables no longer present in this batch.
    current_filenames = {
        file.name
        for file in written_files
    }

    for old_file in output_dir.glob("*.yaml"):
        if old_file.name not in current_filenames:
            old_file.unlink()

    return ConsolidationResult(
        output_dir=output_dir,
        files=tuple(written_files),
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate compact consolidated table YAML profiles"
    )
    parser.add_argument(
        "--artifacts-root",
        default=ARTIFACTS_ROOT,
        type=Path,
        help=(
            "Dataset artifacts directory containing "
            "statistical_profiles/ and semantic_profiles/"
        ),
    )

    args = parser.parse_args()

    result = generate_consolidated_profiles(
        artifacts_root=args.artifacts_root,
    )

    print(
        f"Generated {result.table_count} consolidated profile(s) "
        f"in {result.output_dir}"
    )

    for file in result.files:
        print(f"  {file}")


if __name__ == "__main__":
    main()
