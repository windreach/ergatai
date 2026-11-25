# Frontend Module Map

> 自动生成：按 feature-first 模块整理前端结构（`src/renderer/features/*` 为主）。

## 1. 功能模块 (Features)

| 模块 | 目录 | 文件数 | 主要职责 | 关键导出 / 组件 |
|---|---|---:|---|---|
| agents | `src/renderer/features/agents` | 274 | 核心 Agent / 会话 / 聊天模块：消息流、协作群聊、队列、输入区、终端、导出、草稿、上下文选择 | `AgentsContent`, `ChatInputArea`, `ChatMessagesRenderer`, `ActiveChatMessages`, `QueueProcessor`, `stores/*`, `collaboration/*` |
| changes | `src/renderer/features/changes` | 50 | Git 变更与 Diff：文件列表、提交/推送、历史视图、diff 全页/peek | `ChangesView`, `ChangesPanel`, `DiffFullPageView`, `DiffCenterPeekDialog`, `useCommitActions`, `usePushAction` |
| conversation | `src/renderer/features/conversation` | 20 | 对话运行时抽象层 | `runtime/*` |
| details-sidebar | `src/renderer/features/details-sidebar` | 27 | 详情侧边栏、section、atoms、对话运行时网关/契约 API | `DetailsSidebar`, `SideChatSidebar`, `lib/chat-contract-api`, `lib/conversation-runtime-gateway` |
| file-viewer | `src/renderer/features/file-viewer` | 10 | 文件查看、搜索、Monaco 语言映射 | `FileViewerSidebar`, `FileSearchDialog`, `useFileContent`, `getMonacoLanguage` |
| hooks | `src/renderer/features/hooks` | 2 | 跨 feature 共享 React hooks（文件上传） | `useAgentsFileUpload` |
| kanban | `src/renderer/features/kanban` | 6 | 看板视图、列/卡片、工作区状态派生 | `KanbanView`, `KanbanBoard`, `KanbanColumn`, `KanbanCard`, `deriveWorkspaceStatus` |
| layout | `src/renderer/features/layout` | 2 | Agent 布局壳 | `AgentsLayout` |
| mentions | `src/renderer/features/mentions` | 14 | 可扩展 Mention Provider 系统（类型/注册表/搜索/缓存） | `mentionRegistry`, `registerBuiltInProviders`, `useMentionSearch`, `MentionSearchEngine` |
| onboarding | `src/renderer/features/onboarding` | 5 | 首次引导页面 | `AnthropicOnboardingPage`, `ApiKeyOnboardingPage`, `BillingMethodPage`, `SelectRepoPage` |
| panel-link | `src/renderer/features/panel-link` | 4 | 面板链接运行时/状态/类型 | `runtime`, `store`, `types` |
| settings | `src/renderer/features/settings` | 3 | 设置内容与侧边栏 | `SettingsContent`, `SettingsSidebar` |
| sidebar | `src/renderer/features/sidebar` | 9 | 侧边栏、workspace 列表、归档、编辑对话框 | `AgentsSidebar`, `WorkspaceList`, `ArchivedWorkspaceList`, `WorkspaceEditDialog` |
| terminal | `src/renderer/features/terminal` | 23 | 终端、多 tab、搜索、Agent 终端、link providers | `Terminal`, `TerminalSidebar`, `TerminalSearch`, `AgentTerminalPane`, `atoms` |

## 2. 基础层 (Shared Kernel / Infra)

| 层级 | 目录 | 文件数 | 职责 | 关键内容 |
|---|---|---:|---|---|
| Electron 主进程 | `src/main` | 121 | 主进程：Claude/Codex 配置、fs/git/terminal、tRPC 路由、窗口管理、平台 | `lib/claude`, `lib/git`, `lib/terminal`, `lib/trpc`, `windows` |
| Preload | `src/preload` | 2 | 预加载脚本 / 上下文桥接 | — |
| 通用 UI | `src/renderer/components` | 65 | Radix UI 基础组件 + dialogs | `components/ui/*`, `dialogs/*` |
| Contexts | `src/renderer/contexts` | 2 | TRPC / Window 上下文 | `TRPCProvider`, `WindowContext` |
| Hooks | `src/renderer/hooks` | 3 | 通用 React hooks | `use-overflow-detection` |
| Lib | `src/renderer/lib` | 48 | API 适配、atoms、缓存、i18n、IPC、jotai、stores、themes、trpc、utils | `api-adapter`, `trpc`, `jotai-store`, `themes`, `stores` |
| 图标 | `src/renderer/icons` | 2 | 图标资源 | — |

## 3. 边界约定

- Feature 间仅可通过 `index.ts`（public entry）相互依赖。
- `ui/` 不得直接导入 `infrastructure/`。
- 运行时状态统一收敛到 `RuntimeSessionStore`。
- 主/渲染进程通过 tRPC 或 IPC 通信，渲染进程不直接 import Node 模块。
- 守卫脚本：`check:api-boundaries`、`check:frontend-ids`、`check:feature-boundaries`、`check:file-size`。
