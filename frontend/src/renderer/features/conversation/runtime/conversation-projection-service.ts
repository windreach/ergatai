/**
 * Conversation Projection Service
 *
 * Converts the three message sources owned by a conversation into the single
 * render model consumed by the UI. This class is deliberately framework-free:
 * it does not know React, tRPC, transports, or DOM concerns.
 *
 * Source precedence:
 *   1. persisted messages  - backend/database canonical records
 *   2. backend runtime     - live projection of a backend-owned turn
 *   3. local transport     - freshest projection of a locally submitted turn
 *
 * The backend owns turn identity (`turnId`). A canonical message replaces all
 * ephemeral projections of the same role + turn. Before persistence lands, the
 * local transport replaces the backend runtime projection of the same turn.
 */

import type { Message, MessagePart, MessageRole } from "../../agents"
import { LOCAL_TRANSPORT_STREAM_SOURCE } from "./message-correlation"

export type ConversationProjectionRawMessage = {
  id: string
  role: string
  parts?: unknown[]
  metadata?: unknown
  sequence?: number
  turnId?: string | null
  createdAt?: string | number | Date
}

export type ConversationProjectionInput = {
  conversationId?: string
  persistedMessages?: Message[]
  runtimeMessages?: Message[]
  localMessages?: Message[]
}

export type ConversationProjectionResult = {
  /** Stable, ordered, renderable messages. */
  visibleMessages: Message[]
}

export interface ConversationProjectionService {
  /** Normalize a raw API/Chat message into the common projection message. */
  normalizeRawMessage(
    message: ConversationProjectionRawMessage,
    source?: "persisted" | "runtime" | "local",
  ): Message

  /** Project independent message sources into one visible render model. */
  project(input: ConversationProjectionInput): ConversationProjectionResult
}

type ProjectionMetadata = Record<string, unknown>

function getMetadata(message: Message): ProjectionMetadata {
  return (message.metadata && typeof message.metadata === "object"
    ? message.metadata
    : {}) as ProjectionMetadata
}

/**
 * The backend owns turn identity. Durable messages carry `turn_id` (mapped to
 * `turnId`), runtime projections carry the snapshot's `turnId`, and the local
 * transport attaches it when `TurnStarted` arrives. Legacy raw messages may
 * still expose it as a top-level field, so read both shapes.
 */
function getTurnId(message: Message): string | null {
  const metadataTurnId = getMetadata(message).turnId
  const topLevelTurnId = (message as { turnId?: unknown }).turnId
  const turnId = typeof metadataTurnId === "string" && metadataTurnId
    ? metadataTurnId
    : typeof topLevelTurnId === "string" && topLevelTurnId
      ? topLevelTurnId
      : null
  return turnId || null
}

function isEphemeralStreamProjection(message: Message): boolean {
  const metadata = getMetadata(message)
  return metadata["runtime"] === true || metadata["streamSource"] === LOCAL_TRANSPORT_STREAM_SOURCE
}

function getProjectionKey(message: Message): string | null {
  const turnId = getTurnId(message)
  return turnId ? `${message.role}:${turnId}` : null
}

/**
 * Durable user messages do not currently carry a backend turnId. The backend
 * therefore also stores the client request ID in `metadata.externalMessageId`;
 * optimistic messages carry the same ID so the canonical copy can replace them.
 */
function getExternalMessageId(message: Message): string | null {
  const externalMessageId = getMetadata(message).externalMessageId
  return typeof externalMessageId === "string" && externalMessageId
    ? externalMessageId
    : null
}

function compareMessages(a: Message, b: Message): number {
  const aSequence = a.sequence ?? Number.MAX_SAFE_INTEGER
  const bSequence = b.sequence ?? Number.MAX_SAFE_INTEGER
  if (aSequence !== bSequence) return aSequence - bSequence

  const aTime = a.createdAt?.getTime() ?? 0
  const bTime = b.createdAt?.getTime() ?? 0
  if (aTime !== bTime) return aTime - bTime

  return a.id.localeCompare(b.id)
}

