"""Read-only APIs for generated per-run profiling artifacts.

No Databricks queries, graph execution, or writes are performed here.
"""

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.routes import get_run_folder, get_run_or_404

router = APIRouter(prefix="/api/v1/runs", tags=["Profiles"])


def _read_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
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
    """Map config declarations to tables, independent of config filenames."""
    config_dir = root / "discovery" / "configs"
    result: dict[str, Path] = {}
    if not config_dir.is_dir():
        return result

    for path in config_dir.glob("*.json"):
        if path.name.casefold() == "relationships.json":
            continue
        try:
            config = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue  # Discovery can preserve invalid user-supplied config files.
        if not isinstance(config, dict):
            continue
        name = config.get("table_name")
        if isinstance(name, str) and name and isinstance(config.get("columns"), list):
            result[name] = path
    return result


def _index(root: Path) -> dict[str, dict[str, bool]]:
    """Build table inventory from artifacts and declared table config names."""
    sources = {
        "discovery": (root / "discovery" / "tables", ".json"),
        "statistical": (root / "statistical_profiles", ".json"),
        "semantic": (root / "semantic_profiles", ".json"),
        "consolidated": (root / "consolidated_profiles", ".yaml"),
    }
    tables: dict[str, dict[str, bool]] = {}
    for kind, (directory, ext) in sources.items():
        if not directory.is_dir():
            continue
        for file in directory.glob(f"*{ext}"):
            if not file.is_file():
                continue
            if kind == "consolidated" and file.stem == "inter_table_consolidated":
                continue
            if file.stem not in tables:
                tables[file.stem] = {
                    "discovery": False,
                    "config": False,
                    "statistical": False,
                    "semantic": False,
                    "consolidated": False,
                }
            tables[file.stem][kind] = True

    for table_name in _config_paths(root):
        if table_name not in tables:
            tables[table_name] = {
                "discovery": False,
                "config": False,
                "statistical": False,
                "semantic": False,
                "consolidated": False,
            }
        tables[table_name]["config"] = True
    return tables


@router.get("/{run_id}/profiles")
def list_profiles(run_id: str):
    """List tables with existing discovery/profile artifacts."""
    get_run_or_404(run_id)
    root = get_run_folder(run_id)
    inventory = _index(root)
    matching = _read_json(root / "discovery" / "matching_results.json")
    return {
        "run_id": run_id,
        "tables": [
            {"table_name": name, "available": inventory[name]}
            for name in sorted(inventory)
        ],
        "matching_summary": matching.get("summary") if matching else None,
    }


@router.get("/{run_id}/profiles/{table_name}")
def get_table_profile(run_id: str, table_name: str):
    """Retrieve available artifacts for exactly one inventoried table."""
    get_run_or_404(run_id)
    root = get_run_folder(run_id)
    inventory = _index(root)
    if table_name not in inventory:
        raise HTTPException(status_code=404, detail="Table profile not found")

    # Paths are constructed only AFTER table_name is found in the on-disk
    # inventory, preventing arbitrary client-controlled file paths.
    available = inventory[table_name]
    discovery = (
        _read_json(root / "discovery" / "tables" / f"{table_name}.json")
        if available["discovery"] else None
    )
    config_file = _config_paths(root).get(table_name)
    source_config = _read_json(config_file) if config_file else None
    # Only reveal known configuration fields, not arbitrary uploaded metadata.
    config = None
    if source_config is not None:
        config = {
            "table_name": source_config.get("table_name"),
            "expected_row_count": source_config.get("expected_row_count"),
            "primary_key": source_config.get("primary_key"),
            "columns": [
                {
                    "name": col.get("name"),
                    "datatype": col.get("datatype"),
                    "nullable": col.get("nullable"),
                }
                for col in source_config.get("columns", [])
                if isinstance(col, dict)
            ],
        }

    matching = _read_json(root / "discovery" / "matching_results.json")
    mismatches = []
    if matching:
        mismatches = [
            item for item in matching.get("column_mismatches", [])
            if isinstance(item, dict) and item.get("table") == table_name
        ]

    return {
        "run_id": run_id,
        "table_name": table_name,
        "available": available,
        "discovery": discovery,
        "config": config,
        "column_mismatches": mismatches,
        "statistical": _read_json(
            root / "statistical_profiles" / f"{table_name}.json"
        ) if available["statistical"] else None,
        "semantic": _read_json(
            root / "semantic_profiles" / f"{table_name}.json"
        ) if available["semantic"] else None,
        "consolidated_yaml": _read_yaml_text(
            root / "consolidated_profiles" / f"{table_name}.yaml"
        ) if available["consolidated"] else None,
    }


@router.get("/{run_id}/relationships")
def get_relationships(run_id: str):
    """Read declared foreign keys and the inter-table profile if present."""
    get_run_or_404(run_id)
    root = get_run_folder(run_id)
    relationships = _read_json(root / "discovery" / "relationships.json")
    return {
        "run_id": run_id,
        "foreign_keys": relationships.get("foreign_keys", []) if relationships else [],
        "configuration_available": relationships is not None,
        "inter_table_yaml": _read_yaml_text(
            root / "consolidated_profiles" / "inter_table_consolidated.yaml"
        ),
    }
