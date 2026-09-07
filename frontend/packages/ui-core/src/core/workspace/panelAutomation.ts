import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";

// 面板类型
export type PanelType = "chat" | "terminal" | "files" | "review" | "settings" | "placeholder";

// 自动化策略
export type AutomationStrategy = "auto" | "smart" | "manual";

// 触发事件类型
export type TriggerEvent =
  | { type: "task-selected"; taskId: string }
  | { type: "review-needed"; reviewId: string; filePath?: string }
  | { type: "message_sent"; conversationId: string }
  | { type: "terminal_command"; command: string }
  | { type: "file_changed"; filePath: string }
  | { type: "approval_request"; approvalId: string; filePath: string };

// 通知项
export interface Notification {
  id: string;
  message: string;
  panelType?: PanelType;
  createdAt: number;
  duration: number; // 毫秒
}

// 自动化配置
export interface AutomationConfig {
  strategy: AutomationStrategy;
  enableReviewAutoOpen: boolean;
  enableFilesAutoOpen: boolean;
  enableTerminalAutoOpen: boolean;
  enableChatAutoOpen: boolean;
  showNotificationOnAutoOpen: boolean;
  notificationDuration: number;
}

export interface PanelContext {
  id?: string;
  filePath?: string;
  command?: string;
  conversationId?: string;
  token?: number;
}

// 事件到面板的映射
const EVENT_PANEL_MAP: Record<TriggerEvent["type"], PanelType> = {
  "task-selected": "files",
  "review-needed": "review",
  "message_sent": "chat",
  "terminal_command": "terminal",
  "file_changed": "files",
  "approval_request": "review",
};

// 默认配置
const DEFAULT_CONFIG: AutomationConfig = {
  strategy: "smart",
  enableReviewAutoOpen: true,
  enableFilesAutoOpen: true,
  enableTerminalAutoOpen: true,
  enableChatAutoOpen: true,
  showNotificationOnAutoOpen: true,
  notificationDuration: 3000,
};

// 配置管理
const CONFIG_KEY = "ergatai_automation_config";

