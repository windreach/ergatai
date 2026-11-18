import { useAtom } from "jotai"
import { useMemo } from "react"
import { useTranslation } from "react-i18next"

import { collaborationModeAtom } from "../atoms"
import { getCollaborationModeConfig } from "./collaboration-mode"

export function useCollaborationMode() {
  const [mode, setMode] = useAtom(collaborationModeAtom)
  // Subscribe to language changes so translated config values refresh in place.
  const { i18n } = useTranslation()

  const config = useMemo(
    () => getCollaborationModeConfig(mode),
    [mode, i18n.language],
  )

  return {
    mode,
    setMode,
    config,
  }
}
