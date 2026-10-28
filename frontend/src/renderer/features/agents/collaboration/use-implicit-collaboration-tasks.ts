"use client"

import { useEffect, useMemo, useState } from "react"

import { trpc } from "../../../lib/trpc"
import {
  applyImplicitRuntimeEvent,
  parseImplicitRuntimeEvent,
  type ImplicitCollaborationTask,
} from "./implicit-collaboration"

export function useImplicitCollaborationTasks(chatId: string) {
  const [tasks, setTasks] = useState<ImplicitCollaborationTask[]>([])

  // Clear tasks when chatId changes to prevent showing stale tasks from other conversations
  useEffect(() => {
    setTasks([])
  }, [chatId])

  trpc.ergatai.subscribeCollaborationRuntime.useSubscription({ sessionId: chatId }, {
    onData(rawEvent) {
      const event = parseImplicitRuntimeEvent(rawEvent)
      if (!event || event.chatId !== chatId) return

      setTasks((currentTasks) =>
        applyImplicitRuntimeEvent(currentTasks, event),
      )
    },
    onError(error) {
      console.debug("[ImplicitCollaboration] Runtime unavailable:", error)
    },
  })

  return useMemo(
    () =>
      [...tasks].sort(
        (left, right) =>
          Number(left.status === "completed") -
            Number(right.status === "completed") ||
          right.updatedAt - left.updatedAt,
      ),
    [tasks],
  )
}
