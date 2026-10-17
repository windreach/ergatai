"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Shield } from "lucide-react"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
} from "../../../components/ui/alert-dialog"
import { Button } from "../../../components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../../components/ui/popover"
import { IconChevronDown, CheckIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { trpc } from "../../../lib/trpc"

type PermissionMode = "ask" | "auto" | "full_access"

const modeOptions: Array<{
  id: PermissionMode
  label: string
  description: string
  danger?: boolean
}> = [
  { id: "ask", label: "Ask", description: "Ask before risky operations" },
  { id: "auto", label: "Auto", description: "Auto-approve operations" },
  {
    id: "full_access",
    label: "Full Access",
    description: "这个可以完全访问电脑",
    danger: true,
  },
]

export function PermissionModeSelector({
  disabled,
}: {
  disabled?: boolean
}) {
  const [optimisticMode, setOptimisticMode] = useState<PermissionMode | null>(
    null,
  )
  const [open, setOpen] = useState(false)
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false)
  const queryClient = useQueryClient()
  const modeQuery = trpc.ergatai.getPermissionMode.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  })
  const setModeMutation = trpc.ergatai.setPermissionMode.useMutation({
    onError: () => setOptimisticMode(null),
    onSuccess: () => {
      setOptimisticMode(null)
      queryClient.invalidateQueries({
        queryKey: [["ergatai", "getPermissionMode"]],
      })
    },
  })

  const modeResponse = modeQuery.data as { mode?: PermissionMode } | undefined
  const serverMode = modeResponse?.mode
  const mode =
    optimisticMode ??
    (modeOptions.some((option) => option.id === serverMode)
      ? serverMode
      : "ask")
  const selected = modeOptions.find((option) => option.id === mode) ?? modeOptions[0]
  const isFullAccess = selected.id === "full_access"

  const handleSelect = (next: PermissionMode) => {
    if (next === "full_access" && mode !== "full_access") {
      setOpen(false)
      setConfirmingFullAccess(true)
      return
    }
    setOptimisticMode(next)
    setOpen(false)
    setModeMutation.mutate({ mode: next })
  }

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring/70 transition-[background-color,color] duration-150 ease-out hover:bg-muted/50",
            isFullAccess
              ? "text-red-500 hover:text-red-500"
              : "text-muted-foreground hover:text-foreground",
            disabled && "opacity-50 pointer-events-none",
          )}
          disabled={disabled}
        >
          <Shield className="w-4 h-4" />
          <span>{selected.label}</span>
          <IconChevronDown className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        {modeOptions.map((option) => {
          const isSelected = option.id === mode
          const optionDanger = option.id === "full_access"
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleSelect(option.id)}
              className={cn(
                "w-full flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/50 transition-colors",
                isSelected && "bg-muted/70",
              )}
            >
              <div className="flex-1 min-w-0">
                <div
                  className={cn(
                    "text-sm font-medium",
                    optionDanger && "text-red-500",
                  )}
                >
                  {option.label}
                </div>
                <div
                  className={cn(
                    "text-xs text-muted-foreground",
                    optionDanger && "text-red-400",
                  )}
                >
                  {option.description}
                </div>
              </div>
              {isSelected && (
                <CheckIcon className="w-4 h-4 mt-0.5 shrink-0" />
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
    <AlertDialog
      open={confirmingFullAccess}
      onOpenChange={setConfirmingFullAccess}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-red-500">
            Enable Full Access?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Full Access 会自动批准所有操作并绕过文件锁检查——
            <span className="text-red-500 font-medium">这个模式可以完全访问电脑</span>
            。确定要开启吗？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody />
        <AlertDialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingFullAccess(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-red-500 hover:bg-red-600 text-white"
            onClick={() => {
              setOptimisticMode("full_access")
              setModeMutation.mutate({ mode: "full_access" })
              setConfirmingFullAccess(false)
            }}
          >
            Enable Full Access
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
