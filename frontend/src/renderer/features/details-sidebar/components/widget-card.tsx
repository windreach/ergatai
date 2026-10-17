import {
  ArrowUpRight,
  TerminalSquare,
  Box,
  ListTodo,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  PlanIcon,
  DiffIcon,
  OriginalMCPIcon,
} from "@/components/ui/icons"
import { cn } from "@/lib/utils"
import { WIDGET_REGISTRY, type WidgetId } from "../atoms"

function getWidgetIcon(widgetId: WidgetId) {
  switch (widgetId) {
    case "agents":
      return Users
    case "info":
      return Box
    case "todo":
      return ListTodo
    case "plan":
      return PlanIcon
    case "terminal":
      return TerminalSquare
    case "diff":
      return DiffIcon
    case "mcp":
      return OriginalMCPIcon
    default:
      return Box
  }
}

export function WidgetCard({
  widgetId,
  title,
  badge,
  children,
  customHeader,
  headerBg,
  hideExpand,
  onExpand,
}: {
  widgetId: WidgetId
  title: string
  badge?: React.ReactNode
  children: React.ReactNode
  customHeader?: React.ReactNode
  headerBg?: string
  hideExpand?: boolean
  onExpand?: () => void
}) {
  const Icon = getWidgetIcon(widgetId)
  const config = WIDGET_REGISTRY.find((w) => w.id === widgetId)
  const canExpand = (config?.canExpand ?? false) && !hideExpand && !!onExpand

  return (
    <div className="mx-2 mb-2">
      <div className="rounded-lg border border-border/50 overflow-hidden">
        <div
          className={cn(
            "flex items-center gap-2 px-2 h-8 select-none group",
            !headerBg && "bg-muted/30",
          )}
          style={headerBg ? { backgroundColor: headerBg } : undefined}
        >
          {customHeader ? (
            <div className="flex-1 min-w-0 flex items-center gap-1">
              {customHeader}
            </div>
          ) : (
            <>
              <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <span className="text-xs font-medium text-foreground flex-1">
                {title}
              </span>
              {badge}
            </>
          )}
          {canExpand && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onExpand}
                  className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md opacity-0 group-hover:opacity-100 transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.97] flex-shrink-0"
                  aria-label={`Expand ${widgetId}`}
                >
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Expand to sidebar</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div>{children}</div>
      </div>
    </div>
  )
}
