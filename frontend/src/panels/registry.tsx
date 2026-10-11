import { ChatPanel } from "@/components/tabs/ChatPanel";
import {
  LazyFilesPanel as FilesPanel,
  LazyReviewPanel as ReviewPanel,
  LazyTerminalPanel as TerminalPanel,
} from "@/panels/lazy-panels";
import { PlaceholderPanel } from "@/components/tabs/PlaceholderPanel";
import { tabTitleKey, type TabType } from "@/stores/tabs";
import type { ComponentType } from "react";

export interface PanelEntry {
  component: ComponentType<{ conversationId?: string; path?: string }>;
}

export const panels: Record<TabType, PanelEntry> = {
  chat: { component: ChatPanel },
  terminal: { component: TerminalPanel },
  browser: { component: () => <PlaceholderPanel titleKey={tabTitleKey("browser")} /> },
  files: { component: FilesPanel },
  review: { component: ReviewPanel },
};

export const tabTypes: TabType[] = ["chat", "terminal", "browser", "files", "review"];
