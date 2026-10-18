
import json
import logging
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query

from app.config import (
    ARTIFACTS_ROOT,
    DATABRICKS_CATALOG,
    DATABRICKS_SCHEMA,
    DATABRICKS_CONFIG_DIR,
    DATABRICKS_MODEL_ENDPOINT,
)
from app.graph.workflow import graph


router = APIRouter(prefix="/api/v1", tags=["Runs"])
logger = logging.getLogger(__name__)

# Temporary in-memory storage for MVP
runs = {}
runs_lock = Lock()

# Each execution receives its own artifacts directory.
RUNS_ROOT = Path(ARTIFACTS_ROOT).resolve().parent / "runs"

STAGES = [
    "dataset_discovery",
    "statistical_profiling",
    "semantic_profiling",
    "table_consolidation",
    "individual_recommendations",
    "inter_table_consolidation",
    "inter_table_recommendations",
]

# Used to indicate the next expected processing stage.
NEXT_STAGES = {
    "dataset_discovery": ["statistical_profiling"],
    "statistical_profiling": ["semantic_profiling"],
    "semantic_profiling": ["table_consolidation"],
    "table_consolidation": [
        "individual_recommendations",
        "inter_table_consolidation",
    ],
    "inter_table_consolidation": [
        "inter_table_recommendations",
    ],
}


STAGE_METRIC_FIELDS = {
    "dataset_discovery": (
        "discovered_table_count",
        "discovery_column_mismatch_count",
    ),
    "statistical_profiling": (
        "profiled_table_count",
        "profiled_column_count",
    ),
    "semantic_profiling": (
        "semantic_table_count",
        "semantic_column_count",
    ),
    "table_consolidation": (
        "consolidated_profile_count",
    ),
    "individual_recommendations": (
        "individual_recommendation_table_count",
        "individual_recommendation_rule_count",
    ),
    "inter_table_consolidation": (
        "inter_table_profile_table_count",
        "inter_table_profile_foreign_key_count",
    ),
    "inter_table_recommendations": (
        "inter_table_recommendation_rule_count",
    ),
}

def get_run_folder(run_id: str) -> Path:
    """Resolve a run folder using a validated UUID."""

    try:
        parsed = UUID(run_id)
    except ValueError:
        raise HTTPException(
            status_code=404,
            detail="Run not found",
        )

    if str(parsed) != run_id:
        raise HTTPException(
            status_code=404,
            detail="Run not found",
        )

    return RUNS_ROOT / run_id


def execute_run(run_id: str):
    """Execute the existing LangGraph in the background."""

    initial_state = {
        "catalog": DATABRICKS_CATALOG,
        "schema": DATABRICKS_SCHEMA,
        "config_volume_path": DATABRICKS_CONFIG_DIR,
        "llm_model": DATABRICKS_MODEL_ENDPOINT,
        "artifacts_root": str(RUNS_ROOT / run_id),
    }

    with runs_lock:
        runs[run_id]["status"] = "running"
        runs[run_id]["stages"]["dataset_discovery"] = "running"

    try:
        # Stream completed node updates from LangGraph.
        for event in graph.stream(
            initial_state,
            stream_mode="updates",
            version="v2",
        ):
            if event["type"] != "updates":
                continue

            with runs_lock:
                for node_name, node_output in event["data"].items():
                    if node_name not in STAGES:
                        continue

                    # Capture only explicitly allowed numerical metrics.
                    # Do not expose artifact paths or full graph state.
                    if isinstance(node_output, dict):
                        allowed_fields = STAGE_METRIC_FIELDS.get(
                            node_name, ()
                        )
                        for field in allowed_fields:
                            value = node_output.get(field)

                            if type(value) is int:
                                runs[run_id]["metrics"][field] = value
                    runs[run_id]["stages"][node_name] = "completed"

                    for next_node in NEXT_STAGES.get(node_name, []):
                        if (
                            runs[run_id]["stages"][next_node]
                            == "pending"
                        ):
                            runs[run_id]["stages"][next_node] = "running"

        with runs_lock:
            runs[run_id]["status"] = "completed"

    except Exception as exc:
        logger.exception("Pipeline failed for run %s", run_id)

        with runs_lock:
            runs[run_id]["status"] = "failed"
            runs[run_id]["error"] = f"{type(exc).__name__}: {exc}"

            # Updates alone cannot identify the exact failing node.
            for node, status in runs[run_id]["stages"].items():
                if status == "running":
                    runs[run_id]["stages"][node] = "interrupted"


