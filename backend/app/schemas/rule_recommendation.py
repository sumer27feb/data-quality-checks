"""Shared structured LLM output contract for data quality recommendations.

The LLM supplies BOTH a logical constraint and, when possible, a complete
Spark SQL query returning exactly one row with a ``violation_count`` column.

This schema only validates JSON shape and basic field types; it does NOT
parse, verify, or execute generated SQL. SQL analysis is a separate stage.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Impact(_StrictModel):
    """Estimated consequence of violating the rule, not a measured failure."""

    level: Literal["low", "medium", "high"]
    reason: str = Field(min_length=1)


class RecommendedRule(_StrictModel):
    """One recommended invariant and its proposed Spark SQL implementation.

    ``rule`` stays a BOOLEAN predicate for backward compatibility with the
    existing lightweight reference validators and selection fingerprint.

    ``validation_sql`` is NOT considered verified simply because it is present.
    If the LLM cannot give a defensible query, it must be null and the reason
    should be supplied in ``sql_generation_note``.
    """

    rule: str = Field(min_length=1)
    validation_sql: str | None = Field(min_length=1)
    sql_generation_note: str | None = Field(min_length=1)
    description: str = Field(min_length=1)
    proposed_relation: str | None
    impact: Impact


class RuleRecommendations(_StrictModel):
    """An empty set of defensible rules is a legitimate model response."""

    rules: list[RecommendedRule]


# Explicit schema avoids $defs/$ref for hosted structured-output providers.
# All properties are required, including nullable ones, for strict mode.
# Pydantic enforces non-blank strings after inference, not JSON Schema.
RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "rules": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rule": {"type": "string"},
                    "validation_sql": {"type": ["string", "null"]},
                    "sql_generation_note": {"type": ["string", "null"]},
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
                "required": [
                    "rule",
                    "validation_sql",
                    "sql_generation_note",
                    "description",
                    "proposed_relation",
                    "impact",
                ],
                "additionalProperties": False,
            },
        },
    },
    "required": ["rules"],
    "additionalProperties": False,
}
