
"""Read-only APIs for generated discovery and profiling artifacts.

Supports:
- Legacy analysis runs under /api/v1/runs
- Reusable discovery runs under /api/v1/discovery-runs

No Databricks queries, graph execution, or writes happen here.
"""

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.routes import get_run_folder, get_run_or_404
from app.services import reusable_run_store as store


# Existing legacy profile endpoints.
router = APIRouter(
    prefix="/api/v1/runs",
    tags=["Profiles"],
)

# New endpoints for completed or ongoing Graph 1 runs.
discovery_profiles_router = APIRouter(
    prefix="/api/v1/discovery-runs",
    tags=["Discovery Profiles"],
)


def _profile_root(run_id: str) -> Path:
    """Resolve the artifact directory for a supported run type.

    Discovery runs are stored separately from legacy analysis runs.
    Do not create paths directly from user-supplied identifiers.
    """

    if run_id.startswith("discovery_"):
        try:
            return store.discovery_path(run_id)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(
                status_code=404,
                detail="Discovery run not found",
            ) from exc

    # Preserve the existing validation for legacy runs.
    get_run_or_404(run_id)
    return get_run_folder(run_id)


def _read_json(path: Path) -> dict[str, Any] | None:
    """Read an optional JSON artifact."""

    if not path.is_file():
        return None

    try:
        data = json.loads(
            path.read_text(encoding="utf-8")
        )
    except (
        OSError,
        UnicodeError,
        json.JSONDecodeError,
    ) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot read profile artifact: {path.name}",
        ) from exc

    if not isinstance(data, dict):
        raise HTTPException(
            status_code=500,
            detail=f"Invalid profile artifact: {path.name}",
        )

    return data


def _read_yaml_text(path: Path) -> str | None:
    """Read YAML as text for the existing frontend viewer."""

    if not path.is_file():
        return None

    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Cannot read profile artifact: {path.name}",
        ) from exc


def _config_paths(root: Path) -> dict[str, Path]:
    """Map table names to configuration files.

    Configuration filenames need not match table names.
    """

    config_dir = root / "discovery" / "configs"
    result: dict[str, Path] = {}

    if not config_dir.is_dir():
        return result

    for path in config_dir.glob("*.json"):
        if path.name.casefold() == "relationships.json":
            continue

        try:
            config = json.loads(
                path.read_text(encoding="utf-8")
            )
        except (
            OSError,
            UnicodeError,
            json.JSONDecodeError,
        ):
            # Discovery preserves invalid source config files.
            continue

        if not isinstance(config, dict):
            continue

        name = config.get("table_name")

        if (
            isinstance(name, str)
            and name
            and isinstance(config.get("columns"), list)
        ):
            result[name] = path

    return result


def _index(root: Path) -> dict[str, dict[str, bool]]:
    """Build the table inventory from persisted artifact files."""

    sources = {
        "discovery": (
            root / "discovery" / "tables",
            ".json",
        ),
        "statistical": (
            root / "statistical_profiles",
            ".json",
        ),
        "semantic": (
            root / "semantic_profiles",
            ".json",
        ),
        "consolidated": (
            root / "consolidated_profiles",
            ".yaml",
        ),
    }

    tables: dict[str, dict[str, bool]] = {}

    def new_availability() -> dict[str, bool]:
        return {
            "discovery": False,
            "config": False,
            "statistical": False,
            "semantic": False,
            "consolidated": False,
        }

    for kind, (directory, extension) in sources.items():
        if not directory.is_dir():
            continue

        for file in directory.glob(f"*{extension}"):
            if not file.is_file():
                continue

            # A cross-table YAML is not an individual table profile.
            if (
                kind == "consolidated"
                and file.stem == "inter_table_consolidated"
            ):
                continue

            if file.stem not in tables:
                tables[file.stem] = new_availability()

            tables[file.stem][kind] = True

    for table_name in _config_paths(root):
        if table_name not in tables:
            tables[table_name] = new_availability()

        tables[table_name]["config"] = True

    return tables