@router.get("/runs")
def list_runs(
    limit: int = Query(default=20, ge=1, le=100),
):
    """List live runs and historical artifact folders."""

    with runs_lock:
        live_runs = deepcopy(runs)

    results = []
    known_ids = set(live_runs)

    # Current process: exact execution information.
    for run in live_runs.values():
        completed = sum(
            status == "completed"
            for status in run["stages"].values()
        )

        results.append({
            "run_id": run["run_id"],
            "status": run["status"],
            "created_at": run["created_at"],
            "artifact_modified_at": None,
            "completed_stages": completed,
        })

    # Previous processes: existing artifact directories.
    if RUNS_ROOT.is_dir():
        for folder in RUNS_ROOT.iterdir():
            if not folder.is_dir():
                continue

            try:
                get_run_folder(folder.name)
            except HTTPException:
                continue

            if folder.name in known_ids:
                continue

            modified_at = datetime.fromtimestamp(
                folder.stat().st_mtime,
                tz=timezone.utc,
            ).isoformat()

            results.append({
                "run_id": folder.name,
                "status": "archived",
                "created_at": None,
                "artifact_modified_at": modified_at,
                "completed_stages": None,
            })

    results.sort(
        key=lambda item: (
            item["created_at"]
            or item["artifact_modified_at"]
            or ""
        ),
        reverse=True,
    )

    return {"runs": results[:limit]}


def get_run_or_404(run_id: str):
    folder = get_run_folder(run_id)

    with runs_lock:
        if run_id in runs:
            return deepcopy(runs[run_id])

    if not folder.is_dir():
        raise HTTPException(
            status_code=404,
            detail="Run not found",
        )

    return {
        "run_id": run_id,
        "status": "archived",
        "created_at": None,
        "artifact_modified_at": datetime.fromtimestamp(
            folder.stat().st_mtime,
            tz=timezone.utc,
        ).isoformat(),
        "stages": {},
        "metrics": {},
        "error": None,
    }


@router.post("/runs", status_code=202)
def create_run(background_tasks: BackgroundTasks):
    """Create a run and start the DQ recommendation workflow."""

    required_config = {
        "DATABRICKS_CATALOG": DATABRICKS_CATALOG,
        "DATABRICKS_SCHEMA": DATABRICKS_SCHEMA,
        "DATABRICKS_CONFIG_DIR": DATABRICKS_CONFIG_DIR,
        "DATABRICKS_MODEL_ENDPOINT": DATABRICKS_MODEL_ENDPOINT,
    }

    missing = [
        name for name, value in required_config.items()
        if not value
    ]

    if missing:
        raise HTTPException(
            status_code=503,
            detail=f"Missing configuration: {', '.join(missing)}",
        )

    run_id = str(uuid4())

    with runs_lock:
        runs[run_id] = {
            "run_id": run_id,
            "status": "queued",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "stages": {stage: "pending" for stage in STAGES},
            "metrics": {},
            "error": None,
        }

    background_tasks.add_task(execute_run, run_id)

    return {
        "run_id": run_id,
        "status": "queued",
    }


@router.get("/runs/{run_id}")
def get_run_status(run_id: str):
    """Return the current workflow and stage statuses."""
    return get_run_or_404(run_id)


@router.get("/runs/{run_id}/recommendations")
def get_recommendations(run_id: str):
    """Return recommendations from completed branches."""

    run = get_run_or_404(run_id)
    root = get_run_folder(run_id) / "recommendations"

    individual = {}
    inter_table = []

    individual_dir = root / "individual_tables"
    inter_table_path = root / "inter_table.json"

    if run["status"] == "archived":
        # Files show artifact availability, not historical stage success.
        individual_ready = (
            individual_dir.is_dir()
            and any(individual_dir.glob("*.json"))
        )
        inter_table_ready = inter_table_path.is_file()
    else:
        individual_ready = (
            run["stages"]["individual_recommendations"] == "completed"
        )
        inter_table_ready = (
            run["stages"]["inter_table_recommendations"] == "completed"
        )

    if individual_ready:
        for path in sorted(individual_dir.glob("*.json")):
            content = json.loads(path.read_text(encoding="utf-8"))
            individual[path.stem] = content["rules"]

    if inter_table_ready:
        content = json.loads(inter_table_path.read_text(encoding="utf-8"))
        inter_table = content["rules"]

    return {
        "run_id": run_id,
        "status": run["status"],
        "available": {
            "individual": individual_ready,
            "inter_table": inter_table_ready,
        },
        "individual_rules": individual,
        "inter_table_rules": inter_table,
    }


@router.get("/workspace")
def get_workspace():
    """Expose non-sensitive, read-only workspace configuration."""

    required_config = {
        "DATABRICKS_CATALOG": DATABRICKS_CATALOG,
        "DATABRICKS_SCHEMA": DATABRICKS_SCHEMA,
        "DATABRICKS_CONFIG_DIR": DATABRICKS_CONFIG_DIR,
        "DATABRICKS_MODEL_ENDPOINT": DATABRICKS_MODEL_ENDPOINT,
    }

    missing = [
        name
        for name, value in required_config.items()
        if not value
    ]

    return {
        "source": "Databricks Unity Catalog",
        "catalog": DATABRICKS_CATALOG,
        "schema": DATABRICKS_SCHEMA,
        "config_volume_path": DATABRICKS_CONFIG_DIR,
        "model_endpoint": DATABRICKS_MODEL_ENDPOINT,
        "configured": len(missing) == 0,
        "missing_configuration": missing,
    }
