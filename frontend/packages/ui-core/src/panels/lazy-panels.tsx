import { lazy } from "react";

export const LazyChatPanel = lazy(() =>
  import("../components/tabs/ChatPanel").then((module) => ({ default: module.ChatPanel })),
);

export const LazyTerminalPanel = lazy(() =>
  import("../components/tabs/TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);

export const LazyFilesPanel = lazy(() =>
  import("../components/tabs/FilesPanel").then((module) => ({ default: module.FilesPanel })),
);

export const LazyReviewPanel = lazy(() =>
  import("../components/tabs/ReviewPanel").then((module) => ({ default: module.ReviewPanel })),
);
