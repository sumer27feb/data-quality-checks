from functools import lru_cache

from openai import OpenAI

from app.config import (
    DATABRICKS_SERVER_HOSTNAME,
    DATABRICKS_TOKEN,
)


@lru_cache(maxsize=1)
def get_llm_client() -> OpenAI:
    """Initialize and reuse the Databricks AI Gateway client."""

    if not DATABRICKS_SERVER_HOSTNAME or not DATABRICKS_TOKEN:
        raise ValueError(
            "Databricks hostname and token must be configured."
        )

    hostname = (
        DATABRICKS_SERVER_HOSTNAME
        .removeprefix("https://")
        .rstrip("/")
    )

    return OpenAI(
        api_key=DATABRICKS_TOKEN,
        base_url=f"https://{hostname}/ai-gateway/mlflow/v1",
        timeout=120.0,
        max_retries=0,
    )
