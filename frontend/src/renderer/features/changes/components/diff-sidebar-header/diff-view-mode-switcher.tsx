"use client"

import {
  IconSidePeek,
  IconCenterPeek,
  IconFullPage,
} from "@/components/ui/icons"
import { ModeSwitcher } from "@/components/ui/mode-switcher"
import type { DiffViewDisplayMode } from "@/features/agents"

interface DiffViewModeSwitcherProps {
  mode: DiffViewDisplayMode
  onModeChange: (mode: DiffViewDisplayMode) => void
}

const MODES = [
  {
    value: "side-peek" as const,
    label: "Sidebar",
    Icon: IconSidePeek,
  },
  {
    value: "center-peek" as const,
    label: "Dialog",
    Icon: IconCenterPeek,
  },
  {
    value: "full-page" as const,
    label: "Fullscreen",
    Icon: IconFullPage,
  },
]

export function DiffViewModeSwitcher({
  mode,
  onModeChange,
}: DiffViewModeSwitcherProps) {
  return (
    <ModeSwitcher
      modes={MODES}
      mode={mode}
      onModeChange={(v) => onModeChange(v as DiffViewDisplayMode)}
    />
  )
}