class ConversationProjectionServiceImpl implements ConversationProjectionService {
  // Per-conversation cache so concurrent conversations don't evict each other's
  // cached projection (the previous single-slot cache caused cache misses and
  // redundant O(n) projections on every render in multi-conversation scenarios).
  // Bounded LRU to avoid unbounded memory growth across many conversations.
  private static readonly MAX_PROJECTION_CACHE_SIZE = 64
  private projectionCache = new Map<
    string,
    {
      persisted: Message[] | undefined
      runtime: Message[] | undefined
      local: Message[] | undefined
      result: ConversationProjectionResult
    }
  >()

  normalizeRawMessage(
    message: ConversationProjectionRawMessage,
    source?: "persisted" | "runtime" | "local",
  ): Message {
    const normalizedMetadata: ProjectionMetadata = {
      ...(message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
        ? message.metadata
        : {}),
    }

    // Force source identity so downstream ephemeral/canonical classification
    // does not depend on whether the transport happened to attach metadata.
    if (source === "runtime" && normalizedMetadata.runtime !== true) {
      normalizedMetadata.runtime = true
    }
    if (
      source === "local" &&
      normalizedMetadata.streamSource !== LOCAL_TRANSPORT_STREAM_SOURCE
    ) {
      normalizedMetadata.streamSource = LOCAL_TRANSPORT_STREAM_SOURCE
    }
    if (source === "persisted") {
      // Persisted messages are canonical; strip ephemeral markers that may
      // have leaked from a previous normalized copy.
      delete normalizedMetadata.runtime
      delete normalizedMetadata.streamSource
    }
    if (
      typeof message.turnId === "string" &&
      message.turnId &&
      !normalizedMetadata.turnId
    ) {
      normalizedMetadata.turnId = message.turnId
    }

    const runtimeSequence = normalizedMetadata.runtimeSequence
    return {
      id: message.id,
      role: message.role as MessageRole,
      parts: (message.parts ?? []) as MessagePart[],
      metadata: normalizedMetadata,
      sequence:
        typeof message.sequence === "number"
          ? message.sequence
          : typeof runtimeSequence === "number"
            ? runtimeSequence
            : undefined,
      createdAt: message.createdAt
        ? new Date(message.createdAt)
        : undefined,
    }
  }

