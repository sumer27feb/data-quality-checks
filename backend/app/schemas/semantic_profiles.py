"""Validated semantic-profile contract, separate from model-inference transport."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


SemanticRole = Literal[
    "identifier", "categorical", "measure", "temporal", "boolean_flag",
    "descriptive_text", "unknown",
]
Confidence = Literal["high", "medium", "low"]


class ColumnSemanticProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column_name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    semantic_role: SemanticRole
    semantic_type: str = Field(min_length=1)
    entity: str = Field(min_length=1)
    confidence: Confidence


class TableSemantics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str = Field(min_length=1)
    business_entity: str = Field(min_length=1)
    row_grain: str = Field(min_length=1)


class TableSemanticProfile(BaseModel):
    """Model response uses an array; saved JSON uses a name-keyed object."""

    model_config = ConfigDict(extra="forbid")

    table_name: str = Field(min_length=1)
    table_semantics: TableSemantics
    columns: list[ColumnSemanticProfile]


def response_json_schema() -> dict:
    """A small inline schema compatible with restricted JSON Schema providers.

    No $ref, anyOf, oneOf, or regex patterns. Pydantic is the final validator.
    """
    def obj(properties: dict) -> dict:
        return {
            "type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False,
        }

    column_schema = obj({
        "column_name": {"type": "string"},
        "description": {"type": "string"},
        "semantic_role": {"type": "string", "enum": [
            "identifier", "categorical", "measure", "temporal",
            "boolean_flag", "descriptive_text", "unknown",
        ]},
        "semantic_type": {"type": "string"},
        "entity": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    })
    table_schema = obj({
        "description": {"type": "string"},
        "business_entity": {"type": "string"},
        "row_grain": {"type": "string"},
    })
    return obj({
        "table_name": {"type": "string"},
        "table_semantics": table_schema,
        "columns": {"type": "array", "items": column_schema},
    })
