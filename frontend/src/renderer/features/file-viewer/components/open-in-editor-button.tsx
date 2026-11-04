import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Kbd } from "@/components/ui/kbd"

export function OpenInEditorButton({
  onClick,
  label,
  iconSrc,
  hotkey,
}: {
  onClick: () => void
  label: string
  iconSrc?: string | null
  hotkey?: string | null
}) {
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer rounded-md px-1.5 py-1 hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <span className="hidden @[400px]:inline">Open in</span>
          {iconSrc && (
            <img
              src={iconSrc}
              alt=""
              className="h-3.5 w-3.5 flex-shrink-0"
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" showArrow={false}>
        Open in {label}
        {hotkey && <Kbd className="normal-case font-sans">{hotkey}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
