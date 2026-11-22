import i18n from "@/lib/i18n"
"use client"

import { useCallback, useState } from "react"
import { useAtom } from "jotai"
import { Bot, KeyRound, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import {
  type AgentRegistration,
  getAgentProfileName,
  getCoreAgentDisplayName,
} from "../lib/agent-contract-api"
import { registeredAgentsAtom } from "../atoms"
import { AddAgentDialog } from "./add-agent-dialog"
import { AgentAvatar } from "./agent-avatar"

interface ManageAgentsAgentSectionProps {
  /** Switch to the Providers section focused on this profile. */
  onManageProviders: (profileName: string) => void
}

export function ManageAgentsAgentSection({
  onManageProviders,
}: ManageAgentsAgentSectionProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [registeredAgents, setRegisteredAgents] = useAtom(registeredAgentsAtom)
  const utils = trpc.useUtils()

  const handleCreateAgent = useCallback(
    (agent: AgentRegistration) => {
      setRegisteredAgents((current) => [...current, agent])
      toast.success(i18n.t("{{name}} registered", { name: agent.name }))
    },
    [setRegisteredAgents],
  )

  const deleteProfileMutation = trpc.ergatai.deleteProfile.useMutation({
    onSuccess: () => {
      toast.success(i18n.t("Profile deleted from backend"))
    },
    onError: (error) => {
      toast.error(i18n.t("Failed to delete from backend"), {
        description: error.message,
      })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  const handleDeleteRegistration = useCallback(
    async (agent: AgentRegistration) => {
      try {
        await deleteProfileMutation.mutateAsync({ id: agent.id })
        setRegisteredAgents((current) =>
          current.filter((registration) => registration.id !== agent.id),
        )
        toast.success(
          i18n.t("{{name}} registration removed", { name: agent.name }),
        )
      } catch {
        toast.error(i18n.t("Failed to delete {{name}}", { name: agent.name }), {
          description: i18n.t(
            "The registration was not removed. Please try again.",
          ),
        })
      }
    },
    [deleteProfileMutation, setRegisteredAgents],
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {i18n.t("Registered agents")}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {i18n.t(
              "Agents available in chats. Add a custom runtime or manage provider connections.",
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          {i18n.t("Add Agent")}
        </Button>
      </div>

      {registeredAgents.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <Bot className="h-6 w-6 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">
            {i18n.t("No agents registered yet")}
          </p>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">
            {i18n.t(
              "Install an agent from the Install Agent section, or add a custom runtime.",
            )}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {registeredAgents.map((agent) => {
            const displayName =
              getCoreAgentDisplayName(agent.runtimeId) ?? agent.runtimeId

            return (
              <article
                key={agent.id}
                className="flex min-h-[132px] flex-col justify-between rounded-xl border border-border/60 bg-muted/10 p-3.5 transition-shadow duration-150 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <AgentAvatar
                    runtimeId={agent.runtimeId}
                    avatarUrl={agent.avatarUrl}
                  />
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[10px] font-medium">
                      {displayName}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={() => onManageProviders(getAgentProfileName(agent))}
                      title={i18n.t("Manage providers")}
                      aria-label={i18n.t(
                        "Manage providers for {{name}}",
                        { name: agent.name },
                      )}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      disabled={deleteProfileMutation.isPending}
                      onClick={() => void handleDeleteRegistration(agent)}
                      title={i18n.t(
                        "Delete registration only; the runtime binary remains installed",
                      )}
                      aria-label={i18n.t(
                        "Delete registration for {{name}}",
                        { name: agent.name },
                      )}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {agent.name}
                  </p>
                  <p
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    title={agent.startupCommand}
                  >
                    {agent.startupCommand}
                  </p>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <AddAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreateAgent={handleCreateAgent}
      />
    </div>
  )
}
