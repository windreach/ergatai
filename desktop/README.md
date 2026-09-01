# Ergatai Desktop

Ergatai 桌面应用 - 技术感多 agent 协作对话面板

**位置**: `ergatai/desktop/` (ergatai 项目子目录)

## 技术栈

- **前端**: React 18 + TypeScript + Vite
- **后端**: Tauri 2.0 (Rust)
- **设计系统**: Hallmark Cobalt theme (technical tone)
- **字体**: Space Grotesk + Inter + JetBrains Mono
- **API**: 连接 ergatai REST API (localhost:3000)

## 设计特点

采用 **Hallmark Cobalt** 主题，技术感设计风格：

- **Cool-toned palette**: 冷色调 engineered paper + electric cobalt accent
- **Hairline borders**: 1px 细线分隔，无重阴影
- **Technical typography**: Space Grotesk (display) + Inter (body) + JetBrains Mono (code/labels)
- **Mono labels**: 状态、时间戳使用等宽字体 + UPPERCASE + tracking
- **Minimal shadows**: 深度来自边框而非模糊
- **Dark mode support**: 自动适配系统暗色模式

### 布局结构

```
┌─────────────┬──────────────────────────────┐
│ Sidebar     │ Main conversation area       │
│             │                              │
│ Logo        │ Header (agent info)          │
│ ─────────   │ ─────────────────            │
│ AGENTS      │                              │
│ • agent-1   │ Messages                     │
│ • agent-2   │                              │
│ • agent-3   │                              │
│             │                              │
│ ─────────   │ ─────────────────            │
│ [+ New]     │ Input area                   │
└─────────────┴──────────────────────────────┘
```

### 交互状态

- **Agent list**: hover / active / focus-visible
- **Messages**: user (cobalt) / assistant (neutral)
- **Buttons**: primary / ghost / disabled / focus
- **Input**: focus ring (cobalt)
- **Status indicators**: running (green) / stopped (red)

## 开发

### 前置条件

1. 安装 Rust: https://rustup.rs/
2. 安装 Node.js 18+: https://nodejs.org/
3. 安装系统依赖: https://tauri.app/v1/guides/getting-started/prerequisites

### 安装依赖

```bash
# 安装前端依赖
npm install

# 安装 Tauri CLI (如果还没安装)
cargo install tauri-cli --version "^2.0.0"
```

### 开发模式

```bash
# 启动开发服务器（前端 + Tauri）
npm run tauri dev
```

这会：
1. 启动 Vite 开发服务器 (http://localhost:1420)
2. 启动 Tauri 桌面窗口
3. 热重载（修改代码自动刷新）

### 构建生产版本

```bash
# 构建桌面应用
npm run tauri build
```

生成的安装包在 `src-tauri/target/release/bundle/`

## 连接 ergatai

确保 ergatai API 服务器正在运行：

```bash
# 在 ergatai 项目目录
cargo run -p ergatai-api -- --port 3000
```

然后启动桌面应用，它会自动连接到 `http://localhost:3000`

## 功能

### 当前功能

- ✅ 显示运行中的 agents 列表
- ✅ 选择 agent 进行对话
- ✅ 发送消息到 agent
- ✅ 技术感 UI 设计 (Hallmark Cobalt)
- ✅ 自动刷新 agent 状态
- ✅ 键盘快捷键 (Enter 发送, Shift+Enter 换行)
- ✅ Dark mode 支持

### 计划功能

- [ ] Agent 对话历史持久化
- [ ] 启动/停止 agents
- [ ] Agent profile 管理
- [ ] DAG 工作流可视化
- [ ] 文件锁状态显示
- [ ] 实时日志流
- [ ] 多 agent 协作视图
- [ ] ⌘K 命令面板

## 架构设计（可迁移到 VS Code）

```
src/
├── ui/                    # 100% 可复用（React 组件）
├── services/              # 90% 可复用（API 调用）
└── platform/              # 平台特定代码
    ├── tauri/             # Tauri IPC
    └── vscode/            # VS Code API（未来）
```

### 迁移到 VS Code 插件

1. 复制 `src/` 目录
2. 替换 Tauri IPC 调用为 VS Code WebView postMessage
3. 添加 VS Code extension 入口文件
4. 完成！(1-2 天工作量)

## 设计系统

设计 token 定义在 `src/tokens.css`：

### 色彩

```css
/* Paper - cool engineered near-white */
--color-paper: oklch(98.5% 0.004 250);

/* Ink - cool charcoal */
--color-ink: oklch(24% 0.02 258);

/* Accent - electric cobalt (< 5% of viewport) */
--color-accent: oklch(58% 0.20 256);

/* Status colors */
--color-success: oklch(60% 0.18 145);
--color-error: oklch(58% 0.20 25);
```

### 字体

```css
/* Display - Space Grotesk (technical, geometric) */
--font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;

/* Body - Inter (clean, readable) */
--font-body: "Inter", ui-sans-serif, system-ui, sans-serif;

/* Mono - JetBrains Mono (code, labels) */
--font-mono: "JetBrains Mono", ui-monospace, "SF Mono", monospace;
```

### 间距

```css
/* 4pt scale */
--space-xs: 0.25rem;   /* 4px */
--space-sm: 0.5rem;    /* 8px */
--space-md: 1rem;      /* 16px */
--space-lg: 1.5rem;    /* 24px */
--space-xl: 2rem;      /* 32px */
```

### 圆角

```css
/* Tight, technical */
--radius-sm: 4px;
--radius-md: 6px;
--radius-lg: 10px;
```

## 截图

（首次运行后添加）

## License

Apache-2.0
