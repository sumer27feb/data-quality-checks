
"""LangGraph workflow for reusable dataset discovery and profiling."""

from pathlib import Path

from langgraph.graph import START, END, StateGraph

from app.config import DATABRICKS_MODEL_ENDPOINT
from app.graph.state import DQState

from app.nodes.dataset_discovery import dataset_discovery_node
from app.nodes.statistical_profiler import statistical_profiler_node
from app.nodes.semantic_profiler import semantic_profiler_node
from app.nodes.consolidated_profiler import consolidated_profiles_node

from app.services import reusable_run_store as store


# Ordered stages for Graph 1.
# Inter-table consolidation belongs to Graph 2.
DISCOVERY_STAGES = (
    ("dataset_discovery", dataset_discovery_node),
    ("statistical_profiling", statistical_profiler_node),
    ("semantic_profiling", semantic_profiler_node),
    ("table_consolidation", consolidated_profiles_node),
)


def build_discovery_graph():
    """Compile the discovery/profiling-only workflow."""

    builder = StateGraph(DQState)

    for stage_name, node_function in DISCOVERY_STAGES:
        builder.add_node(stage_name, node_function)

    stage_names = [name for name, _ in DISCOVERY_STAGES]

    builder.add_edge(START, stage_names[0])

    for current_stage, next_stage in zip(
        stage_names, stage_names[1:]
    ):
        builder.add_edge(current_stage, next_stage)

    builder.add_edge(stage_names[-1], END)

    return builder.compile()


def run_discovery(root: str) -> None:
    """Execute Graph 1 and persist its stage progress."""

    folder = Path(root)
    manifest = store.read_json(folder / "manifest.json")

    initial_state: DQState = {
        "catalog": manifest["catalog"],
        "schema": manifest["schema"],
        "config_volume_path": manifest["config_dir"],
        "llm_model": DATABRICKS_MODEL_ENDPOINT,
        "artifacts_root": str(folder),
    }

    graph = build_discovery_graph()

    stage_names = [name for name, _ in DISCOVERY_STAGES]

    store.update(folder, status="running")
    active_stage = stage_names[0]
    store.set_stage(folder, active_stage, "running")

    try:
        for event in graph.stream(
            initial_state,
            stream_mode="updates",
            version="v2",
        ):
            if event["type"] != "updates":
                continue

            for stage_name, output in event["data"].items():
                if stage_name not in stage_names:
                    raise ValueError(
                        f"Unexpected discovery stage: {stage_name}"
                    )

                active_stage = stage_name

                # Persist only numeric metrics, not full graph state.
                metrics = {
                    key: value
                    for key, value in (output or {}).items()
                    if type(value) is int
                }

                store.set_stage(
                    folder,
                    stage_name,
                    "completed",
                    metrics,
                )

                current_index = stage_names.index(stage_name)

                if current_index + 1 < len(stage_names):
                    active_stage = stage_names[current_index + 1]

                    store.set_stage(
                        folder,
                        active_stage,
                        "running",
                    )

        # A run must not be completed if the stream ended early.
        final_manifest = store.read_json(
            folder / "manifest.json"
        )

        incomplete = [
            name
            for name in stage_names
            if final_manifest["stages"][name] != "completed"
        ]

        if incomplete:
            raise RuntimeError(
                f"Discovery graph ended with incomplete stages: "
                f"{', '.join(incomplete)}"
            )

        store.update(
            folder,
            status="completed",
            error=None,
        )

    except Exception as exc:
        current_manifest = store.read_json(
            folder / "manifest.json"
        )

        if (
            active_stage
            and current_manifest["stages"].get(active_stage)
            == "running"
        ):
            store.set_stage(
                folder,
                active_stage,
                "interrupted",
            )

        store.update(
            folder,
            status="failed",
            error=f"{type(exc).__name__}: {exc}",
        )

        raise
