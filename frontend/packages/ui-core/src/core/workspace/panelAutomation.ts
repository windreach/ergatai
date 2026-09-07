import { useCallback } from "react";
import { create } from "zustand";

// 定义面板类型
export type PanelType = "chat" | "terminal" | "files" | "review" | "placeholder";

// 定义触发事件类型
export type TriggerEvent =
  | { type: "task-selected"; taskId: string }
  | { type: "review-needed"; reviewId: string }
  | { type: "message_sent"; conversationId: string }
  | { type: "terminal_command"; command: string }
  | { type: "file_changed"; filePath: string };

// 面板状态管理
interface PanelAutomationState {
  activePanel: PanelType;
  openPanels: PanelType[];

  // 动作
  setActivePanel: (panel: PanelType) => void;
  openPanel: (panel: PanelType) => void;
  closePanel: (panel: PanelType) => void;

  // 自动触发
  handleTriggerEvent: (event: TriggerEvent) => void;
}

// 事件到面板的映射规则
const EVENT_PANEL_MAP: Record<TriggerEvent["type"], PanelType> = {
  "task-selected": "files",
  "review-needed": "review",
  "message_sent": "chat",
  "terminal_command": "terminal",
  "file_changed": "files",
};

export const usePanelAutomation = create<PanelAutomationState>((set, get) => ({
  activePanel: "chat",
  openPanels: ["chat"],

  setActivePanel: (panel) => set({ activePanel: panel }),

  openPanel: (panel) =>
    set((state) => ({
      activePanel: panel,
      openPanels: state.openPanels.includes(panel)
        ? state.openPanels
        : [...state.openPanels, panel],
    })),

  closePanel: (panel) =>
    set((state) => {
      const newOpenPanels = state.openPanels.filter((p) => p !== panel);
      return {
        openPanels: newOpenPanels,
        activePanel:
          state.activePanel === panel
            ? newOpenPanels[0] || "chat"
            : state.activePanel,
      };
    }),

  handleTriggerEvent: (event) => {
    const targetPanel = EVENT_PANEL_MAP[event.type];
    if (targetPanel) {
      get().openPanel(targetPanel);
    }
  },
}));

// Hook：在主区域组件中使用，自动触发面板
export function usePanelTrigger() {
  const handleTriggerEvent = usePanelAutomation(
    (state) => state.handleTriggerEvent
  );

  const triggerTaskSelected = useCallback(
    (taskId: string) => {
      handleTriggerEvent({ type: "task-selected", taskId });
    },
    [handleTriggerEvent]
  );

  const triggerReviewNeeded = useCallback(
    (reviewId: string) => {
      handleTriggerEvent({ type: "review-needed", reviewId });
    },
    [handleTriggerEvent]
  );

  const triggerMessageSent = useCallback(
    (conversationId: string) => {
      handleTriggerEvent({ type: "message_sent", conversationId });
    },
    [handleTriggerEvent]
  );

  const triggerTerminalCommand = useCallback(
    (command: string) => {
      handleTriggerEvent({ type: "terminal_command", command });
    },
    [handleTriggerEvent]
  );

  const triggerFileChanged = useCallback(
    (filePath: string) => {
      handleTriggerEvent({ type: "file_changed", filePath });
    },
    [handleTriggerEvent]
  );

  return {
    triggerTaskSelected,
    triggerReviewNeeded,
    triggerMessageSent,
    triggerTerminalCommand,
    triggerFileChanged,
  };
}
