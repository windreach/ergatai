/**
 * Message correlation primitives.
 *
 * This module is intentionally transport-free. Transport-specific correlation
 * (for example, allocating a backend Snowflake ID) lives in the service module;
 * render-side projection only needs these stable metadata rules.
 */

import type { ConversationRole } from "./contracts"
import type { MessagePart } from "../../agents/stores/message-store"

export const LOCAL_TRANSPORT_STREAM_SOURCE = "local-transport"

export type LocalTransportMessageMetadata = {
  externalMessageId?: string
  streamSource: typeof LOCAL_TRANSPORT_STREAM_SOURCE
}

export type MessageCorrelation = {
  externalMessageId?: string
  metadata: LocalTransportMessageMetadata
  transportOverrides: {
    externalMessageId?: string
  }
}

export type CreateOptimisticMessageInput = {
  role: ConversationRole
  parts: MessagePart[]
  externalMessageId?: string
  metadata?: Record<string, unknown>
}

export type OptimisticMessage = {
  id?: string
  role: ConversationRole
  parts: MessagePart[]
  metadata: LocalTransportMessageMetadata & Record<string, unknown>
}

export function createMessageCorrelation(
  externalMessageId?: string,
): MessageCorrelation {
  return {
    externalMessageId,
    metadata: createLocalTransportMessageMetadata({ externalMessageId }),
    transportOverrides: { externalMessageId },
  }
}

export function createLocalTransportMessageMetadata({
  externalMessageId,
  metadata = {},
}: {
  externalMessageId?: string
  metadata?: Record<string, unknown>
} = {}): LocalTransportMessageMetadata & Record<string, unknown> {
  return {
    ...metadata,
    ...(externalMessageId ? { externalMessageId } : {}),
    streamSource: LOCAL_TRANSPORT_STREAM_SOURCE,
  }
}

export function createOptimisticMessage(
  input: CreateOptimisticMessageInput,
): OptimisticMessage {
  const externalMessageId = input.externalMessageId
  return {
    id: externalMessageId,
    role: input.role,
    parts: input.parts,
    metadata: createLocalTransportMessageMetadata({
      externalMessageId,
      metadata: input.metadata,
    }),
  }
}
