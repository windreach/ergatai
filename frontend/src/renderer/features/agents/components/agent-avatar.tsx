import { useCachedRemoteImage } from "@/lib/hooks/use-cached-remote-image"
import { cn } from "@/lib/utils"
import type { CoreAgentId } from "../lib/agent-contract-api"
import { CORE_AGENT_LOGO_URLS } from "../lib/agent-logo-urls"
import { getCoreAgentIcon } from "./core-agent-selector"

interface AgentAvatarProps {
  runtimeId: CoreAgentId
  avatarUrl?: string | null
  className?: string
  iconClassName?: string
}

/** Rounded avatar for an agent profile, preferring the profile's saved icon. */
export function AgentAvatar({
  runtimeId,
  avatarUrl,
  className,
  iconClassName,
}: AgentAvatarProps) {
  const logoUrl =
    avatarUrl ||
    CORE_AGENT_LOGO_URLS[runtimeId as keyof typeof CORE_AGENT_LOGO_URLS]
  const cachedSrc = useCachedRemoteImage(logoUrl)
  const RuntimeIcon = getCoreAgentIcon(runtimeId)

  return (
    <div
      className={cn(
        "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/40 text-foreground",
        className,
      )}
    >
      {cachedSrc ? (
        <img
          src={cachedSrc}
          alt=""
          className="h-full w-full object-cover"
          width={40}
          height={40}
        />
      ) : (
        <RuntimeIcon className={cn("h-5 w-5", iconClassName)} />
      )}
    </div>
  )
}
