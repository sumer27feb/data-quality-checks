"""Discover Unity Catalog tables and Volume configuration JSONs.

Only structural metadata is queried. No table rows or row counts.
The local discovery snapshot is replaced after successful discovery.

artifacts_root is the dataset directory itself, for example:
    artifacts/workspace.data_quality_rules

Generated artifacts:
    <artifacts_root>/discovery/tables/
    <artifacts_root>/discovery/configs/
    <artifacts_root>/discovery/relationships.json
    <artifacts_root>/discovery/matching_results.json

Run from backend/:
    python -m app.services.dataset_discovery
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from app.config import (
    ARTIFACTS_ROOT,
    DATABRICKS_CATALOG,
    DATABRICKS_SCHEMA,
    DATABRICKS_CONFIG_DIR,
    DATABRICKS_SERVER_HOSTNAME,
    DATABRICKS_HTTP_PATH,
    DATABRICKS_TOKEN,
)


def _sql_identifier(value: str) -> str:
    """Validate and quote a catalog/schema identifier."""
    if not isinstance(value, str) or not re.fullmatch(
        r"[A-Za-z_][A-Za-z0-9_]*",
        value,
    ):
        raise ValueError(
            f"Unsupported catalog/schema identifier: {value!r}"
        )

    return f"`{value}`"


def _fetch_rows(
    cursor: Any,
    query: str,
) -> list[dict[str, Any]]:
    cursor.execute(query)
    fields = [column[0].lower() for column in cursor.description]

    return [
        dict(zip(fields, row))
        for row in cursor.fetchall()
    ]


def discover_tables(
    connection: Any,
    catalog: str,
    schema: str,
) -> tuple[dict[str, dict], list[dict]]:
    """Discover table/column names from Unity Catalog."""
    metadata_schema = f"{_sql_identifier(catalog)}.information_schema"
    _sql_identifier(schema)

    predicate = (
        f"table_catalog = '{catalog}' "
        f"AND table_schema = '{schema}'"
    )

    with connection.cursor() as cursor:
        table_rows = _fetch_rows(
            cursor,
            f"""
            SELECT table_name, table_type
            FROM {metadata_schema}.tables
            WHERE {predicate}
            ORDER BY table_name
            """,
        )

        column_rows = _fetch_rows(
            cursor,
            f"""
            SELECT table_name, column_name, ordinal_position
            FROM {metadata_schema}.columns
            WHERE {predicate}
            ORDER BY table_name, ordinal_position
            """,
        )

    columns_by_table: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for row in column_rows:
        columns_by_table[row["table_name"]].append(
            {
                "name": row["column_name"],
                "ordinal_position": row["ordinal_position"],
            }
        )

    tables: dict[str, dict] = {}
    skipped: list[dict] = []

    for row in table_rows:
        name = row["table_name"]
        table_type = row["table_type"]

        if "VIEW" in str(table_type).upper():
            skipped.append(
                {
                    "table_name": name,
                    "table_type": table_type,
                }
            )
            continue

        tables[name] = {
            "catalog": catalog,
            "schema": schema,
            "table_name": name,
            "full_name": f"{catalog}.{schema}.{name}",
            "columns": columns_by_table.get(name, []),
        }

    return tables, skipped


def discover_configs(
    files_api: Any,
    config_dir: str,
) -> tuple[dict[str, bytes], dict[str, dict], list[dict]]:
    """Download top-level JSON files and parse them for matching.

    Original file bytes are preserved.
    Invalid or unrecognized JSON files are copied and reported.
    Listing/download errors stop discovery before publishing.
    """
    original_files: dict[str, bytes] = {}
    parsed: dict[str, dict] = {}
    issues: list[dict] = []
    seen_names: set[str] = set()

    entries = sorted(
        files_api.list_directory_contents(config_dir),
        key=lambda entry: entry.path,
    )

    for entry in entries:
        if entry.is_directory:
            continue

        filename = entry.path.rsplit("/", 1)[-1]

        if not filename.lower().endswith(".json"):
            continue

        # Prevent filename collisions on case-insensitive filesystems.
        filename_key = filename.casefold()

        if filename_key in seen_names:
            raise ValueError(
                "Duplicate config filename "
                f"(case-insensitive): {filename}"
            )

        seen_names.add(filename_key)

        response = files_api.download(entry.path)

        with response.contents as stream:
            contents = stream.read()

        original_files[filename] = contents

        try:
            value = json.loads(contents.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            issues.append(
                {
                    "issue": "invalid_json",
                    "file": filename,
                    "details": str(exc),
                }
            )
            continue

        if not isinstance(value, dict):
            issues.append(
                {
                    "issue": "unrecognized_json_structure",
                    "file": filename,
                }
            )
            continue

        parsed[filename] = value

    return original_files, parsed, issues


def match_tables_and_configs(
    tables: dict[str, dict],
    configs: dict[str, dict],
    config_issues: list[dict],
    skipped_relations: list[dict],
) -> dict[str, Any]:
    """Match table names and column-name sets."""
    issues = list(config_issues)
    table_configs: dict[str, tuple[str, dict]] = {}
    ambiguous: set[str] = set()

    for filename, config in sorted(configs.items()):
        if filename.casefold() == "relationships.json":
            continue

        name = config.get("table_name")
        columns = config.get("columns")

        if (
            not isinstance(name, str)
            or not name.strip()
            or not isinstance(columns, list)
        ):
            issues.append(
                {
                    "issue": "unrecognized_table_config",
                    "file": filename,
                }
            )
            continue

        key = name.casefold()

        if key in table_configs:
            issues.append(
                {
                    "issue": "duplicate_table_config",
                    "table": name,
                    "files": [
                        table_configs[key][0],
                        filename,
                    ],
                }
            )
            ambiguous.add(key)
        else:
            table_configs[key] = (filename, config)

    for key in ambiguous:
        del table_configs[key]

    tables_by_key = {
        name.casefold(): table
        for name, table in tables.items()
    }

    matched_tables: list[str] = []
    columns_matched_tables: list[str] = []
    tables_without_configs: list[str] = []
    configs_without_tables: list[str] = []
    column_mismatches: list[dict] = []

    for key, table in sorted(tables_by_key.items()):
        if key not in table_configs:
            tables_without_configs.append(table["table_name"])
            continue

        filename, config = table_configs[key]
        name = table["table_name"]

        matched_tables.append(name)

        actual = {
            column["name"].casefold(): column["name"]
            for column in table["columns"]
        }

        expected: dict[str, str] = {}
        invalid_columns = False

        for column in config["columns"]:
            if (
                not isinstance(column, dict)
                or not isinstance(column.get("name"), str)
                or not column["name"].strip()
            ):
                issues.append(
                    {
                        "issue": "invalid_column_definition",
                        "table": name,
                        "file": filename,
                    }
                )
                invalid_columns = True
                continue

            column_key = column["name"].casefold()

            if column_key in expected:
                issues.append(
                    {
                        "issue": "duplicate_config_column",
                        "table": name,
                        "column": column["name"],
                    }
                )
                invalid_columns = True

            expected[column_key] = column["name"]

        missing_from_config = actual.keys() - expected.keys()
        missing_from_table = expected.keys() - actual.keys()

        for column_key in sorted(missing_from_config):
            column_mismatches.append(
                {
                    "table": name,
                    "column": actual[column_key],
                    "issue": "column_missing_in_config",
                }
            )

        for column_key in sorted(missing_from_table):
            column_mismatches.append(
                {
                    "table": name,
                    "column": expected[column_key],
                    "issue": "column_missing_in_table",
                }
            )

        if (
            not missing_from_config
            and not missing_from_table
            and not invalid_columns
        ):
            columns_matched_tables.append(name)

    for key, (_, config) in sorted(table_configs.items()):
        if key not in tables_by_key:
            configs_without_tables.append(config["table_name"])

    if "relationships.json" not in {
        filename.casefold()
        for filename in configs
    }:
        issues.append(
            {
                "issue": "relationships_file_missing",
            }
        )

    return {
        "matched_tables": matched_tables,
        "columns_matched_tables": columns_matched_tables,
        "tables_without_configs": tables_without_configs,
        "configs_without_tables": configs_without_tables,
        "column_mismatches": column_mismatches,
        "configuration_issues": issues,
        "ignored_views": skipped_relations,
        "summary": {
            "table_count": len(tables),
            "parsed_json_file_count": len(configs),
            "table_config_count": len(table_configs),
            "matched_table_count": len(matched_tables),
            "columns_matched_table_count": len(
                columns_matched_tables
            ),
            "column_mismatch_count": len(column_mismatches),
            "configuration_issue_count": len(issues),
        },
    }


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    path.write_text(
        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False,
        ) + "\n",
        encoding="utf-8",
    )


def _save_discovery(
    destination: Path,
    tables: dict[str, dict],
    original_configs: dict[str, bytes],
    matching: dict[str, Any],
) -> None:
    """Stage and publish a replacement discovery snapshot.

    Caller must avoid concurrent discovery writes for the same dataset.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    backup = destination.parent / ".discovery_previous"

    if backup.exists():
        # Recover from interruption after moving the previous snapshot.
        if not destination.exists():
            backup.rename(destination)
        else:
            shutil.rmtree(backup)

    with tempfile.TemporaryDirectory(
        prefix=".discovery_staging_",
        dir=destination.parent,
    ) as temp:
        staging = Path(temp) / "discovery"

        (staging / "tables").mkdir(parents=True)
        (staging / "configs").mkdir()

        for name, table in sorted(tables.items()):
            _write_json(
                staging / "tables" / f"{name}.json",
                table,
            )

        for filename, raw in sorted(original_configs.items()):
            (staging / "configs" / filename).write_bytes(raw)

            if filename.casefold() == "relationships.json":
                (staging / "relationships.json").write_bytes(raw)

        _write_json(
            staging / "matching_results.json",
            matching,
        )

        if destination.exists():
            destination.rename(backup)

        try:
            staging.rename(destination)
        except OSError:
            if backup.exists() and not destination.exists():
                backup.rename(destination)
            raise

        if backup.exists():
            shutil.rmtree(backup)


