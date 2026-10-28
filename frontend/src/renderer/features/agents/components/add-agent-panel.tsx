"use client"

import { useCallback, useEffect, useState } from "react"
import { useAtom } from "jotai"
import { Download, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import { cn } from "@/lib/utils"
import {
  type AgentProfileWithStatus,
  type AgentRegistration,
  type CoreAgentId,
} from "../lib/agent-contract-api"
import { registeredAgentsAtom } from "../atoms"
import { getCoreAgentIcon } from "./core-agent-selector"
import { AddAgentDialog } from "./add-agent-dialog"

interface AddAgentPanelProps {
  className?: string
}

export function AddAgentPanel({ className }: AddAgentPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [registeredAgents, setRegisteredAgents] = useAtom(registeredAgentsAtom)
  const utils = trpc.useUtils()

  // Fetch profiles with installation status from backend
  const profilesQuery = trpc.ergatai.listProfilesWithStatus.useQuery()
  const profiles = profilesQuery.data?.profiles ?? []

  // Auto-register installed profiles into local registered agents (one-time sync)
  useEffect(() => {
    if (!profilesQuery.data) return
    const installed = profilesQuery.data.profiles.filter(
      (p: AgentProfileWithStatus) => p.installed,
    )
    setRegisteredAgents((current) => {
      // Remove stale manual adapter registrations (node + /adapters/ path)
      // that are superseded by the auto-registered backend profiles.
      const cleaned = current.filter(
        (r) => !(r.startupCommand.startsWith("node") && r.startupCommand.includes("/adapters/")),
      )
      const existingIds = new Set(cleaned.map((r) => r.id))
      const toAdd = installed
        .filter((p: AgentProfileWithStatus) => !existingIds.has(p.id))
        .map((p: AgentProfileWithStatus) => ({
          id: p.id,  // Use backend's stable ID
          name: p.name,
          runtimeId: p.name as CoreAgentId, // backend profile names are a superset of CoreAgentId
          startupCommand: p.command,
          avatarUrl: p.avatar_url || undefined,  // Sync avatar from backend
        }))

      // Update existing agents with avatar_url from backend
      const updated = cleaned.map((agent) => {
        const backendProfile = installed.find((p) => p.id === agent.id)
        if (backendProfile && backendProfile.avatar_url && !agent.avatarUrl) {
          return { ...agent, avatarUrl: backendProfile.avatar_url }
        }
        return agent
      })

      const merged = [...updated, ...toAdd]
      return merged.length !== current.length || toAdd.length > 0 ? merged : current
    })
  }, [profilesQuery.data, setRegisteredAgents])

  const installMutation = trpc.ergatai.installAgent.useMutation({
    onSuccess: (_, variables) => {
      toast.success(`${variables.name} installed`)
    },
    onError: (error) => {
      toast.error("Install failed", { description: error.message })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  const uninstallMutation = trpc.ergatai.uninstallAgent.useMutation({
    onSuccess: (_, variables) => {
      toast.success(`${variables.name} uninstalled`)
    },
    onError: (error) => {
      toast.error("Uninstall failed", { description: error.message })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  const handleAddClick = useCallback(() => {
    setDialogOpen(true)
  }, [])

  const handleCreateAgent = useCallback(
    (agent: AgentRegistration) => {
      setRegisteredAgents((current) => [...current, agent])
      toast.success(`${agent.name} registered`)
    },
    [setRegisteredAgents],
  )

  const deleteProfileMutation = trpc.ergatai.deleteProfile.useMutation({
    onSuccess: () => {
      toast.success(`Profile deleted from backend`)
    },
    onError: (error) => {
      toast.error("Failed to delete from backend", { description: error.message })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  const handleDeleteRegistration = useCallback(
    async (agent: AgentRegistration) => {
      try {
        // Delete from backend first using the stable ID
        await deleteProfileMutation.mutateAsync({ id: agent.id })

        // Then update local state
        setRegisteredAgents((current) =>
          current.filter((registration) => registration.id !== agent.id),
        )
        toast.success(`${agent.name} registration removed`)
      } catch (error) {
        // Backend deletion failed — keep local state in sync with backend and surface the error
        toast.error(`Failed to delete ${agent.name}`, {
          description: "The registration was not removed. Please try again.",
        })
      }
    },
    [setRegisteredAgents, deleteProfileMutation],
  )

  return (
    <>
      <div className={cn("space-y-6", className)}>
        <section className="overflow-hidden rounded-2xl border bg-card/70 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background/60 px-5 py-4">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                Registered agents
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Create agents with the form, then mention them in chats.
              </p>
            </div>
            <Badge variant="secondary" className="text-xs">
              {registeredAgents.length} registered
            </Badge>
          </div>

          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
            {registeredAgents.map((agent) => {
              const RuntimeIcon = getCoreAgentIcon(agent.runtimeId)

              return (
                <article
                  key={agent.id}
                  className="flex min-h-[132px] flex-col justify-between rounded-xl border bg-background p-3 transition-[border-color,box-shadow] duration-150 hover:border-border hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 text-foreground">
                      {agent.avatarUrl && /^https?:\/\//i.test(agent.avatarUrl) ? (
                        <img
                          src={agent.avatarUrl}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <RuntimeIcon className="h-5 w-5" />
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className="text-[10px] font-medium">
                        {agent.runtimeId}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={() => handleDeleteRegistration(agent)}
                        title="Delete registration only; the runtime binary remains installed"
                        aria-label={`Delete registration for ${agent.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {agent.startupCommand}
                    </p>
                  </div>
                </article>
              )
            })}

            <button
              type="button"
              onClick={handleAddClick}
              className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-background/60 px-3 py-4 text-muted-foreground transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-primary/40 hover:bg-accent/40 hover:text-foreground hover:shadow-sm"
              aria-label="Add Agent"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed">
                <Plus className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium">New agent</span>
            </button>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border bg-card/70 shadow-sm">
          <div className="border-b bg-background/60 px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">
              Available agents
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Install or uninstall agent runtime binaries via the backend.
            </p>
          </div>

          <div className="space-y-3 p-5">
            {profilesQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="ml-2 text-sm text-muted-foreground">
                  Loading agents...
                </span>
              </div>
            ) : (
              profiles.map((profile: AgentProfileWithStatus) => {
                const Icon = getCoreAgentIcon(profile.name as CoreAgentId)
                const isInstalled = profile.installed
                const isInstalling =
                  installMutation.isPending &&
                  installMutation.variables?.name === profile.name
                const isUninstalling =
                  uninstallMutation.isPending &&
                  uninstallMutation.variables?.name === profile.name
                const canInstall = profile.package_name !== null

                return (
                  <div
                    key={profile.name}
                    className="flex flex-col gap-3 rounded-xl border bg-background p-3 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-muted/40 text-foreground">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {profile.name}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                          {profile.command}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      {isInstalled && (
                        <Badge variant="default" className="text-[10px]">
                          Installed
                        </Badge>
                      )}
                      <Button
                        variant={isInstalled ? "destructive" : "default"}
                        size="sm"
                        disabled={
                          !canInstall || isInstalling || isUninstalling
                        }
                        onClick={() => {
                          if (isInstalled) {
                            uninstallMutation.mutate({ name: profile.name })
                          } else {
                            installMutation.mutate({ name: profile.name })
                          }
                        }}
                        title={
                          !canInstall
                            ? "This agent does not have an npm package for installation"
                            : undefined
                        }
                      >
                        {isInstalling || isUninstalling ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : isInstalled ? (
                          <Trash2 className="h-3.5 w-3.5" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {(() => {
                          if (isInstalling) return "Installing"
                          if (isUninstalling) return "Uninstalling"
                          return isInstalled ? "Uninstall" : "Install"
                        })()}
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>
      </div>

      <AddAgentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreateAgent={handleCreateAgent}
      />
    </>
  )
}
