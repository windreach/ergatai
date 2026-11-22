import i18n from "@/lib/i18n"
"use client"

import { useEffect, useMemo, useState } from "react"
import { useAtom } from "jotai"
import { Bot, Download, KeyRound, type LucideIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import {
  getAgentProfileName,
  getCoreAgentDisplayName,
  isSupportedCoreAgentProfile,
  resolveRuntimeAgentIdFromCommand,
  type AgentProfileWithStatus,
} from "../lib/agent-contract-api"
import {
  desktopViewAtom,
  manageAgentsSectionAtom,
  registeredAgentsAtom,
  type ManageAgentsSection,
} from "../atoms"
import {
  ManageAgentsProviderSection,
  type ManageAgentsProviderTarget,
} from "./manage-agents-provider-section"
import { ManageAgentsAgentSection } from "./manage-agents-agent-section"
import { ManageAgentsInstallSection } from "./manage-agents-install-section"

interface ManageAgentsNavItem {
  id: ManageAgentsSection
  label: string
  icon: LucideIcon
}

// Section labels stay in English by design, matching the rest of the
// Manage Agents surface.
const MANAGE_AGENTS_NAV_ITEMS: ManageAgentsNavItem[] = [
  { id: "providers", label: "Provider", icon: KeyRound },
  { id: "agents", label: "Agent", icon: Bot },
  { id: "install", label: "Install Agent", icon: Download },
]

/**
 * Floating Manage Agents panel.
 *
 * Provider connections, registered agents, and runtime installation each live
 * in their own section on the right.
 */
export function AddAgentViewPage() {
  const [desktopView, setDesktopView] = useAtom(desktopViewAtom)
  const [registeredAgents, setRegisteredAgents] = useAtom(registeredAgentsAtom)
  const [activeSection, setActiveSection] = useAtom(manageAgentsSectionAtom)
  const [providerAgentName, setProviderAgentName] = useState<string | null>(
    null,
  )

  const isOpen = desktopView === "add-agent"

  const profilesQuery = trpc.ergatai.listProfilesWithStatus.useQuery(
    undefined,
    { enabled: isOpen },
  )

  const allProfiles = useMemo(
    () => profilesQuery.data?.profiles ?? [],
    [profilesQuery.data],
  )

  // v0.1.0 only markets the supported bundled agents. Custom profiles remain
  // visible so users can still register their own runtimes.
  const profiles = useMemo(
    () =>
      allProfiles.filter((profile: AgentProfileWithStatus) =>
        isSupportedCoreAgentProfile(profile.name),
      ),
    [allProfiles],
  )

  // Auto-register installed profiles into local registered agents (one-time sync)
  useEffect(() => {
    if (!profilesQuery.data) return
    const installed = profilesQuery.data.profiles.filter(
      (profile: AgentProfileWithStatus) =>
        profile.installed && isSupportedCoreAgentProfile(profile.name),
    )
    setRegisteredAgents((current) => {
      // Remove stale manual adapter registrations (node + /adapters/ path)
      // that are superseded by the auto-registered backend profiles.
      const cleaned = current.filter(
        (registration) =>
          !(
            registration.startupCommand.startsWith("node") &&
            registration.startupCommand.includes("/adapters/")
          ),
      )
      const existingIds = new Set(cleaned.map((registration) => registration.id))
      const toAdd = installed
        .filter((profile: AgentProfileWithStatus) => !existingIds.has(profile.id))
        .map((profile: AgentProfileWithStatus) => ({
          id: profile.id, // Use backend's stable ID
          profileName: profile.name,
          // Unified friendly display name ("Claude Code"), not the raw
          // backend profile id ("claude-code"). Backend ids stay untouched.
          name: getCoreAgentDisplayName(profile.name) ?? profile.name,
          runtimeId: profile.name, // backend profile names are a superset of CoreAgentId
          startupCommand: profile.command,
          avatarUrl: profile.avatar_url || undefined, // Sync avatar from backend
        }))

      // Update existing agents with avatar_url and the unified display name
      // from the backend (older registrations may still store raw ids like
      // "claude-code" as their name). Custom profile names are preserved.
      let mutated = false
      const updated = cleaned.map((agent) => {
        const backendProfile = installed.find(
          (profile: AgentProfileWithStatus) => profile.id === agent.id,
        )
        if (!backendProfile) return agent
        const displayName = isSupportedCoreAgentProfile(backendProfile.name)
          ? (getCoreAgentDisplayName(backendProfile.name) ?? agent.name)
          : agent.name
        const needsAvatar =
          Boolean(backendProfile.avatar_url) && !agent.avatarUrl
        const needsRename = displayName !== agent.name
        const needsProfileName = agent.profileName !== backendProfile.name
        if (needsAvatar || needsRename || needsProfileName) {
          mutated = true
          return {
            ...agent,
            profileName: backendProfile.name,
            avatarUrl:
              agent.avatarUrl ?? backendProfile.avatar_url ?? undefined,
            name: displayName,
          }
        }
        return agent
      })

      const merged = [...updated, ...toAdd]
      return mutated ||
        toAdd.length > 0 ||
        merged.length !== current.length
        ? merged
        : current
    })
  }, [profilesQuery.data, setRegisteredAgents])

  const providerTargets = useMemo<ManageAgentsProviderTarget[]>(() => {
    const targets = new Map<string, ManageAgentsProviderTarget>()

    const findFallback = (
      profileName: string,
      command: string | undefined,
    ): AgentProfileWithStatus | undefined => {
      if (!command) return undefined
      const sameCommand = allProfiles.filter(
        (profile) =>
          profile.name !== profileName &&
          profile.command.trim() === command.trim(),
      )
      return (
        sameCommand.find((profile) =>
          isSupportedCoreAgentProfile(profile.name),
        ) ?? sameCommand[0]
      )
    }

    for (const profile of allProfiles) {
      if (!profile.installed) continue
      const fallback = isSupportedCoreAgentProfile(profile.name)
        ? undefined
        : findFallback(profile.name, profile.command)
      targets.set(profile.name, {
        profileName: profile.name,
        runtimeId:
          fallback?.name ??
          resolveRuntimeAgentIdFromCommand(profile.command) ??
          profile.name,
        displayName: getCoreAgentDisplayName(profile.name) ?? profile.name,
        avatarUrl: profile.avatar_url,
        fallbackProfileName: fallback?.name,
        fallbackDisplayName: fallback
          ? (getCoreAgentDisplayName(fallback.name) ?? fallback.name)
          : undefined,
      })
    }

    for (const agent of registeredAgents) {
      const profileName = getAgentProfileName(agent)
      const existing = targets.get(profileName)
      const backendProfile = allProfiles.find(
        (profile) => profile.name === profileName,
      )
      const fallback = existing
        ? undefined
        : findFallback(
            profileName,
            backendProfile?.command ?? agent.startupCommand,
          )

      targets.set(profileName, {
        profileName,
        runtimeId:
          agent.runtimeId ||
          existing?.runtimeId ||
          resolveRuntimeAgentIdFromCommand(backendProfile?.command) ||
          profileName,
        displayName: agent.name || existing?.displayName || profileName,
        avatarUrl: agent.avatarUrl ?? existing?.avatarUrl ?? null,
        fallbackProfileName:
          existing?.fallbackProfileName ?? fallback?.name,
        fallbackDisplayName:
          existing?.fallbackDisplayName ??
          (fallback
            ? (getCoreAgentDisplayName(fallback.name) ?? fallback.name)
            : undefined),
      })
    }

    return [...targets.values()]
  }, [allProfiles, registeredAgents])

  const activeItem =
    MANAGE_AGENTS_NAV_ITEMS.find((item) => item.id === activeSection) ??
    MANAGE_AGENTS_NAV_ITEMS[0]

  const handleManageProviders = (profileName: string) => {
    setProviderAgentName(profileName)
    setActiveSection("providers")
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) setDesktopView(null)
      }}
    >
      <DialogContent
        showCloseButton
        aria-describedby={undefined}
        className="flex h-[min(680px,calc(100vh-3rem))] w-[min(1040px,calc(100vw-3rem))] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-2xl border-border/70 bg-tl-background p-0 shadow-2xl sm:max-w-[calc(100vw-2rem)]"
      >
        {/* Left: section navigation */}
        <aside className="flex w-[232px] shrink-0 flex-col border-r border-border/60 bg-foreground/[0.025] px-3 py-4">
          <DialogTitle asChild>
            <h1 className="px-3 pb-5 pt-1 text-lg font-semibold tracking-tight text-foreground">
              {i18n.t("Manage Agents")}
            </h1>
          </DialogTitle>

          <nav
            className="flex flex-col gap-1"
            aria-label={i18n.t("Manage Agents")}
          >
            {MANAGE_AGENTS_NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive = item.id === activeSection

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors duration-75",
                    "outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70",
                    isActive
                      ? "bg-foreground/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-4 w-4 shrink-0",
                      isActive ? "opacity-100" : "opacity-60",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>

        {/* Right: section content */}
        <section className="relative flex min-w-0 flex-1 flex-col bg-background">
          <header className="flex h-[68px] shrink-0 items-center px-6">
            <h2 className="text-base font-semibold text-foreground">
              {activeItem.label}
            </h2>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin scrollbar-thumb-muted-foreground/20 scrollbar-track-transparent">
            {activeSection === "providers" && (
              <ManageAgentsProviderSection
                targets={providerTargets}
                selectedAgentName={providerAgentName}
                onSelectAgent={setProviderAgentName}
              />
            )}

            {activeSection === "agents" && (
              <ManageAgentsAgentSection
                onManageProviders={handleManageProviders}
              />
            )}

            {activeSection === "install" && (
              <ManageAgentsInstallSection
                profiles={profiles}
                isLoading={profilesQuery.isLoading}
              />
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}
