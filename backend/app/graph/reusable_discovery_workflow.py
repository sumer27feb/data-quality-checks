"""Discovery/profiling-only LangGraph, preserving existing processing nodes."""
from langgraph.graph import START, END, StateGraph

from app.graph.state import DQState
from app.nodes.dataset_discovery import dataset_discovery_node
from app.nodes.statistical_profiler import statistical_profiler_node
from app.nodes.semantic_profiler import semantic_profiler_node
from app.nodes.consolidated_profiler import consolidated_profiles_node
from app.nodes.inter_table_profiler import inter_table_consolidation_node


def build_discovery_graph():
    builder = StateGraph(DQState)
    stages = [
        ("dataset_discovery", dataset_discovery_node),
        ("statistical_profiling", statistical_profiler_node),
        ("semantic_profiling", semantic_profiler_node),
        ("table_consolidation", consolidated_profiles_node),
        ("inter_table_consolidation", inter_table_consolidation_node),
    ]
    for name, node in stages:
        builder.add_node(name, node)
    builder.add_edge(START, stages[0][0])
    for (before, _), (after, _) in zip(stages, stages[1:]):
        builder.add_edge(before, after)
    builder.add_edge(stages[-1][0], END)
    return builder.compile()


def run_discovery(root: str):
    from pathlib import Path
    from app.config import DATABRICKS_MODEL_ENDPOINT
    from app.services.reusable_run_store import read_json, update, set_stage
    folder = Path(root)
    manifest = read_json(folder / "manifest.json")
    initial = {
        "catalog": manifest["catalog"], "schema": manifest["schema"],
        "config_volume_path": manifest["config_dir"],
        "llm_model": DATABRICKS_MODEL_ENDPOINT,
        "artifacts_root": str(folder),
    }
    graph = build_discovery_graph()
    update(folder, status="running")
    active = "dataset_discovery"
    set_stage(folder, active, "running")
    order = ("dataset_discovery", "statistical_profiling", "semantic_profiling", "table_consolidation", "inter_table_consolidation")
    try:
        for event in graph.stream(initial, stream_mode="updates", version="v2"):
            if event["type"] != "updates":
                continue
            for stage, results in event["data"].items():
                active = stage
                metrics = {k: v for k, v in (results or {}).items()
                           if isinstance(v, int) and not isinstance(v, bool)}
                set_stage(folder, stage, "completed", metrics)
                index = order.index(stage)
                if index + 1 < len(order):
                    active = order[index + 1]
                    set_stage(folder, active, "running")
        update(folder, status="completed", error=None)
    except Exception as exc:
        if active and read_json(folder / "manifest.json")["stages"].get(active) == "running":
            set_stage(folder, active, "interrupted")
        update(folder, status="failed", error=f"{type(exc).__name__}: {exc}")
        raise