  project(input: ConversationProjectionInput): ConversationProjectionResult {
    const fingerprint = (msgs?: Message[]) => (msgs ?? []).map((m) => m.id).join(",")
    const persistedFp = fingerprint(input.persistedMessages)
    const runtimeFp = fingerprint(input.runtimeMessages)
    const localFp = fingerprint(input.localMessages)
    const cacheKey = `${input.conversationId ?? "__global__"}:${input.persistedMessages?.length ?? 0}:${input.runtimeMessages?.length ?? 0}:${input.localMessages?.length ?? 0}:${persistedFp}:${runtimeFp}:${localFp}`
    const cached = this.projectionCache.get(cacheKey)
    if (
      cached &&
      cached.persisted === input.persistedMessages &&
      cached.runtime === input.runtimeMessages &&
      cached.local === input.localMessages
    ) {
      // LRU touch: move to end.
      this.projectionCache.delete(cacheKey)
      this.projectionCache.set(cacheKey, cached)
      return cached.result
    }

    const messageById = new Map<string, Message>()
    const ephemeralByProjectionKey = new Map<string, Message>()
    const ephemeralByExternalMessageId = new Map<string, Message>()
    const canonicalByExternalMessageId = new Map<string, Message>()

    const findCanonicalByProjectionKey = (
      projectionKey: string,
    ): Message | undefined => {
      for (const candidate of messageById.values()) {
        if (
          !isEphemeralStreamProjection(candidate) &&
          getProjectionKey(candidate) === projectionKey
        ) {
          return candidate
        }
      }
      return undefined
    }

    /**
     * Merge metadata from `donor` into `base`, producing a new Message.
     * Fills in fields that are missing or empty in `base`.
     * This ensures that when two versions of the same message arrive through
     * different sources (persisted / runtime / local transport), the final
     * output carries the UNION of metadata fields — so the renderer sees
     * consistent metadata regardless of which source "wins" dedup.
     */
    const mergeWithMetadata = (base: Message, donor: Message): Message => {
      const baseMeta = getMetadata(base)
      const donorMeta = getMetadata(donor)
      let changed = false
      const merged: ProjectionMetadata = { ...baseMeta }

      for (const [key, value] of Object.entries(donorMeta)) {
        if (value === undefined || value === null) continue
        const baseValue = merged[key]
        if (baseValue === undefined || baseValue === null || baseValue === "") {
          merged[key] = value
          changed = true
        }
      }

      if (!changed) return base
      return { ...base, metadata: merged }
    }

    const addMessage = (message: Message): void => {
      const projectionKey = getProjectionKey(message)
      const ephemeral = isEphemeralStreamProjection(message)
      const externalMessageId = getExternalMessageId(message)

      if (externalMessageId) {
        // A durable copy wins regardless of source order. This handles user
        // turns, where there is no backend TurnStarted to key the projection.
        if (ephemeral && canonicalByExternalMessageId.has(externalMessageId)) {
          // Merge ephemeral metadata into existing canonical (keep both in sync)
          const existing = canonicalByExternalMessageId.get(externalMessageId)!
          const merged = mergeWithMetadata(existing, message)
          if (merged !== existing) {
            messageById.set(merged.id, merged)
            canonicalByExternalMessageId.set(externalMessageId, merged)
          }
          return
        }
        if (!ephemeral) {
          const existingEphemeral = ephemeralByExternalMessageId.get(externalMessageId)
          if (existingEphemeral) {
            messageById.delete(existingEphemeral.id)
          }
          ephemeralByExternalMessageId.delete(externalMessageId)
          canonicalByExternalMessageId.set(externalMessageId, message)
        } else {
          ephemeralByExternalMessageId.set(externalMessageId, message)
        }
      }

      if (ephemeral && projectionKey) {
        // Never let a live projection overwrite the durable canonical copy.
        const canonical = findCanonicalByProjectionKey(projectionKey)
        if (canonical) {
          // Merge ephemeral metadata into canonical (enrich the durable copy)
          const merged = mergeWithMetadata(canonical, message)
          if (merged !== canonical) {
            messageById.set(merged.id, merged)
          }
          return
        }

        const existingEphemeral = ephemeralByProjectionKey.get(projectionKey)
        if (existingEphemeral) {
          // Merge existing ephemeral metadata with new ephemeral (unify across sources)
          const mergedNew = mergeWithMetadata(message, existingEphemeral)
          const mergedExisting = mergeWithMetadata(mergedNew, existingEphemeral)
          messageById.delete(existingEphemeral.id)
          ephemeralByProjectionKey.set(projectionKey, mergedExisting)
          messageById.set(mergedExisting.id, mergedExisting)
          return
        }
        ephemeralByProjectionKey.set(projectionKey, message)
        messageById.set(message.id, message)
        return
      }

      // A newly fetched canonical message replaces live projections of the
      // same backend turn. This is the handoff from streaming to durable data.
      if (projectionKey && ephemeralByProjectionKey.has(projectionKey)) {
        const existingEphemeral = ephemeralByProjectionKey.get(projectionKey)
        if (existingEphemeral) {
          // Merge ephemeral metadata into canonical before replacing
          // so the renderer sees consistent metadata
          message = mergeWithMetadata(message, existingEphemeral)
          messageById.delete(existingEphemeral.id)
        }
        ephemeralByProjectionKey.delete(projectionKey)
      }

      messageById.set(message.id, message)
    }

    for (const message of input.persistedMessages ?? []) {
      addMessage(message)
    }
    for (const message of input.runtimeMessages ?? []) {
      addMessage(message)
    }
    for (const message of input.localMessages ?? []) {
      addMessage(message)
    }

    const result = {
      visibleMessages: Array.from(messageById.values()).sort(compareMessages),
    }

    if (this.projectionCache.size >= ConversationProjectionServiceImpl.MAX_PROJECTION_CACHE_SIZE) {
      const oldest = this.projectionCache.keys().next().value
      if (oldest !== undefined) this.projectionCache.delete(oldest)
    }
    this.projectionCache.set(cacheKey, {
      persisted: input.persistedMessages,
      runtime: input.runtimeMessages,
      local: input.localMessages,
      result,
    })
    return result
  }
}

let serviceInstance: ConversationProjectionService | null = null

export function getConversationProjectionService(): ConversationProjectionService {
  if (!serviceInstance) {
    serviceInstance = new ConversationProjectionServiceImpl()
  }
  return serviceInstance
}

/** Test isolation / singleton reset support. */
export function resetConversationProjectionService(): void {
  serviceInstance = null
}
