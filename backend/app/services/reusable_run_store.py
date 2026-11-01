"""File-backed discovery runs and nested recommendation runs.

No external database. All user-supplied identifiers are resolved through persisted
manifests, and files are written with atomic replacement wherever possible.
"""
from __future__ import annotations

import json
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from app.config import ARTIFACTS_ROOT

_LOCK = RLock()
_DISCOVERY_ID = re.compile(r"discovery_\d{8}_\d{6}_[a-f0-9]{8}\Z")
_RECOMMENDATION_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}__[a-f0-9]{8}\Z")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def root_dir() -> Path:
    # Keep this beside the old 'runs/' directory; never overwrite legacy artifacts.
    return Path(ARTIFACTS_ROOT).resolve().parent / "discovery_runs"


def write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent,
                                     prefix=f".{path.name}.", suffix=".tmp", delete=False) as out:
        tmp = Path(out.name)
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write("\n")
    try:
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def read_json(path: Path) -> dict[str, Any]:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise ValueError(f"Cannot read artifact {path.name}: {exc}") from exc
    if not isinstance(obj, dict):
        raise ValueError(f"Invalid object in {path.name}")
    return obj


def discovery_path(discovery_id: str) -> Path:
    if not isinstance(discovery_id, str) or not _DISCOVERY_ID.fullmatch(discovery_id):
        raise ValueError("Invalid discovery run ID")
    path = root_dir() / discovery_id
    if not (path / "manifest.json").is_file():
        raise FileNotFoundError("Discovery run not found")
    return path


def recommendation_path(discovery_id: str, recommendation_id: str) -> Path:
    parent = discovery_path(discovery_id)
    if not isinstance(recommendation_id, str) or not _RECOMMENDATION_ID.fullmatch(recommendation_id):
        raise ValueError("Invalid recommendation run ID")
    path = parent / "recommendation_runs" / recommendation_id
    if not (path / "manifest.json").is_file():
        raise FileNotFoundError("Recommendation run not found")
    return path


def new_discovery(catalog: str, schema: str, config_dir: str) -> dict[str, Any]:
    stages = ("dataset_discovery", "statistical_profiling", "semantic_profiling",
              "table_consolidation", "inter_table_consolidation")
    with _LOCK:
        while True:
            discovery_id = "discovery_" + datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S") + "_" + uuid4().hex[:8]
            path = root_dir() / discovery_id
            try:
                path.mkdir(parents=True, exist_ok=False)
                break
            except FileExistsError:
                continue
        manifest: dict[str, Any] = {
            "kind": "discovery", "discovery_id": discovery_id,
            "name": f"Discovery {datetime.now(timezone.utc).strftime('%d %b %Y %H:%M UTC')}",
            "created_at": now(), "updated_at": now(), "status": "queued", "error": None,
            "catalog": catalog, "schema": schema, "config_dir": config_dir,
            "stages": {stage: "pending" for stage in stages}, "metrics": {},
        }
        write_json(path / "manifest.json", manifest)
    return manifest


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:64].strip("-")
    return slug or "recommendation"


def new_recommendation(discovery_id: str, name: str, selections: dict[str, list[str]],
                       business_context: str = "", individual: bool = True,
                       inter_table: bool = True) -> dict[str, Any]:
    parent = discovery_path(discovery_id)
    source = read_json(parent / "manifest.json")
    if source.get("status") != "completed":
        raise ValueError("Discovery must complete successfully before creating recommendation runs")
    if not name.strip() or len(name) > 80:
        raise ValueError("Recommendation run name must contain 1-80 characters")
    if not selections or not individual and not inter_table:
        raise ValueError("Select tables/columns and at least one recommendation branch")
    if len(business_context) > 50000:
        raise ValueError("Business context exceeds 50,000 characters")
    with _LOCK:
        while True:
            recommendation_id = f"{_slug(name)}__{uuid4().hex[:8]}"
            path = parent / "recommendation_runs" / recommendation_id
            try:
                path.mkdir(parents=True, exist_ok=False)
                break
            except FileExistsError:
                continue
        config = {
            "version": 1, "discovery_id": discovery_id,
            "recommendation_id": recommendation_id, "name": name.strip(),
            "selections": selections, "branches": {"individual": individual, "inter_table": inter_table},
            "business_context_file": "business_context.txt" if business_context.strip() else None,
        }
        write_json(path / "run_config.json", config)
        if business_context.strip():
            (path / "business_context.txt").write_text(business_context, encoding="utf-8")
        manifest = {
            "kind": "recommendation", "discovery_id": discovery_id,
            "recommendation_id": recommendation_id, "name": name.strip(),
            "created_at": now(), "updated_at": now(), "status": "queued", "error": None,
            "stages": {"scoped_metadata": "pending", "individual_recommendations": "pending",
                       "inter_table_recommendations": "pending"},
            "metrics": {},
        }
        write_json(path / "manifest.json", manifest)
    return manifest


def update(path: Path, **changes: Any) -> dict[str, Any]:
    with _LOCK:
        manifest = read_json(path / "manifest.json")
        manifest.update(changes)
        manifest["updated_at"] = now()
        write_json(path / "manifest.json", manifest)
    return manifest


def set_stage(path: Path, stage: str, status: str, metrics: dict[str, int] | None = None) -> dict[str, Any]:
    with _LOCK:
        manifest = read_json(path / "manifest.json")
        if stage not in manifest["stages"]:
            raise ValueError(f"Unknown stage: {stage}")
        manifest["stages"][stage] = status
        if metrics:
            manifest["metrics"].update(metrics)
        manifest["updated_at"] = now()
        write_json(path / "manifest.json", manifest)
    return manifest


def list_discoveries() -> list[dict[str, Any]]:
    root = root_dir()
    if not root.is_dir():
        return []
    items = []
    for p in root.iterdir():
        if p.is_dir() and _DISCOVERY_ID.fullmatch(p.name) and (p / "manifest.json").is_file():
            try:
                items.append(read_json(p / "manifest.json"))
            except ValueError:
                continue
    return sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)


def list_recommendations(discovery_id: str) -> list[dict[str, Any]]:
    root = discovery_path(discovery_id) / "recommendation_runs"
    if not root.is_dir():
        return []
    items = []
    for p in root.iterdir():
        if p.is_dir() and _RECOMMENDATION_ID.fullmatch(p.name) and (p / "manifest.json").is_file():
            try:
                items.append(read_json(p / "manifest.json"))
            except ValueError:
                continue
    return sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)
