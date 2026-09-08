import { useState, useRef, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, ChevronDown, CircleDot } from "lucide-react";
import { cn } from "../../lib/utils";
import type { AgentSummary } from "@ergatai/platform-core";

interface ChatHeaderProps {
  leading?: ReactNode;
  branch?: string | null;
  branches?: string[];
  onBranchChange?: (branch: string) => void;
  agents?: AgentSummary[];
  selectedAgentId?: string | null;
  onAgentSelect?: (agentId: string) => void;
  onNewAgent?: () => void;
}

export function ChatHeader({
  leading,
  branch,
  branches = [],
  onBranchChange,
  agents = [],
  selectedAgentId,
  onAgentSelect,
  onNewAgent,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const [branchOpen, setBranchOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const branchRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) setBranchOpen(false);
      if (agentRef.current && !agentRef.current.contains(e.target as Node)) setAgentOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);

  const stateColor = (state: string) => {
    if (state === "running" || state === "processing") return "text-success";
    if (state === "idle") return "text-muted";
    return "text-faint";
  };

  return (
    <header className="flex h-10 flex-shrink-0 items-center border-b border-border-subtle bg-surface px-3">
      <div className="flex w-14 items-center">{leading}</div>

      <div className="flex flex-1 items-center justify-center">
        {branch != null && (
          <div className="relative" ref={branchRef}>
            <button
              type="button"
              onClick={() => setBranchOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-text"
            >
              <GitBranch className="h-3.5 w-3.5" />
              <span>{branch}</span>
              {branches.length > 1 && <ChevronDown className="h-3 w-3 opacity-60" />}
            </button>
            {branchOpen && branches.length > 0 && (
              <div className="absolute left-1/2 top-full z-40 mt-1 w-44 -translate-x-1/2 rounded-lg border border-border bg-surface py-1 shadow-lg animate-fade-in">
                {branches.map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => { onBranchChange?.(b); setBranchOpen(false); }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition-colors",
                      b === branch ? "text-accent font-medium" : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    <GitBranch className="h-3 w-3 shrink-0" />
                    <span className="truncate">{b}</span>
                    {b === branch && <CircleDot className="ml-auto h-3 w-3 text-accent" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex w-14 items-center justify-end">
        <div className="relative" ref={agentRef}>
          <button
            type="button"
            onClick={() => setAgentOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-text"
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", selectedAgent ? stateColor(selectedAgent.state) : "bg-faint")} />
            <span className="max-w-24 truncate">{selectedAgent?.name ?? t("chat.selectAgent")}</span>
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
          {agentOpen && (
            <div className="absolute right-0 top-full z-40 mt-1 w-52 rounded-lg border border-border bg-surface py-1 shadow-lg animate-fade-in">
              {agents.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-faint">{t("chat.noAgents")}</p>
              ) : (
                agents.map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => { onAgentSelect?.(agent.id); setAgentOpen(false); }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-[12px] transition-colors",
                      agent.id === selectedAgentId ? "bg-hover text-text" : "text-muted hover:bg-hover hover:text-text",
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stateColor(agent.state))} />
                    <span className="flex-1 truncate text-left">{agent.name}</span>
                    <span className="shrink-0 text-[10px] text-faint">{agent.state}</span>
                  </button>
                ))
              )}
              {onNewAgent && (
                <>
                  <div className="my-1 border-t border-border-subtle" />
                  <button
                    type="button"
                    onClick={() => { onNewAgent(); setAgentOpen(false); }}
                    className="flex w-full items-center px-3 py-1.5 text-[12px] text-accent transition-colors hover:bg-hover"
                  >
                    + {t("chat.newAgent")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
