import { useAtom } from "jotai"

import { collaborationModeAtom } from "../atoms"
import { getCollaborationModeConfig } from "./collaboration-mode"

export function useCollaborationMode() {
  const [mode, setMode] = useAtom(collaborationModeAtom)

  return {
    mode,
    setMode,
    config: getCollaborationModeConfig(mode),
  }
}
