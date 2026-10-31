/**
 * Message correlation service.
 *
 * Every optimistic message that will have a durable copy should receive its
 * correlation identity here. A backend-issued external message ID lets the
 * projection replace the optimistic copy with the canonical copy without
 * guessing by role, text, or timestamps.
 */

import { trpcClient } from "../../../lib/trpc"

import {
  createMessageCorrelation,
  createOptimisticMessage,
  type CreateOptimisticMessageInput,
  type MessageCorrelation,
  type OptimisticMessage,
} from "./message-correlation"

export interface MessageCorrelationService {
  /** Allocate a backend-issued message ID, or undefined if allocation fails. */
  allocateExternalMessageId(): Promise<string | undefined>

  /** Create a correlation object for a send pipeline and its queued input. */
  createCorrelation(): Promise<MessageCorrelation>

  /** Create the optimistic UI message for a locally submitted turn. */
  createOptimisticMessage(input: CreateOptimisticMessageInput): Promise<OptimisticMessage>
}

class MessageCorrelationServiceImpl implements MessageCorrelationService {
  async allocateExternalMessageId(): Promise<string | undefined> {
    try {
      return (await trpcClient.ergatai.generateMessageId.query()).id
    } catch (error) {
      console.warn("[MessageCorrelation] Failed to allocate message ID:", error)
      return undefined
    }
  }

  async createCorrelation(): Promise<MessageCorrelation> {
    const externalMessageId = await this.allocateExternalMessageId()
    return createMessageCorrelation(externalMessageId)
  }

  async createOptimisticMessage(
    input: CreateOptimisticMessageInput,
  ): Promise<OptimisticMessage> {
    const externalMessageId =
      input.externalMessageId ?? await this.allocateExternalMessageId()
    return createOptimisticMessage({ ...input, externalMessageId })
  }
}

let serviceInstance: MessageCorrelationService | null = null

export function getMessageCorrelationService(): MessageCorrelationService {
  if (!serviceInstance) {
    serviceInstance = new MessageCorrelationServiceImpl()
  }
  return serviceInstance
}

/** Test isolation / singleton reset support. */
export function resetMessageCorrelationService(): void {
  serviceInstance = null
}