def discover_dataset(
    catalog: str | None = None,
    schema: str | None = None,
    config_dir: str | None = None,
    artifacts_root: str | Path | None = None,
    *,
    sql_connection: Any = None,
    files_api: Any = None,
) -> dict[str, Any]:
    """Discover metadata and replace the discovery snapshot.

    artifacts_root is the dataset directory itself.
    Explicit arguments override app.config defaults.

    SQL connection and Files API may be supplied for testing or reuse.
    """
    catalog = (
        catalog if catalog is not None else DATABRICKS_CATALOG
    )
    schema = (
        schema if schema is not None else DATABRICKS_SCHEMA
    )
    config_dir = (
        config_dir
        if config_dir is not None
        else DATABRICKS_CONFIG_DIR
    )

    if not all(
        isinstance(value, str) and value.strip()
        for value in (catalog, schema, config_dir)
    ):
        raise ValueError(
            "Provide catalog, schema, and config_dir, or configure "
            "DATABRICKS_CATALOG, DATABRICKS_SCHEMA, "
            "and DATABRICKS_CONFIG_DIR."
        )

    _sql_identifier(catalog)
    _sql_identifier(schema)

    root = Path(
        artifacts_root
        if artifacts_root is not None
        else ARTIFACTS_ROOT
    )
    destination = root / "discovery"

    owns_connection = sql_connection is None

    try:
        if owns_connection or files_api is None:
            hostname = (
                (DATABRICKS_SERVER_HOSTNAME or "")
                .removeprefix("https://")
                .rstrip("/")
            )
            token = DATABRICKS_TOKEN
            http_path = DATABRICKS_HTTP_PATH

            if not hostname or not token or (
                owns_connection and not http_path
            ):
                raise EnvironmentError(
                    "Configure DATABRICKS_SERVER_HOSTNAME "
                    "and DATABRICKS_TOKEN; DATABRICKS_HTTP_PATH "
                    "is also required for SQL connections."
                )

            if owns_connection:
                from databricks import sql

                sql_connection = sql.connect(
                    server_hostname=hostname,
                    http_path=http_path,
                    access_token=token,
                )

            if files_api is None:
                from databricks.sdk import WorkspaceClient

                files_api = WorkspaceClient(
                    host=f"https://{hostname}",
                    token=token,
                ).files

        tables, skipped = discover_tables(
            sql_connection,
            catalog,
            schema,
        )

        original_configs, parsed_configs, config_issues = (
            discover_configs(
                files_api,
                config_dir,
            )
        )

    finally:
        if owns_connection and sql_connection is not None:
            sql_connection.close()

    matching = match_tables_and_configs(
        tables,
        parsed_configs,
        config_issues,
        skipped,
    )

    _save_discovery(
        destination,
        tables,
        original_configs,
        matching,
    )

    return {
        "discovery_path": str(destination.resolve()),
        "matching_results_path": str(
            (destination / "matching_results.json").resolve()
        ),
        "table_count": len(tables),
        "config_file_count": len(original_configs),
        "matched_table_count": len(
            matching["matched_tables"]
        ),
        "columns_matched_table_count": len(
            matching["columns_matched_tables"]
        ),
        "column_mismatch_count": len(
            matching["column_mismatches"]
        ),
        "configuration_issue_count": len(
            matching["configuration_issues"]
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Discover Databricks table metadata and Volume JSON configs"
        )
    )
    parser.add_argument(
        "--catalog",
        default=DATABRICKS_CATALOG,
    )
    parser.add_argument(
        "--schema",
        default=DATABRICKS_SCHEMA,
    )
    parser.add_argument(
        "--config-dir",
        default=DATABRICKS_CONFIG_DIR,
    )
    parser.add_argument(
        "--artifacts-root",
        default=ARTIFACTS_ROOT,
    )

    args = parser.parse_args()

    result = discover_dataset(
        catalog=args.catalog,
        schema=args.schema,
        config_dir=args.config_dir,
        artifacts_root=args.artifacts_root,
    )

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()