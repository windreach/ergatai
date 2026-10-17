"use client"

import { useCallback, useSyncExternalStore } from "react"

import { appStore } from "@/lib/jotai-store"
import type { CoreAgentId } from "../lib/agent-contract-api"
import {
  createPanelLinkScopeKey,
  normalizePanelLinkRuntimeEvent,
  panelLinkCommandAtomFamily,
} from "@/features/panel-link"

export type GroupAgentRuntimeStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "idle"

export type GroupAgentRuntimeStatuses = Partial<
  Record<CoreAgentId, GroupAgentRuntimeStatus>
>

type GroupAgentRuntimeListener = () => void

const EMPTY_STATUSES: GroupAgentRuntimeStatuses = {}
const snapshots = new Map<string, GroupAgentRuntimeStatuses>()
const listeners = new Map<string, Set<GroupAgentRuntimeListener>>()

function notify(chatId: string) {
  listeners.get(chatId)?.forEach((listener) => listener())
}

export function setGroupAgentRuntimeStatuses(
  chatId: string,
  statuses: GroupAgentRuntimeStatuses,
) {
  snapshots.set(chatId, {
    ...(snapshots.get(chatId) ?? EMPTY_STATUSES),
  ...statuses,
  })
  notify(chatId)

  const scopeKey = createPanelLinkScopeKey({ chatId })

  for (const [agentId, status] of Object.entries(statuses) as [CoreAgentId, GroupAgentRuntimeStatus][]) {
    appStore.set(
      panelLinkCommandAtomFamily(scopeKey),
      normalizePanelLinkRuntimeEvent({
        type: "agent-status-changed",
        agentId,
        chatId,
        status,
      }),
    )
  }
}

export function getGroupAgentRuntimeStatuses(chatId: string) {
  return snapshots.get(chatId) ?? EMPTY_STATUSES
}

export function useGroupAgentRuntimeStatuses(chatId: string) {
  const subscribe = useCallback(
    (listener: GroupAgentRuntimeListener) => {
      const chatListeners = listeners.get(chatId) ?? new Set()
      chatListeners.add(listener)
      listeners.set(chatId, chatListeners)

      return () => {
        chatListeners.delete(listener)
      }
    },
    [chatId],
  )

  const getSnapshot = useCallback(
    () => getGroupAgentRuntimeStatuses(chatId),
    [chatId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
