# Ergatai Frontend

The frontend is a pnpm/npm workspace split for multi-host delivery.

## 产品设计思路（2026-09-08 讨论记录）

> 这一节记录产品方向的讨论过程与定论。前端是 harness 的参考 UI,不是产品本身。

### 一句话定位

**Ergatai = multi-agent harness + 极简参考 UI。**

- 后端 daemon(`ergatai-api`)是产品核心 —— agent 运行时、编排、治理、可观察性
- 前端是 harness 的默认客户端
- Chat 工具(飞书 / Slack 等)也是 harness 的客户端,可选接入

类比:Docker Engine 是产品,Docker Desktop 是参考 UI。

### UI 形态:dockview + ChatGPT panel

采用 `dockview` 作为布局容器。每个 agent 开一个 tab,tab 内是 ChatGPT 风格的对话面板。

```
┌──────────────────────────────────────────────────────────┐
│  [agent-1 ×] [agent-2 ×] [agent-3 ×] [+]                │  ← dockview tabs
├──────────────────────────────────────────────────────────┤
│                                                          │
│  当前 tab 的 ChatGPT-style 对话面板                       │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ User: ...                                          │ │
│  │ Assistant: ...                                     │ │
│  │   ▸ ToolCall: ...                                  │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  [输入框...]                                      [发送]│
└──────────────────────────────────────────────────────────┘
```

要点:
- 每个 tab = 一个 agent session,绑一个 ACP session
- Tab 内容 = 现有 `ChatPanel` 组件(消息气泡 + tool call 渲染 + 输入框)
- dockview 提供 tab 管理 + 拖拽 split + 持久化布局
- IDE 形态(file tree / terminal / monaco / review)全部不做
- **Headed / Headless**:tab 开着看 = headed;tab 关着 agent 在 daemon 跑 = headless

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  前端:dockview + ChatPanel per agent tab                │
│  ── 形态可选:web(daemon serve)或 Tauri 桌面 wrapper     │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket / SSE
                       ▼
┌─────────────────────────────────────────────────────────┐
│  ergatai-api daemon(= harness 核心)                     │
│  ── REST API                                            │
│  ── MCP server(agent tools)                             │
│  ── messaging pipeline(admission / NATS)                │
│  ── surface dispatcher                                  │
│  ── ergatai-surface crate(飞书 adapter,未来 Slack)      │
└──────────────────────┬──────────────────────────────────┘
                       │ ACP over stdio
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Agents: Claude / Codex / GPT / 自定义 ...              │
└─────────────────────────────────────────────────────────┘
```

### 关键决策

**后端**

- 不做"chat gateway 即产品" —— 纯协议包装没有护城河,差异化在 harness 能力(DAG 编排 / MeshPolicy / 文件锁 / 多 vendor ACP 支持)
- 新增 `ergatai-surface` crate(**一个**)统一放所有 chat 适配器,用 Cargo feature 选装(`feishu`, `slack`, ...)
- `InboundSurface` trait 极简抽象:`on_event` / `send_reply` / `bind_agent` / `unbind_agent`
- 飞书 adapter 用 Rust 写:直接接 messaging pipeline,零 IPC;飞书 Open API 用 reqwest + serde 自己封装(无官方 Rust SDK,但 API 表面小)
- Bot 身份模型:每个 agent 一个独立飞书 bot(用户体验最直接,代价是 bot 凭据管理)
- 对话模型:飞书端私聊 + 群聊混合

**前端**

- `dockview` 作为布局容器
- ChatGPT 风格对话面板作为唯一 UI 模式(非 IDE)
- 每 agent 一 tab,tab 管理用户控制
- 砍掉 file tree / terminal / monaco / review 等 IDE 面板
- 复用现有 `ChatPanel` 组件

### 走过的弯路(决策记录)

- ❌ "agent 网关 = 产品":只是 ACP 包装,没有商业化价值
- ❌ Linear-for-agents / 治理平台 / workflow-as-a-service / PaaS:都偏离核心
- ❌ IDE 形态前端:和做 Codex 桌面版一样难,ROI 低
- ❌ 每个 adapter 一个 crate:过度拆分,合并到 `ergatai-surface`

### 待讨论

- 多个 agent 在同一个 daemon 里怎么分配飞书 bot(pool vs 静态绑定)
- Tab 关闭后 agent 是否继续跑(默认 headless)
- 历史会话的呈现(scrollback in-tab vs 单独 history 列表)
- dockview 是否要支持 split view(应该支持,dockview 自带)
- 是否需要 desktop wrapper (Tauri) 还是纯 web
- 商业定价模型(订阅 / 按 agent 数 / 按用量)

## Packages

- `packages/platform-core`: API contracts, transports, and runtime configuration shared by every host.
- `packages/ui-core`: `ChatPanel`, i18n, and the minimal workspace plugin.
- `apps/web`: the browser/Vite entry point.

## Plugin architecture

The web entry boots through `@ergatai/boot`. The UI is composed from named slots instead of hard-coded imports. The renderer owns `root`; the minimal workspace plugin replaces it with a dock-style agent tab shell.

```tsx
import type { Plugin } from "@ergatai/core-plugin-types";

export const featurePlugin: Plugin = {
  name: "example-feature",
  inject: ["slots"],
  apply(context) {
    context.effect(
      () => context.slots.register({ name: "root", id: "example-feature" }, FeatureView),
      "example-feature: register view",
    );
  },
};
```

For the browser shell, create a `*.plugin.ts` file under `apps/web/src/plugins` and export the plugin as the default export. The loader discovers these files at build time, imports them dynamically, validates their shape, and rejects duplicate plugin names. File name order controls load order, so use a numeric prefix when ordering matters:

```ts
// apps/web/src/plugins/10-example.plugin.ts
import { featurePlugin } from "@ergatai/example";

export default featurePlugin;
```

Single slots replace the previous registration. This lets a host swap the whole shell without changing the boot kernel.

`ui-core` exposes the workspace plugin separately:

- `@ergatai/ui-core/plugins/dockview`

The current shell intentionally has no sidebar, terminal, file tree, review panel, or notification host. It only manages agent tabs and mounts `ChatPanel` for each tab; open tab IDs are persisted in `localStorage`.

CEF, VSCode, or another host should reuse `ui-core` and provide its own platform adapter where host behavior differs.

## Commands

```bash
npm install
npm run dev
npm run build
npm run lint
```

Runtime behavior is configured with the existing `VITE_*` variables in `packages/platform-core/src/config/runtime.ts`.
