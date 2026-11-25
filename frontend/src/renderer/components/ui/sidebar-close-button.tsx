import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { IconDoubleChevronRight } from "@/components/ui/icons"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface SidebarCloseButtonProps {
  onClick: () => void
  tooltipLabel: string
  ariaLabel: string
  hotkey?: string | null
  className?: string
}

export function SidebarCloseButton({
  onClick,
  tooltipLabel,
  ariaLabel,
  hotkey,
  className,
}: SidebarCloseButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClick}
          className={className}
          aria-label={ariaLabel}
        >
          <IconDoubleChevronRight className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {tooltipLabel}
        {hotkey && <Kbd>{hotkey}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}