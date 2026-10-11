"""Offline tests. No credentials and no live Databricks LLM request."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.schemas.semantic_profiles import TableSemanticProfile, response_json_schema
from app.config import DATABRICKS_CATALOG, DATABRICKS_SCHEMA, DATABRICKS_MODEL_ENDPOINT
from app.services.semantic_profiler import (
    _discover_inputs, _validate_response, profile_semantics,
)


CAT = DATABRICKS_CATALOG
SCH = DATABRICKS_SCHEMA


def write_json(path: Path, content: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content), encoding="utf-8")


def setup_fixture(tmp_path: Path, tables=("categories", "orders")) -> Path:
    dataset = tmp_path / f"{CAT}.{SCH}"
    discovery = dataset / "discovery"
    write_json(discovery / "matching_results.json", {"columns_matched_tables": list(tables)})
    config_columns = {
        "categories": ["category_id", "category_name"],
        "orders": ["order_id", "category_id"],
    }
    for table in tables:
        cols = config_columns[table]
        write_json(discovery / "configs" / f"{table}.json", {
            "table_name": table,
            "columns": [{"name": c, "datatype": "STRING", "nullable": False} for c in cols],
        })
        write_json(dataset / "statistical_profiles" / f"{table}.json", {
            "table_name": table,
            "row_count": 5,
            "column_count": len(cols),
            "columns": {col: {"column_name": col, "expected_type": "STRING", "physical_type": "STRING", "statistics": {"distinct_count": 5}} for col in cols},
        })
    write_json(discovery / "configs" / "relationships.json", {
        "foreign_keys": [
            {"from_table": "orders", "from_column": "category_id", "to_table": "categories", "to_column": "category_id"},
            {"from_table": "products", "from_column": "category_id", "to_table": "categories", "to_column": "category_id"},
            {"from_table": "payments", "from_column": "order_id", "to_table": "orders", "to_column": "order_id"},
        ],
    })
    return dataset


def valid_output(table: str, columns: list[str]) -> str:
    return json.dumps({
        "table_name": table,
        "table_semantics": {
            "description": "Records in a business table",
            "business_entity": table,
            "row_grain": "Likely one record per identifier",
        },
        "columns": [{
            "column_name": col,
            "description": f"Meaning of {col}",
            "semantic_role": "identifier",
            "semantic_type": f"{col}_identifier",
            "entity": table,
            "confidence": "medium",
        } for col in columns],
    })


class MockResponses:
    def __init__(self, responder):
        self.calls = []
        self.responder = responder

    def create(self, **kwargs):
        self.calls.append(kwargs)
        data = json.loads(kwargs["input"][0]["content"][0]["text"])
        return self.responder(data)


def mock_client(responder):
    responses = MockResponses(responder)
    return SimpleNamespace(responses=responses), responses


def _response(data):
    names = list(data["statistical_profile"]["columns"])
    return SimpleNamespace(status="completed", output_text=valid_output(data["table_name"], names))


def test_schema_is_inline_strict_and_pydantic_validates():
    schema = response_json_schema()
    assert "$ref" not in json.dumps(schema)
    assert "anyOf" not in json.dumps(schema)
    assert schema["required"] == ["table_name", "table_semantics", "columns"]
    assert schema["additionalProperties"] is False
    TableSemanticProfile.model_validate_json(valid_output("orders", ["order_id"]))


def test_one_inference_request_per_table(tmp_path):
    setup_fixture(tmp_path)
    client, responses = mock_client(_response)
    result = profile_semantics(artifacts_root=tmp_path, client=client)
    assert result["table_count"] == 2
    assert result["column_count"] == 4
    assert len(responses.calls) == 2
    assert all(call["model"] == DATABRICKS_MODEL_ENDPOINT for call in responses.calls)
    assert all(call["text"]["format"]["strict"] for call in responses.calls)
    assert all(call["max_output_tokens"] == 8192 for call in responses.calls)
    saved = json.loads((tmp_path / f"{CAT}.{SCH}" / "semantic_profiles" / "orders.json").read_text())
    assert list(saved["columns"]) == ["order_id", "category_id"]
    assert set(saved["table_semantics"]) == {"description", "business_entity", "row_grain"}


def test_prompt_includes_relevant_config_statistics_and_er_only(tmp_path):
    dataset = setup_fixture(tmp_path)
    inputs = _discover_inputs(dataset)
    assert len(inputs) == 2
    orders = next(item for item in inputs if item["table_name"] == "orders")
    assert orders["table_config"]["columns"][0]["datatype"] == "STRING"
    assert orders["statistical_profile"]["row_count"] == 5
    assert len(orders["er_relationships"]) == 2
    assert all("orders" in (r["from_table"], r["to_table"]) for r in orders["er_relationships"])


def test_reject_missing_or_duplicate_columns(tmp_path):
    dataset = setup_fixture(tmp_path)
    table_input = _discover_inputs(dataset)[0]
    wrong = valid_output("categories", ["category_id", "category_id"])
    with pytest.raises(ValueError, match="coverage mismatch"):
        _validate_response(wrong, table_input)
    with pytest.raises(ValueError, match="coverage mismatch"):
        _validate_response(valid_output("categories", ["category_id"]), table_input)


def test_reject_unknown_role_and_extraneous_fields(tmp_path):
    table_input = _discover_inputs(setup_fixture(tmp_path))[0]
    content = json.loads(valid_output("categories", ["category_id", "category_name"]))
    content["columns"][0]["semantic_role"] = "unapproved"
    with pytest.raises(ValueError, match="Invalid semantic output"):
        _validate_response(json.dumps(content), table_input)
    content["columns"][0]["semantic_role"] = "identifier"
    content["suggested_rule"] = "UNIQUE"
    with pytest.raises(ValueError, match="Invalid semantic output"):
        _validate_response(json.dumps(content), table_input)


def test_reject_different_table_name(tmp_path):
    inp = _discover_inputs(setup_fixture(tmp_path))[0]
    with pytest.raises(ValueError, match="returned table"):
        _validate_response(valid_output("products", ["category_id", "category_name"]), inp)


def test_failure_keeps_old_snapshot(tmp_path):
    dataset = setup_fixture(tmp_path)
    output_path = dataset / "semantic_profiles" / "keep.json"
    write_json(output_path, {"older": True})

    def fail_second(data):
        if data["table_name"] == "orders":
            return SimpleNamespace(status="incomplete", output_text="{}")
        return _response(data)

    client, responses = mock_client(fail_second)
    with pytest.raises(RuntimeError, match="not completed"):
        profile_semantics(artifacts_root=tmp_path, client=client)
    assert len(responses.calls) == 2
    assert json.loads(output_path.read_text()) == {"older": True}
    assert not (dataset / "semantic_profiles" / "categories.json").exists()


def test_success_overwrites_old_snapshot(tmp_path):
    dataset = setup_fixture(tmp_path)
    output_path = dataset / "semantic_profiles" / "stale.json"
    write_json(output_path, {"old": True})
    client, responses = mock_client(_response)
    profile_semantics(artifacts_root=tmp_path, client=client)
    assert not output_path.exists()
    assert sorted(p.name for p in (dataset / "semantic_profiles").glob("*.json")) == ["categories.json", "orders.json"]


def test_upstream_column_mismatch_aborts_before_any_call(tmp_path):
    dataset = setup_fixture(tmp_path)
    file = dataset / "statistical_profiles" / "orders.json"
    prof = json.loads(file.read_text())
    del prof["columns"]["category_id"]
    prof["column_count"] = 1
    write_json(file, prof)
    client, responses = mock_client(_response)
    with pytest.raises(ValueError, match="column mismatch"):
        profile_semantics(artifacts_root=tmp_path, client=client)
    assert len(responses.calls) == 0


def test_columns_matched_required(tmp_path):
    dataset = setup_fixture(tmp_path)
    write_json(dataset / "discovery" / "matching_results.json", {"matched_tables": ["orders"]})
    with pytest.raises(ValueError, match="columns_matched_tables"):
        _discover_inputs(dataset)
