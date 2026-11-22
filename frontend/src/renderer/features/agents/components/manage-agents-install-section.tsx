import i18n from "@/lib/i18n"
"use client"

import { Download, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { trpc } from "@/lib/trpc"
import {
  type AgentProfileWithStatus,
  getCoreAgentDisplayName,
} from "../lib/agent-contract-api"
import { AgentAvatar } from "./agent-avatar"

interface ManageAgentsInstallSectionProps {
  profiles: AgentProfileWithStatus[]
  isLoading: boolean
}

export function ManageAgentsInstallSection({
  profiles,
  isLoading,
}: ManageAgentsInstallSectionProps) {
  const utils = trpc.useUtils()

  const installMutation = trpc.ergatai.installAgent.useMutation({
    onSuccess: (_, variables) => {
      toast.success(i18n.t("{{name}} installed", { name: variables.name }))
    },
    onError: (error) => {
      toast.error(i18n.t("Install failed"), { description: error.message })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  const uninstallMutation = trpc.ergatai.uninstallAgent.useMutation({
    onSuccess: (_, variables) => {
      toast.success(i18n.t("{{name}} uninstalled", { name: variables.name }))
    },
    onError: (error) => {
      toast.error(i18n.t("Uninstall failed"), { description: error.message })
    },
    onSettled: () => {
      void utils.ergatai.listProfilesWithStatus.invalidate()
    },
  })

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          {i18n.t("Agent runtimes")}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {i18n.t(
            "Install or uninstall agent runtime binaries via the backend. Installed agents become available in chats.",
          )}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            {i18n.t("Loading agents...")}
          </span>
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <Download className="mx-auto h-6 w-6 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium text-foreground">
            {i18n.t("No agent runtimes found")}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {i18n.t("The backend did not report any installable agents.")}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile) => {
            const isInstalled = profile.installed
            const isInstalling =
              installMutation.isPending &&
              installMutation.variables?.name === profile.name
            const isUninstalling =
              uninstallMutation.isPending &&
              uninstallMutation.variables?.name === profile.name
            const canInstall = profile.package_name !== null
            const displayName =
              getCoreAgentDisplayName(profile.name) ?? profile.name

            return (
              <div
                key={profile.name}
                className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/10 p-4 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <AgentAvatar
                    runtimeId={profile.name}
                    avatarUrl={profile.avatar_url}
                  />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {displayName}
                      </p>
                      {isInstalled && (
                        <Badge variant="default" className="text-[10px]">
                          {i18n.t("Installed")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {profile.command}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {profile.package_name
                        ? i18n.t("Package: {{name}}", {
                            name: profile.package_name,
                          })
                        : i18n.t("No install package")}
                    </p>
                  </div>
                </div>

                <Button
                  type="button"
                  variant={isInstalled ? "destructive" : "default"}
                  size="sm"
                  className="shrink-0"
                  disabled={!canInstall || isInstalling || isUninstalling}
                  onClick={() => {
                    if (isInstalled) {
                      uninstallMutation.mutate({ name: profile.name })
                    } else {
                      installMutation.mutate({ name: profile.name })
                    }
                  }}
                  title={
                    !canInstall
                      ? i18n.t(
                          "This agent does not have an npm package for installation",
                        )
                      : undefined
                  }
                >
                  {isInstalling || isUninstalling ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : isInstalled ? (
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                  ) : (
                    <Download className="mr-1 h-3.5 w-3.5" />
                  )}
                  {(() => {
                    if (isInstalling) return i18n.t("Installing")
                    if (isUninstalling) return i18n.t("Uninstalling")
                    return isInstalled ? i18n.t("Uninstall") : i18n.t("Install")
                  })()}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
