import {
  BrainCircuit,
  ChartNoAxesCombined,
  CheckCircle2,
  Circle,
  DatabaseZap,
  Layers3,
  ListChecks,
  LoaderCircle,
  Network,
  SearchCheck,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import {
  STAGE_STATUS_LABELS,
  type DisplayStageStatus,
  type StageDefinition,
  type StageId,
} from "./pipeline-config";

export type PipelineStageNode = Node<
  {
    stage: StageDefinition;
    status: DisplayStageStatus;
    activeSelection: boolean;
    primaryMetric: string | null;
  },
  "pipelineStage"
>;

const stageIcons: Record<StageId, LucideIcon> = {
  dataset_discovery: SearchCheck,
  statistical_profiling: ChartNoAxesCombined,
  semantic_profiling: BrainCircuit,
  table_consolidation: Layers3,
  individual_recommendations: ListChecks,
  inter_table_consolidation: Network,
  inter_table_recommendations: ShieldCheck,
};

const statusTheme: Record<
  DisplayStageStatus,
  {
    border: string;
    badge: string;
    icon: string;
    line: string;
  }
> = {
  pending: {
    border: "border-slate-200",
    badge: "bg-slate-100 text-slate-500",
    icon: "bg-slate-100 text-slate-500",
    line: "bg-slate-300",
  },
  running: {
    border: "border-blue-400",
    badge: "bg-blue-100 text-blue-700",
    icon: "bg-blue-50 text-blue-700",
    line: "bg-blue-500",
  },
  completed: {
    border: "border-emerald-300",
    badge: "bg-emerald-50 text-emerald-700",
    icon: "bg-emerald-50 text-emerald-700",
    line: "bg-emerald-500",
  },
  interrupted: {
    border: "border-amber-300",
    badge: "bg-amber-50 text-amber-800",
    icon: "bg-amber-50 text-amber-700",
    line: "bg-amber-500",
  },
  unknown: {
    border: "border-dashed border-slate-300",
    badge: "bg-slate-100 text-slate-500",
    icon: "bg-slate-100 text-slate-500",
    line: "bg-slate-400",
  },
};

export default function PipelineNode({ data }: NodeProps<PipelineStageNode>) {
  const { stage, status, activeSelection, primaryMetric } = data;
  const Icon = stageIcons[stage.id] ?? DatabaseZap;
  const theme = statusTheme[status];

  const hasSource =
    stage.id !== "individual_recommendations" &&
    stage.id !== "inter_table_recommendations";

  return (
    <div
      className={[
        "relative w-60.5 overflow-visible rounded-2xl border-2 bg-white p-3.5 text-left",
        "shadow-[0_10px_24px_rgba(15,23,42,0.08)] transition-all duration-200",
        "hover:shadow-[0_12px_28px_rgba(15,23,42,0.13)]",
        theme.border,
        activeSelection ? "ring-[3px] ring-blue-200" : "",
        status === "running" ? "shadow-blue-100" : "",
      ].join(" ")}
    >
      {stage.id !== "dataset_discovery" && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={false}
          className="h-2.5 w-2.5 border-2 border-white bg-slate-400"
        />
      )}
      {hasSource && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectable={false}
          className="h-2.5 w-2.5 border-2 border-white bg-slate-400"
        />
      )}

      <div
        className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${theme.line}`}
      />

      <div className="flex items-start gap-2.5">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${theme.icon}`}
        >
          <Icon size={19} strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {stage.track === "Shared pipeline"
              ? "Core pipeline"
              : stage.track === "Individual-table branch"
                ? "Individual branch"
                : "Inter-table branch"}
          </p>
          <p className="mt-0.5 text-[13px] font-semibold leading-4 text-slate-900">
            {stage.title}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold ${theme.badge}`}
        >
          {status === "completed" ? (
            <CheckCircle2 size={12} />
          ) : status === "running" ? (
            <LoaderCircle size={12} className="animate-spin" />
          ) : (
            <Circle size={11} />
          )}
          {STAGE_STATUS_LABELS[status]}
        </span>
        {primaryMetric !== null && (
          <span
            className="truncate text-[10px] font-semibold text-slate-600"
            title={primaryMetric}
          >
            {primaryMetric}
          </span>
        )}
      </div>
    </div>
  );
}
