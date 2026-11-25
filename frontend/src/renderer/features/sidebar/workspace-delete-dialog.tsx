import i18n from "@/lib/i18n"
import type { ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog"

type WorkspaceDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  activeAgents: number
  isPending: boolean
  onConfirm: () => void
}

/**
 * Shared confirmation dialog for deleting a workspace.
 *
 * Used by both active and archived workspace rows so the destructive-action
 * copy, active-agent warning, and pending behavior stay consistent.
 */
export function WorkspaceDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  activeAgents,
  isPending,
  onConfirm,
}: WorkspaceDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {activeAgents > 0 && (
          <div className="mx-5 mb-4 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-foreground">
            <p className="font-medium">Warning: {activeAgents} active agent(s) will be stopped</p>
            <p className="mt-1 text-muted-foreground">
              Deleting this workspace will automatically stop all running agents. Any unsaved progress will be lost.
            </p>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{i18n.t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
