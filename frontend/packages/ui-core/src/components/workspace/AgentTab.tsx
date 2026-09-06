import type { DragEvent, KeyboardEvent } from "react";

export type AgentTabStatus = "active" | "background" | "hibernated";

export interface AgentTabItem {
  id: string;
  name: string;
  status: AgentTabStatus;
}

export type AgentTabData = AgentTabItem;

interface AgentTabProps {
  tab: AgentTabItem;
  isActive: boolean;
  groupColor?: string;
  closeLabel: string;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  dropSide?: "before" | "after" | null;
  onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

export function AgentTab({
  tab,
  isActive,
  groupColor,
  closeLabel,
  onSelect,
  onClose,
  onDragStart,
  dropSide,
  onDragOver,
  onDrop,
}: AgentTabProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }

  return (
    <div
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      draggable
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.setData("text/ergatai-agent-tab", tab.id);
        event.dataTransfer.setData("text/plain", tab.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      className={`agent-tab group relative flex items-center h-[34px] px-2.5 mr-1 min-w-[150px] max-w-[220px]
        rounded-lg border border-transparent cursor-pointer transition-all duration-150 select-none text-[13px] font-sans
        ${isActive
          ? "bg-white text-[#1C1B1F] shadow-[0_1px_3px_rgba(0,0,0,0.12)]"
          : "bg-transparent text-[#3D3D3D] hover:bg-[#E0E0E0]"
        }
      `}
    >
      {dropSide && (
        <span
          aria-hidden="true"
          className={`absolute inset-y-1 z-10 w-0.5 rounded-full bg-[#3D3D3D] ${
            dropSide === "before" ? "left-0" : "right-0"
          }`}
        />
      )}

      <span
        aria-hidden="true"
        className={`relative mr-2.5 h-3 w-3 flex-shrink-0 rounded-full ${
          groupColor ? "" : "bg-transparent"
        }`}
        style={groupColor ? { backgroundColor: groupColor } : undefined}
      />

      <span className="min-w-0 flex-1 truncate tracking-tight">
        {tab.name}
      </span>

      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="ml-2 grid h-6 w-6 shrink-0 place-items-center rounded-md p-0 text-[#3D3D3D]/70 transition-colors hover:bg-black/5 hover:text-[#1C1B1F] group-hover:text-[#1C1B1F]"
      >
        <svg
          className="h-3.5 w-3.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
