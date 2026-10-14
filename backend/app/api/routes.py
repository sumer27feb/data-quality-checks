
import json
import logging
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException

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
                for node_name in event["data"]:
                    if node_name not in STAGES:
                        continue

                    runs[run_id]["stages"][node_name] = "completed"

                    for next_node in NEXT_STAGES.get(node_name, []):
                        if runs[run_id]["stages"][next_node] == "pending":
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


def get_run_or_404(run_id: str):
    with runs_lock:
        if run_id not in runs:
            raise HTTPException(
                status_code=404,
                detail="Run not found",
            )
        return deepcopy(runs[run_id])


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
    root = RUNS_ROOT / run_id / "recommendations"

    individual = {}
    inter_table = []

    individual_ready = (
        run["stages"]["individual_recommendations"] == "completed"
    )
    inter_table_ready = (
        run["stages"]["inter_table_recommendations"] == "completed"
    )

    if individual_ready:
        individual_dir = root / "individual_tables"

        for path in sorted(individual_dir.glob("*.json")):
            content = json.loads(path.read_text(encoding="utf-8"))
            individual[path.stem] = content["rules"]

    if inter_table_ready:
        path = root / "inter_table.json"

        content = json.loads(path.read_text(encoding="utf-8"))
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
