import { z } from "zod"
import { publicProcedure, router } from "../index"
import { ergataiCaller } from "../../ergatai/caller"

export const groupChatRouter = router({
  /** List all members of a group chat (reads from backend) */
  listMembers: publicProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ input }) => {
      return ergataiCaller.getAgentBindings({ chatId: input.chatId })
    }),

  /** Add a member to a group chat (backend-only, no local DB write) */
  addMember: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        agentCommand: z.string(),
        agentName: z.string(),
        workspaceId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const existingBindings = await ergataiCaller.getAgentBindings({
        chatId: input.chatId,
      })
      const existingBinding = existingBindings.find(
        (binding) => binding.agentCommand === input.agentCommand,
      )

      if (existingBinding) {
        return existingBinding
      }

      // Backend no longer supports creating child conversations or agent binding
      console.warn("[group-chat.addMember] Group chat member addition disabled - backend endpoints removed")
      throw new Error("Adding group chat members is no longer supported")
    }),

  /** Remove a member from a group chat */
  removeMember: publicProcedure
    .input(z.object({ chatId: z.string(), agentId: z.string() }))
    .mutation(async ({ input }) => {
      // Backend no longer supports agent unbinding
      console.warn("[group-chat.removeMember] Group chat member removal disabled - backend endpoints removed")
      throw new Error("Removing group chat members is no longer supported")
    }),

  /** Send a message to a specific agent in the group (only for @mentions) */
  sendToAgent: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        agentCommand: z.string(),
        message: z.string(),
        correlationId: z.string().nullish(),
        images: z
          .array(
            z.object({
              base64Data: z.string(),
              mediaType: z.string(),
              filename: z.string().optional(),
            }),
          )
          .nullish(),
      }),
    )
    .mutation(async ({ input }) => {
      const bindings = await ergataiCaller.getAgentBindings({ chatId: input.chatId })
      const member = bindings.find(
        (b) => b.agentCommand === input.agentCommand,
      )

      if (!member?.conversationId) {
        throw new Error(`Agent ${input.agentCommand} has no active session in this group`)
      }

      const agentId = member.agentId || input.agentCommand

      await ergataiCaller.promptAgent({
        agentId: agentId,
        message: input.message,
        conversationId: member.conversationId,
        images: input.images ?? [],
        waitForStream: false,
      })

      return { success: true, conversationId: member.conversationId }
    }),
})
