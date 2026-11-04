import { CollapseIcon, ExpandIcon } from "../../../components/ui/icons"
import { cn } from "../../../lib/utils"
import { ListTree } from "lucide-react"

export function CollapsibleStepsHeader({
  stepsCount,
  isExpanded,
  onToggle,
}: {
  stepsCount: number
  isExpanded: boolean
  onToggle: () => void
}) {
  return (
    <div
      className="flex items-center justify-between rounded-md py-0.5 px-2 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ListTree className="w-3.5 h-3.5 flex-shrink-0" />
        <span className="font-medium whitespace-nowrap">
          {stepsCount} {stepsCount === 1 ? "step" : "steps"}
        </span>
      </div>
      <button
        className="p-1 rounded-md hover:bg-accent transition-[background-color,transform] duration-150 ease-out active:scale-95"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        <div className="relative w-4 h-4">
          <ExpandIcon
            className={cn(
              "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
              isExpanded ? "opacity-0 scale-75" : "opacity-100 scale-100",
            )}
          />
          <CollapseIcon
            className={cn(
              "absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out",
              isExpanded ? "opacity-100 scale-100" : "opacity-0 scale-75",
            )}
          />
        </div>
      </button>
    </div>
  )
}
