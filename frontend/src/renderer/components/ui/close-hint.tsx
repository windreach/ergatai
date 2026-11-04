import { Kbd } from "@/components/ui/kbd"

export function CloseHint({ closeHotkey }: { closeHotkey?: string }) {
  return (
    <div className="flex items-center gap-1 text-xs">
      <span>Close</span>
      <span className="text-muted-foreground inline-flex items-center gap-1">
        <span>Click</span>
        {closeHotkey && (
          <>
            <span>or</span>
            <Kbd>{closeHotkey}</Kbd>
          </>
        )}
      </span>
    </div>
  )
}
