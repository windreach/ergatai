// DAG Widget for Details Sidebar
// Uses @xyflow/react (React Flow) for graph rendering.
// Data comes from the active collaboration-session DAG visualization endpoint.
"use client"

import { memo } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { cn } from "@/lib/utils"

import { trpc } from "@/lib/trpc"

interface DagVisualizationNode {
  id: string
  agent: string
  task: string
  status: string
  depends_on: string[]
  x: number
  y: number
  layer: number
}

interface DagVisualization {
  dag_id: string
  nodes: DagVisualizationNode[]
  edges: { from: string; to: string }[]
}

interface DagWidgetProps {
  chatId?: string | null
  className?: string
}

function DagNodeCard({ data }: NodeProps) {
  const status = (data?.status as string) ?? "pending"
  const statusColor =
    status === "completed"
      ? "border-emerald-500/60 bg-emerald-500/10"
      : status === "running"
        ? "border-amber-500/60 bg-amber-500/10"
        : status === "failed"
          ? "border-red-500/60 bg-red-500/10"
          : status === "skipped"
            ? "border-muted-foreground/40 bg-muted/40"
            : "border-border bg-card"

  return (
    <div
      className={cn(
        // 固定宽度需与后端布局常量 DAG_NODE_WIDTH 保持一致（200px）。
        "w-[200px] overflow-hidden rounded-lg border px-3 py-2 shadow-sm",
        statusColor,
      )}
    >
      <Handle type="target" position={Position.Top} className="!bg-muted-foreground" />
      <div className="truncate text-xs font-medium text-foreground">
        {String(data?.label ?? "").slice(0, 8)}
      </div>
      {data?.agent ? (
        <div className="mt-1 truncate text-[10px] text-muted-foreground">
          {String(data.agent)}
        </div>
      ) : null}
      {data?.task ? (
        <div className="mt-1 line-clamp-2 break-all text-[10px] text-muted-foreground/80">
          {String(data.task)}
        </div>
      ) : null}
      <div className="mt-1 truncate text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {status}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-muted-foreground" />
    </div>
  )
}

const nodeTypes = { dag: DagNodeCard }

export const DagWidget = memo(function DagWidget({ chatId, className }: DagWidgetProps) {
  const sessionQuery = trpc.ergatai.getDagVisualizationByChat.useQuery(
    { chatId: chatId ?? "" },
    { enabled: !!chatId, refetchInterval: 5000 },
  )
  const globalQuery = trpc.ergatai.getDagVisualization.useQuery(undefined, {
    refetchInterval: 5000,
  })

  const sessionViz = sessionQuery.data as DagVisualization | null | undefined
  const globalViz = globalQuery.data as DagVisualization | null | undefined
  const viz =
    sessionViz && Array.isArray(sessionViz.nodes) && sessionViz.nodes.length > 0
      ? sessionViz
      : globalViz

  const isLoading = sessionQuery.isLoading || globalQuery.isLoading
  const error = sessionQuery.error ?? globalQuery.error

  const nodes: Node[] = (viz?.nodes ?? []).map((n) => ({
    id: n.id,
    type: "dag",
    position: { x: n.x, y: n.y },
    data: { label: n.id, agent: n.agent, task: n.task, status: n.status },
  }))

  const edges: Edge[] = (viz?.edges ?? []).map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    animated: true,
  }))

  const hasData = nodes.length > 0

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex items-center gap-2 px-3 h-9 select-none bg-muted/30 border-b border-border/50 shrink-0">
        <span className="text-xs font-medium text-foreground flex-1">DAG</span>
        {viz?.dag_id ? (
          <span className="text-[10px] text-muted-foreground truncate max-w-[180px]">
            {viz.dag_id}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">preview</span>
        )}
      </div>
      <div className="flex-1 min-h-0 w-full bg-background relative">
        {isLoading && !hasData ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Loading…
          </div>
        ) : error ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            Failed to load DAG
          </div>
        ) : !hasData ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
            No active DAG
          </div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            proOptions={{ hideAttribution: true }}
            className="h-full w-full"
          >
            <Background gap={16} size={1} />
            <MiniMap pannable zoomable />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
      </div>
    </div>
  )
})