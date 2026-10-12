"""Common LLM recommendation schema for individual- and inter-table rule inference.

This module is the single source of truth for the *model output* contract:
Pydantic classes validate responses, and RESPONSE_JSON_SCHEMA is submitted to
Databricks' OpenAI-compatible Responses API as a strict structured-output format.

It does not attempt to parse or execute the SQL-compatible predicates in `rule`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Impact(_StrictModel):
    """Estimated consequence of a violation, not an observed failure rate."""

    level: Literal["low", "medium", "high"]
    reason: str = Field(min_length=1)


class RecommendedRule(_StrictModel):
    """A proposed check; `rule` is a SQL-compatible boolean predicate."""

    rule: str = Field(min_length=1)
    description: str = Field(min_length=1)
    proposed_relation: str | None  # null when there is no column relationship
    impact: Impact


class RuleRecommendations(_StrictModel):
    """An empty list is valid when no defensible recommendations were found."""

    rules: list[RecommendedRule]


# Kept explicit and flat to avoid $defs/$ref compatibility issues with model
# serving implementations that accept a restricted JSON Schema subset.
# Required fields and additionalProperties mirror the Pydantic models above.
# Nonblank-string checks are enforced by Pydantic after inference rather than
# adding format constraints that some serving endpoints may not accept.
RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rule": {"type": "string"},
                    "description": {"type": "string"},
                    "proposed_relation": {"type": ["string", "null"]},
                    "impact": {
                        "type": "object",
                        "properties": {
                            "level": {
                                "type": "string",
                                "enum": ["low", "medium", "high"],
                            },
                            "reason": {"type": "string"},
                        },
                        "required": ["level", "reason"],
                        "additionalProperties": False,
                    },
                },
                "required": ["rule", "description", "proposed_relation", "impact"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["rules"],
    "additionalProperties": False,
}
