"use client"

import { memo } from "react"
import { areToolPropsEqual } from "./agent-tool-utils"

interface ExitPlanModeToolPart {
  type: string
  state: string
  input?: Record<string, unknown>
  output?: {
    plan?: string
  }
}

interface AgentExitPlanModeToolProps {
  part: ExitPlanModeToolPart
}

// TODO: Plan is now shown in sidebar instead of inline.
// This component remains for potential future use.
// Tracking: Add issue link when component is needed again.
export const AgentExitPlanModeTool = memo(function AgentExitPlanModeTool({
  part,
}: AgentExitPlanModeToolProps) {
  return null
}, areToolPropsEqual)
