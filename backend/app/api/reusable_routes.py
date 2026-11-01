"""Reusable discovery runs and named, independent recommendation runs.

Legacy /api/v1/runs endpoints remain unchanged in this incremental upgrade.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import DATABRICKS_CATALOG, DATABRICKS_SCHEMA, DATABRICKS_CONFIG_DIR, DATABRICKS_MODEL_ENDPOINT
from app.services import reusable_run_store as store
from app.services.scoped_recommendation_inputs import SelectionError
from app.services.traditional_check_service import SelectionRequest, TraditionalCheckError, artifact

router = APIRouter(prefix="/api/v1/discovery-runs", tags=["Reusable DQ runs"])


def _parent(discovery_id: str) -> Path:
    try:
        return store.discovery_path(discovery_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from exc


def _child(discovery_id: str, rec_id: str) -> Path:
    try:
        return store.recommendation_path(discovery_id, rec_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from exc


class RecommendationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=80)
    selections: dict[str, list[str]] = Field(min_length=1, max_length=200)
    business_context: str = Field(default="", max_length=50000)
    individual: bool = True
    inter_table: bool = True

    @field_validator("selections")
    @classmethod
    def check_selection(cls, selections: dict[str, list[str]]) -> dict[str, list[str]]:
        if any(not v or len(v) > 1000 for v in selections.values()):
            raise ValueError("Each table requires 1-1000 selected columns")
        if not all(v and len(set(v)) == len(v) for v in selections.values()):
            raise ValueError("Duplicate columns are not allowed")
        return selections


class CustomRuleInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(min_length=1, max_length=2000)
    scope: Literal["individual", "inter_table"]
    tables: list[str] = Field(min_length=1, max_length=20)
    columns: dict[str, list[str]] = Field(default_factory=dict)
    impact_level: Literal["low", "medium", "high"] = "medium"
    validation_sql: str = Field(min_length=6, max_length=25000)
    sql_result_mode: Literal["violation_rows", "violation_count"] = "violation_rows"


class ReviewedRule(BaseModel):
    id: str = Field(min_length=1, max_length=250)
    reviewed_sql: str | None = Field(default=None, max_length=25000)


class ReviewSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rules: list[ReviewedRule] = Field(max_length=1000)


def _is_read_only_select(sql: str) -> bool:
    # Defense-in-depth sanity check, NOT full parsing or database authorization.
    # No SQL is executed in this application.
    stripped = re.sub(r"'(?:''|[^'])*'", "''", sql).strip()
    stripped = re.sub(r'"(?:""|[^"])*"', '""', stripped)
    if not re.match(r"(?is)^(SELECT|WITH)\b", stripped):
        return False
    if ";" in stripped or "--" in stripped or "/*" in stripped:
        return False
    return not re.search(r"(?i)\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|MERGE|TRUNCATE|GRANT|REVOKE|CALL|EXECUTE|COPY|PUT|REMOVE)\b", stripped)


def _validate_custom_rule(source_parent: Path, inp: CustomRuleInput) -> None:
    if not _is_read_only_select(inp.validation_sql):
        raise HTTPException(422, "Only one read-only SELECT statement is supported; SQL is not executed or semantically validated")
    if inp.scope == "individual" and len(inp.tables) != 1:
        raise HTTPException(422, "Individual custom rules must specify exactly one table")
    if inp.scope == "inter_table" and len(inp.tables) < 2:
        raise HTTPException(422, "Cross-table custom rules must specify at least two tables")
    if len(set(inp.tables)) != len(inp.tables) or set(inp.columns) - set(inp.tables):
        raise HTTPException(422, "Duplicate/mismatched table references")
    for table in inp.tables:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", table):
            raise HTTPException(422, "Invalid table name")
        source = source_parent / "discovery" / "tables" / f"{table}.json"
        if not source.is_file():
            raise HTTPException(422, f"Unknown source table: {table}")
        discovered = store.read_json(source)
        available = {col["name"] for col in discovered.get("columns", []) if isinstance(col, dict) and "name" in col}
        if not set(inp.columns.get(table, [])) <= available:
            raise HTTPException(422, f"Unknown columns for {table}")


def _execute_discovery(discovery_id: str) -> None:
    import logging
    from app.graph.reusable_discovery_workflow import run_discovery
    try:
        run_discovery(str(store.discovery_path(discovery_id)))
    except Exception:
        logging.getLogger(__name__).exception("Discovery run failed: %s", discovery_id)



def _execute_recommendation(
    discovery_id: str,
    rec_id: str,
) -> None:
    """Execute Graph 2 as a FastAPI background task."""

    import logging

    from app.services.recommendation_runner import (
        run_recommendation,
    )

    try:
        run_recommendation(
            discovery_id=discovery_id,
            recommendation_id=rec_id,
        )

    except Exception:
        # The runner has already persisted the failed status
        # and error details in the recommendation manifest.
        logging.getLogger(__name__).exception(
            "Graph 2 failed for discovery=%s, recommendation=%s",
            discovery_id,
            rec_id,
        )


@router.get("")
def list_discovery_runs():
    return {"discovery_runs": store.list_discoveries()}


@router.get("/history/all")
def list_workflow_run_history():
    """Flatten discovery and recommendation runs for the UI."""

    items = []

    for discovery in store.list_discoveries():
        discovery_id = discovery["discovery_id"]

        items.append({
            "run_id": discovery_id,
            "name": discovery["name"],
            "kind": "discovery",
            "status": discovery["status"],
            "created_at": discovery["created_at"],
            "artifact_modified_at": None,
            "completed_stages": sum(
                value == "completed"
                for value in discovery["stages"].values()
            ),
        })

        for recommendation in store.list_recommendations(
            discovery_id
        ):
            items.append({
                "run_id": (
                    f"{discovery_id}::"
                    f"{recommendation['recommendation_id']}"
                ),
                "name": recommendation["name"],
                "kind": "recommendation",
                "parent_discovery_id": discovery_id,
                "status": recommendation["status"],
                "created_at": recommendation["created_at"],
                "artifact_modified_at": None,
                "completed_stages": sum(
                    value == "completed"
                    for value in recommendation["stages"].values()
                ),
            })

    items.sort(
        key=lambda item: item["created_at"],
        reverse=True,
    )

    return {"runs": items}


@router.post("", status_code=202)
def create_discovery_run(background_tasks: BackgroundTasks):
    missing = [k for k, v in {
        "DATABRICKS_CATALOG": DATABRICKS_CATALOG,
        "DATABRICKS_SCHEMA": DATABRICKS_SCHEMA,
        "DATABRICKS_CONFIG_DIR": DATABRICKS_CONFIG_DIR,
        "DATABRICKS_MODEL_ENDPOINT": DATABRICKS_MODEL_ENDPOINT,
    }.items() if not v]
    if missing:
        raise HTTPException(503, f"Missing configuration: {', '.join(missing)}")
    result = store.new_discovery(DATABRICKS_CATALOG, DATABRICKS_SCHEMA, DATABRICKS_CONFIG_DIR)
    background_tasks.add_task(_execute_discovery, result["discovery_id"])
    return result


@router.get("/{discovery_id}")
def get_discovery_run(discovery_id: str):
    return store.read_json(_parent(discovery_id) / "manifest.json")


@router.get("/{discovery_id}/tables")
def list_available_tables(discovery_id: str):
    parent = _parent(discovery_id)
    if store.read_json(parent / "manifest.json")["status"] != "completed":
        raise HTTPException(409, "Discovery is not completed")
    matching = store.read_json(parent / "discovery" / "matching_results.json")
    result = []
    for table in matching.get("columns_matched_tables", []):
        data = store.read_json(parent / "discovery" / "tables" / f"{table}.json")
        result.append({"table_name": table, "columns": [c["name"] for c in data.get("columns", [])]})
    return {"discovery_id": discovery_id, "tables": result}


@router.get("/{discovery_id}/recommendation-runs")
def list_recommendation_runs(discovery_id: str):
    _parent(discovery_id)
    return {"recommendation_runs": store.list_recommendations(discovery_id)}


@router.post("/{discovery_id}/recommendation-runs", status_code=202)
def create_recommendation_run(discovery_id: str, payload: RecommendationCreate, background_tasks: BackgroundTasks):
    parent = _parent(discovery_id)
    try:
        # Validate BEFORE creating the named child, to avoid orphaned folders.
        if store.read_json(parent / "manifest.json")["status"] != "completed":
            raise ValueError("Discovery is not completed")
        from app.services.scoped_recommendation_inputs import validate_selection
        validate_selection(parent, payload.selections)
        result = store.new_recommendation(
            discovery_id, payload.name, payload.selections,
            payload.business_context, payload.individual, payload.inter_table,
        )
    except (ValueError, SelectionError) as exc:
        raise HTTPException(422, str(exc)) from exc
    background_tasks.add_task(_execute_recommendation, discovery_id, result["recommendation_id"])
    return result


@router.get("/{discovery_id}/recommendation-runs/{rec_id}")
def get_recommendation_run(discovery_id: str, rec_id: str):
    child = _child(discovery_id, rec_id)
    return {**store.read_json(child / "manifest.json"), "config": store.read_json(child / "run_config.json")}


@router.get("/{discovery_id}/recommendation-runs/{rec_id}/recommendations")
def get_recommendations(discovery_id: str, rec_id: str):
    child = _child(discovery_id, rec_id)
    root = child / "recommendations"
    individual: dict[str, list] = {}
    for path in sorted((root / "individual_tables").glob("*.json")):
        individual[path.stem] = store.read_json(path).get("rules", [])
    inter = root / "inter_table.json"
    traditional = root / "traditional.json"
    custom = child / "custom_rules.json"
    return {
        "discovery_id": discovery_id, "recommendation_id": rec_id,
        "individual_rules": individual,
        "inter_table_rules": store.read_json(inter).get("rules", []) if inter.is_file() else [],
        "traditional_rules": store.read_json(traditional).get("rules", []) if traditional.is_file() else [],
        "custom_rules": store.read_json(custom).get("rules", []) if custom.is_file() else [],
        "status": store.read_json(child / "manifest.json")["status"],
    }


@router.get("/{discovery_id}/recommendation-runs/{rec_id}/traditional-checks")
def get_traditional_checks(discovery_id: str, rec_id: str):
    child = _child(discovery_id, rec_id)
    path = child / "recommendations" / "traditional.json"
    return store.read_json(path) if path.is_file() else {"rules": [], "selections": []}


@router.post("/{discovery_id}/recommendation-runs/{rec_id}/traditional-checks")
def save_traditional_checks(discovery_id: str, rec_id: str, payload: SelectionRequest):
    child = _child(discovery_id, rec_id)
    if store.read_json(child / "manifest.json")["status"] != "completed":
        raise HTTPException(409, "Complete recommendation generation before adding traditional checks")
    try:
        result = artifact(child, rec_id, payload.selections)
    except TraditionalCheckError as exc:
        raise HTTPException(422, str(exc)) from exc
    store.write_json(child / "recommendations" / "traditional.json", result)
    return result


@router.get("/{discovery_id}/recommendation-runs/{rec_id}/custom-rules")
def get_custom_rules(discovery_id: str, rec_id: str):
    child = _child(discovery_id, rec_id)
    path = child / "custom_rules.json"
    return store.read_json(path) if path.is_file() else {"rules": []}


@router.post("/{discovery_id}/recommendation-runs/{rec_id}/custom-rules", status_code=201)
def create_custom_rule(discovery_id: str, rec_id: str, payload: CustomRuleInput):
    child = _child(discovery_id, rec_id)
    _validate_custom_rule(_parent(discovery_id), payload)
    path = child / "custom_rules.json"
    record = {"id": f"custom:{uuid4().hex}", "source": "user", **payload.model_dump()}
    with store._LOCK:
        stored = store.read_json(path) if path.is_file() else {"rules": []}
        stored["rules"].append(record)
        store.write_json(path, stored)
    return record


@router.put("/{discovery_id}/recommendation-runs/{rec_id}/custom-rules/{rule_id}")
def update_custom_rule(discovery_id: str, rec_id: str, rule_id: str, payload: CustomRuleInput):
    child = _child(discovery_id, rec_id)
    _validate_custom_rule(_parent(discovery_id), payload)
    path = child / "custom_rules.json"
    with store._LOCK:
        stored = store.read_json(path) if path.is_file() else {"rules": []}
        for index, rule in enumerate(stored["rules"]):
            if rule["id"] == rule_id:
                stored["rules"][index] = {"id": rule_id, "source": "user", **payload.model_dump()}
                store.write_json(path, stored)
                return stored["rules"][index]
    raise HTTPException(404, "Custom rule not found")


@router.delete("/{discovery_id}/recommendation-runs/{rec_id}/custom-rules/{rule_id}")
def delete_custom_rule(discovery_id: str, rec_id: str, rule_id: str):
    child = _child(discovery_id, rec_id)
    path = child / "custom_rules.json"
    with store._LOCK:
        stored = store.read_json(path) if path.is_file() else {"rules": []}
        remaining = [r for r in stored["rules"] if r.get("id") != rule_id]
        if len(remaining) == len(stored["rules"]):
            raise HTTPException(404, "Custom rule not found")
        store.write_json(path, {"rules": remaining})
    return {"deleted": True, "id": rule_id}


@router.get("/{discovery_id}/recommendation-runs/{rec_id}/review")
def get_review(discovery_id: str, rec_id: str):
    path = _child(discovery_id, rec_id) / "reviewed_rules.json"
    return store.read_json(path) if path.is_file() else {"rules": []}


@router.put("/{discovery_id}/recommendation-runs/{rec_id}/review")
def save_review(discovery_id: str, rec_id: str, payload: ReviewSelection):
    child = _child(discovery_id, rec_id)
    ids = [rule.id for rule in payload.rules]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "Duplicate rule IDs in reviewed selection")
    record = {"rules": [r.model_dump() for r in payload.rules], "updated_at": store.now()}
    store.write_json(child / "reviewed_rules.json", record)
    return record
