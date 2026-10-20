"""Run-scoped traditional-check configuration and deterministic rule generation."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.routes import get_run_folder, get_run_or_404
from app.services.traditional_check_service import (
    SelectionRequest,
    TraditionalCheckError,
    artifact,
)

router = APIRouter(prefix="/api/v1/runs", tags=["Traditional checks"])
_file_lock = Lock()
_FILE = "traditional.json"


def _path(run_id: str) -> Path:
    return get_run_folder(run_id) / "recommendations" / _FILE


def _read(path: Path, run_id: str) -> dict[str, Any]:
    if not path.is_file():
        return {
            "version": 1,
            "run_id": run_id,
            "sql_result_mode": "violation_rows",
            "sql_validation_performed": False,
            "selections": [],
            "rules": [],
        }
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(500, "Cannot read traditional-check artifact") from exc
    if not isinstance(obj, dict) or not isinstance(obj.get("rules"), list) or not isinstance(obj.get("selections"), list):
        raise HTTPException(500, "Malformed traditional-check artifact")
    return obj


@router.get("/{run_id}/traditional-checks")
def get_traditional_checks(run_id: str) -> dict[str, Any]:
    get_run_or_404(run_id)
    return _read(_path(run_id), run_id)


@router.post("/{run_id}/traditional-checks")
def save_traditional_checks(run_id: str, body: SelectionRequest) -> dict[str, Any]:
    get_run_or_404(run_id)
    root = get_run_folder(run_id)
    try:
        result = artifact(root, run_id, body.selections)
    except TraditionalCheckError as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    target = _path(run_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    with _file_lock:
        tmp: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=target.parent, prefix=".traditional_", suffix=".tmp", delete=False,
            ) as output:
                tmp = Path(output.name)
                output.write(serialized)
            tmp.replace(target)  # Atomic replacement of config + generated rules together.
        except OSError as exc:
            raise HTTPException(500, "Failed to persist traditional checks") from exc
        finally:
            if tmp is not None:
                tmp.unlink(missing_ok=True)
    return result