function loadConfig(): AutomationConfig {
  try {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
    }
  } catch {
    // ignore
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: AutomationConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

// 面板自动化状态
interface PanelAutomationState {
  activePanel: PanelType;
  openPanels: PanelType[];
  config: AutomationConfig;
  notifications: Notification[];
  notificationTimers: Map<string, ReturnType<typeof setTimeout>>;
  panelContext: Partial<Record<PanelType, PanelContext>>;

  // 基础动作
  setActivePanel: (panel: PanelType) => void;
  openPanel: (panel: PanelType, activate?: boolean) => void;
  closePanel: (panel: PanelType) => void;

  // 配置
  updateConfig: (updates: Partial<AutomationConfig>) => void;
  resetConfig: () => void;

  // 通知
  addNotification: (notification: Omit<Notification, "id" | "createdAt">) => void;
  removeNotification: (id: string) => void;

  // 自动触发（根据策略）
  handleTriggerEvent: (event: TriggerEvent) => void;
}

export const usePanelAutomation = create<PanelAutomationState>((set, get) => ({
  activePanel: "chat",
  openPanels: ["chat"],
  config: loadConfig(),
  notifications: [],
  notificationTimers: new Map(),
  panelContext: {},

  setActivePanel: (panel) => set({ activePanel: panel }),

  openPanel: (panel, activate = true) =>
    set((state) => ({
      activePanel: activate ? panel : state.activePanel,
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

  updateConfig: (updates) =>
    set((state) => {
      const newConfig = { ...state.config, ...updates };
      saveConfig(newConfig);
      return { config: newConfig };
    }),

  resetConfig: () => {
    saveConfig(DEFAULT_CONFIG);
    set({ config: DEFAULT_CONFIG });
  },

  addNotification: (notification) => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    const newNotification: Notification = {
      ...notification,
      id,
      createdAt: Date.now(),
    };
    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));

    // 自动移除，保存 timer 以便清理
    const timer = setTimeout(() => {
      get().removeNotification(id);
    }, notification.duration);
    set((state) => {
      const next = new Map(state.notificationTimers);
      next.set(id, timer);
      return { notificationTimers: next };
    });
  },

  removeNotification: (id) => {
    // 清除 timer 防止泄漏
    const timer = get().notificationTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    set((state) => {
      const next = new Map(state.notificationTimers);
      next.delete(id);
      return {
        notifications: state.notifications.filter((n) => n.id !== id),
        notificationTimers: next,
      };
    });
  },

  handleTriggerEvent: (event) => {
    const state = get();
    const { config } = state;
    const targetPanel = EVENT_PANEL_MAP[event.type];

    if (!targetPanel) return;

    // 检查各类自动化的开关
    if (event.type === "approval_request" || event.type === "review-needed") {
      if (!config.enableReviewAutoOpen) return;
    } else if (event.type === "file_changed" || event.type === "task-selected") {
      if (!config.enableFilesAutoOpen) return;
    } else if (event.type === "terminal_command") {
      if (!config.enableTerminalAutoOpen) return;
    } else if (event.type === "message_sent") {
      if (!config.enableChatAutoOpen) return;
    }

    const context = getPanelContext(event);
    set((state) => ({
      panelContext: { ...state.panelContext, [targetPanel]: context },
    }));

    const hasPanelOpen = state.openPanels.includes(targetPanel);

    // 根据策略执行
    switch (config.strategy) {
      case "auto":
        // 全自动：总是打开并切换
        state.openPanel(targetPanel, true);
        if (config.showNotificationOnAutoOpen) {
          state.addNotification({
            message: getNotificationMessage(event),
            panelType: targetPanel,
            duration: config.notificationDuration,
          });
        }
        break;

      case "smart":
        // 智能模式：
        // - 重要事件（审批）总是切换
        // - 次要事件只在面板未打开时创建，不切换
        const isImportant = event.type === "approval_request" || event.type === "review-needed";
        if (isImportant) {
          state.openPanel(targetPanel, true);
          if (config.showNotificationOnAutoOpen) {
            state.addNotification({
              message: getNotificationMessage(event),
              panelType: targetPanel,
              duration: config.notificationDuration,
            });
          }
        } else if (!hasPanelOpen) {
          // 面板未打开，创建但不切换
          state.openPanel(targetPanel, false);
          if (config.showNotificationOnAutoOpen) {
            state.addNotification({
              message: getNotificationMessage(event) + "（点击切换到面板）",
              panelType: targetPanel,
              duration: config.notificationDuration,
            });
          }
        }
        // 如果面板已打开且不是重要事件，只更新内容（由组件自行处理）
        break;

      case "manual":
        // 手动模式：只显示通知
        if (config.showNotificationOnAutoOpen) {
          state.addNotification({
            message: getNotificationMessage(event) + "（点击打开面板）",
            panelType: targetPanel,
            duration: config.notificationDuration,
          });
        }
        break;
    }
  },
}));

function getPanelContext(event: TriggerEvent): PanelContext {
  const token = Date.now();
  switch (event.type) {
    case "approval_request":
      return { id: event.approvalId, filePath: event.filePath, token };
    case "review-needed":
      return { id: event.reviewId, filePath: event.filePath, token };
    case "message_sent":
      return { id: event.conversationId, conversationId: event.conversationId, token };
    case "terminal_command":
      return { command: event.command, token };
    case "file_changed":
      return { id: event.filePath, filePath: event.filePath, token };
    case "task-selected":
      return { id: event.taskId, token };
  }
}

// 通知消息生成
function getNotificationMessage(event: TriggerEvent): string {
  switch (event.type) {
    case "approval_request":
      return `代码变更待审批: ${event.filePath}`;
    case "review-needed":
      return `需要代码审查`;
    case "file_changed":
      return `文件已修改: ${event.filePath}`;
    case "task-selected":
      return `已选择任务`;
    case "terminal_command":
      return `命令执行中: ${event.command}`;
    case "message_sent":
      return `新消息`;
    default:
      return `面板已更新`;
  }
}

// Hook：在主区域组件中使用
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
    (reviewId: string, filePath?: string) => {
      handleTriggerEvent({ type: "review-needed", reviewId, filePath });
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

  const triggerApprovalRequest = useCallback(
    (approvalId: string, filePath: string) => {
      handleTriggerEvent({ type: "approval_request", approvalId, filePath });
    },
    [handleTriggerEvent]
  );

  return {
    triggerTaskSelected,
    triggerReviewNeeded,
    triggerMessageSent,
    triggerTerminalCommand,
    triggerFileChanged,
    triggerApprovalRequest,
  };
}

// Hook：通知系统
export function useNotifications() {
  const notifications = usePanelAutomation((state) => state.notifications);
  const removeNotification = usePanelAutomation((state) => state.removeNotification);
  const openPanel = usePanelAutomation((state) => state.openPanel);

  return {
    notifications,
    removeNotification,
    openPanel,
  };
}

// Hook：配置管理
export function useAutomationConfig() {
  const config = usePanelAutomation((state) => state.config);
  const updateConfig = usePanelAutomation((state) => state.updateConfig);
  const resetConfig = usePanelAutomation((state) => state.resetConfig);

  return {
    config,
    updateConfig,
    resetConfig,
  };
}

// Hook：自动清理过期通知
export function useNotificationCleanup() {
  const notifications = usePanelAutomation((state) => state.notifications);
  const removeNotification = usePanelAutomation((state) => state.removeNotification);

  useEffect(() => {
    const now = Date.now();
    notifications.forEach((n) => {
      if (now - n.createdAt > n.duration) {
        removeNotification(n.id);
      }
    });
  }, [notifications, removeNotification]);
}

// Hook：通知面板显示状态
export function useNotificationVisibility() {
  const [visible, setVisible] = useState(true);

  return {
    visible,
    show: () => setVisible(true),
    hide: () => setVisible(false),
    toggle: () => setVisible((v) => !v),
  };
}
