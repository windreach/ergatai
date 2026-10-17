"use client"

import { AddAgentPanel } from "./add-agent-panel"

/**
 * Full-page wrapper for the Add Agent panel.
 */
export function AddAgentViewPage() {
  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold">Add Agent</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Manage installed coding agents and connect a custom runtime.
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-6xl">
          <AddAgentPanel />
        </div>
      </div>
    </div>
  )
}