@discovery_profiles_router.get("/{run_id}/profiles")
@router.get("/{run_id}/profiles")
def list_profiles(run_id: str):
    """List tables with available discovery/profile artifacts."""

    root = _profile_root(run_id)
    inventory = _index(root)

    matching = _read_json(
        root / "discovery" / "matching_results.json"
    )

    return {
        "run_id": run_id,
        "tables": [
            {
                "table_name": name,
                "available": inventory[name],
            }
            for name in sorted(inventory)
        ],
        "matching_summary": (
            matching.get("summary")
            if matching
            else None
        ),
    }


@discovery_profiles_router.get(
    "/{run_id}/profiles/{table_name}"
)
@router.get("/{run_id}/profiles/{table_name}")
def get_table_profile(
    run_id: str,
    table_name: str,
):
    """Retrieve artifacts for one inventoried table."""

    root = _profile_root(run_id)
    inventory = _index(root)

    if table_name not in inventory:
        raise HTTPException(
            status_code=404,
            detail="Table profile not found",
        )

    # Validate against the inventory before using the table name
    # to construct any file path.
    available = inventory[table_name]

    discovery = (
        _read_json(
            root
            / "discovery"
            / "tables"
            / f"{table_name}.json"
        )
        if available["discovery"]
        else None
    )

    config_file = _config_paths(root).get(table_name)
    source_config = (
        _read_json(config_file)
        if config_file
        else None
    )

    # Expose only the known configuration fields.
    config = None

    if source_config is not None:
        config = {
            "table_name": source_config.get("table_name"),
            "expected_row_count": source_config.get(
                "expected_row_count"
            ),
            "primary_key": source_config.get("primary_key"),
            "columns": [
                {
                    "name": column.get("name"),
                    "datatype": column.get("datatype"),
                    "nullable": column.get("nullable"),
                }
                for column in source_config.get("columns", [])
                if isinstance(column, dict)
            ],
        }

    matching = _read_json(
        root / "discovery" / "matching_results.json"
    )

    mismatches: list[dict[str, Any]] = []

    if matching:
        mismatches = [
            item
            for item in matching.get("column_mismatches", [])
            if (
                isinstance(item, dict)
                and item.get("table") == table_name
            )
        ]

    statistical = (
        _read_json(
            root
            / "statistical_profiles"
            / f"{table_name}.json"
        )
        if available["statistical"]
        else None
    )

    semantic = (
        _read_json(
            root
            / "semantic_profiles"
            / f"{table_name}.json"
        )
        if available["semantic"]
        else None
    )

    consolidated_yaml = (
        _read_yaml_text(
            root
            / "consolidated_profiles"
            / f"{table_name}.yaml"
        )
        if available["consolidated"]
        else None
    )

    return {
        "run_id": run_id,
        "table_name": table_name,
        "available": available,
        "discovery": discovery,
        "config": config,
        "column_mismatches": mismatches,
        "statistical": statistical,
        "semantic": semantic,
        "consolidated_yaml": consolidated_yaml,
    }


@discovery_profiles_router.get(
    "/{run_id}/relationships"
)
@router.get("/{run_id}/relationships")
def get_relationships(run_id: str):
    """Retrieve declared relationships and optional cross-table YAML.

    A Graph 1 discovery run contains declared relationships but
    does not generate a scoped inter-table YAML. That happens
    separately in Graph 2.
    """

    root = _profile_root(run_id)

    relationships = _read_json(
        root / "discovery" / "relationships.json"
    )

    inter_table_yaml = _read_yaml_text(
        root
        / "consolidated_profiles"
        / "inter_table_consolidated.yaml"
    )

    return {
        "run_id": run_id,
        "foreign_keys": (
            relationships.get("foreign_keys", [])
            if relationships
            else []
        ),
        "configuration_available": (
            relationships is not None
        ),
        "inter_table_yaml": inter_table_yaml,
    }
