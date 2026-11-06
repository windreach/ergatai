"use client"

import { useCallback, useEffect, useState } from "react"
import {
  Check as CheckIcon,
  ChevronDown,
  CircleAlert,
  Upload,
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  CORE_AGENT_OPTIONS,
  type CoreAgentId,
  type CoreAgentOption,
  type AgentRegistration,
} from "../lib/agent-contract-api"
import { agentContractApi } from "../lib/agent-contract-api"
import { getCoreAgentIcon } from "./core-agent-selector"

interface AddAgentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateAgent: (agent: AgentRegistration) => void
}

// react-doctor-disable-next-line no-giant-component
export function AddAgentDialog({
  open,
  onOpenChange,
  onCreateAgent,
}: AddAgentDialogProps) {
  const [agentName, setAgentName] = useState("")
  const [avatarUrl, setAvatarUrl] = useState("")
  const [startupCommand, setStartupCommand] = useState("") // 用于显示的简化命令
  // react-doctor-disable-next-line rerender-state-only-in-handlers
  const [fullCommand, setFullCommand] = useState("") // 用于提交的完整命令
  const [startupError, setStartupError] = useState(false)
  const [autoFillCommand, setAutoFillCommand] = useState(true)
  const [selectedAgentId, setSelectedAgentId] =
    useState<CoreAgentId>("claude-code")
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [agentOptions, setAgentOptions] = useState<CoreAgentOption[]>(CORE_AGENT_OPTIONS)

  // Fetch agent options from backend when dialog opens
  useEffect(() => {
    if (!open) return
    agentContractApi
      .listCoreAgents()
      .then((options) => {
        if (options.length > 0) setAgentOptions(options)
      })
      .catch(() => {
        // Fallback to static list already set as default
      })
  }, [open])

  useEffect(() => {
    if (!open) return

    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setAgentName("")
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setAvatarUrl("")
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setStartupError(false)
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setAutoFillCommand(true)
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setSelectedAgentId("claude-code")
    // react-doctor-disable-next-line no-adjust-state-on-prop-change
    setPopoverOpen(false)
  }, [open])

  // react-doctor-disable-next-line no-effect-chain
  useEffect(() => {
    if (!open || !autoFillCommand) return

    const command = agentOptions.find((agent) => agent.id === selectedAgentId)?.defaultCommand ?? ""
    setFullCommand(command)
    // 只显示命令的文件名部分，避免完整路径撑坏 UI
    const displayCommand = command ? (command.includes("/") ? command.split("/").pop() || command : command) : ""
    setStartupCommand(displayCommand)
  }, [autoFillCommand, open, selectedAgentId, agentOptions])

  const selectedAgent =
    agentOptions.find((agent) => agent.id === selectedAgentId) ??
    agentOptions[0] ??
    CORE_AGENT_OPTIONS[0]
  const SelectedIcon = getCoreAgentIcon(selectedAgentId)
  const previewName = agentName.trim() || selectedAgent.name

  const handleAvatarChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]

      if (!file) return

      if (file.size > 2 * 1024 * 1024) {
        toast.error("Agent icons must be smaller than 2MB")
        return
      }

      const reader = new FileReader()

      reader.onload = () => {
        if (typeof reader.result === "string") {
          setAvatarUrl(reader.result)
        }
      }
      reader.onerror = () => {
        toast.error("Failed to read the selected image")
      }
      reader.readAsDataURL(file)
      event.target.value = ""
    },
    [],
  )

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      // 使用 fullCommand 进行验证和提交
      const commandToSubmit = fullCommand.trim() || startupCommand.trim()
      if (!commandToSubmit) {
        setStartupError(true)
        return
      }

      const name = agentName.trim() || selectedAgent.name

      try {
        // The backend owns persistent profile IDs; the UI only keeps a local view.
        const registered = await agentContractApi.registerAgent(
          name,
          commandToSubmit,
          "acp",
          undefined,
          avatarUrl || undefined,
        )

        const newAgent: AgentRegistration = {
          id: registered.id,
          name,
          runtimeId: selectedAgent.id,
          startupCommand: commandToSubmit,
          avatarUrl: avatarUrl || undefined,
        }

        onCreateAgent(newAgent)
        onOpenChange(false)
      } catch (err) {
        console.error("Failed to register agent to backend:", err)
        toast.error("Agent registration failed", {
          description: err instanceof Error ? err.message : "Please try again",
        })
      }
    },
    [onCreateAgent, onOpenChange, selectedAgent, fullCommand, startupCommand, agentName, avatarUrl],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[440px] gap-5 rounded-2xl p-5 sm:max-w-[440px]">
        <DialogHeader className="space-y-1.5">
          <DialogTitle className="text-base font-semibold">
            Add a custom agent
          </DialogTitle>
          <DialogDescription className="text-xs leading-5 text-muted-foreground">
            Name it, choose the runtime, and provide the command used to start
            it.
          </DialogDescription>
        </DialogHeader>

        <form id="create-agent-form" onSubmit={handleSubmit} className="space-y-5">
          <div className="flex items-start gap-4">
            <label
              className="relative flex h-16 w-16 flex-shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-dashed bg-muted/30 text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent/40 hover:text-foreground"
              title="Accepts PNG, JPG, WebP or SVG up to 2MB"
              aria-label="Upload agent avatar"
            >
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="sr-only"
                onChange={handleAvatarChange}
              />
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  width={40}
                  height={40}
                />
              ) : (
                <span className="flex flex-col items-center gap-1">
                  <Upload className="h-4 w-4" />
                  <span className="text-[10px] leading-none">Image</span>
                </span>
              )}
            </label>

            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="agent-name"
                  className="text-sm font-medium text-foreground"
                >
                  Agent name
                </label>
                <Badge variant="secondary" className="text-[10px]">
                  Optional
                </Badge>
              </div>
              <Input
                id="agent-name"
                placeholder={selectedAgent.name}
                value={agentName}
                onChange={(event) => setAgentName(event.target.value)}
                maxLength={40}
              />
              <p className="text-xs text-muted-foreground">
                Defaults to the runtime name when left empty.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="startup-command"
                className="text-sm font-medium text-foreground"
              >
                Startup command
              </label>
              <Badge variant="secondary" className="text-[10px]">
                Required
              </Badge>
            </div>
            <Input
              id="startup-command"
              placeholder="Enter the executable command"
              value={startupCommand}
              onChange={(event) => {
                const value = event.target.value
                setStartupCommand(value)
                // 如果用户手动编辑，同时更新完整命令
                if (!autoFillCommand) {
                  setFullCommand(value)
                }
                setAutoFillCommand(false)
                setStartupError(false)
              }}
              className={cn(
                "font-mono text-[13px]",
                startupError && "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/20",
              )}
              aria-invalid={startupError}
            />
            {startupError ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <CircleAlert className="h-3 w-3" />
                A startup command is required.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The command is pre-filled and changes as you switch runtimes.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">
                Agent runtime
              </span>
              <Badge variant="secondary" className="text-[10px]">
                Required
              </Badge>
            </div>
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex h-9 w-full items-center justify-between rounded-lg border border-input bg-background px-3 text-sm transition-shadow hover:bg-accent/50 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <SelectedIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate">{selectedAgent.name}</span>
                  </span>
                  <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 p-1">
                {agentOptions.map((agent) => {
                  const Icon = getCoreAgentIcon(agent.id)
                  const defaultCommand = agent.defaultCommand ?? ""
                  const isSelected = agent.id === selectedAgentId

                  return (
                    <button
                      key={agent.id}
                      type="button"
                      onClick={() => {
                        setSelectedAgentId(agent.id)
                        setPopoverOpen(false)
                      }}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/50",
                        isSelected && "bg-accent/30",
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {agent.name}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground" title={defaultCommand}>
                          {defaultCommand.includes("/") ? defaultCommand.split("/").pop() : defaultCommand}
                        </span>
                      </span>
                      {isSelected && (
                        <CheckIcon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                      )}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          </div>

          <div className="rounded-xl border bg-muted/25 p-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border bg-background text-foreground">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="h-full w-full object-cover" width={36} height={36} />
                ) : (
                  <SelectedIcon className="h-4 w-4" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{previewName}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {startupCommand || "No startup command"}
                </p>
              </div>
              <Badge variant="secondary" className="flex-shrink-0 text-[10px]">
                Preview
              </Badge>
            </div>
          </div>
        </form>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="create-agent-form"
          >
            Create agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
