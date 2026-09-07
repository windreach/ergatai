# Ergatai 桌面版设计实现总结

## 设计概览

三栏布局桌面应用，使用 SVG 图标，禁止 emoji。

## 左侧面板（280px）

### 从上到下：
1. **搜索框** - 全局搜索
2. **模式切换** - 群聊模式 / Agent 模式（tabs）
3. **新建按钮** - 创建新会话
4. **任务列表** - 持久化任务列表
   - 显示：任务标题、状态图标、时间
   - 不显示：Agent 信息
   - 排序：运行中置顶，已完成下移
5. **群聊列表** - 项目群列表
6. **会话列表** - 私聊会话列表
7. **设置** - 底部设置入口

### 图标（SVG）：
- 搜索：magnifying-glass
- 模式切换：无图标，纯文字 tabs
- 新建：plus
- 任务：list-checks
- 群聊：users
- 会话：message-circle
- 设置：settings

### 状态图标（SVG）：
- 运行中：circle（蓝色，可动画）
- 等待中：clock（黄色）
- 已完成：check-circle（绿色）
- 失败：x-circle（红色）

## 主区域（自适应）

### 三种视图：
1. **对话视图**（默认）
   - 群聊模式：多 Agent 对话
   - Agent 模式：单 Agent 对话

2. **任务看板视图**
   - 四列：尚未开始、进行中、成功、失败
   - 任务卡片形式
   - 点击展开详情

3. **DAG 可视化视图**
   - 任务依赖关系图
   - 节点状态可视化
   - 支持缩放、拖拽

### 顶部：
- 视图标题
- 视图切换按钮（如果需要）

## 右侧面板（400px）

### 标签栏：
- ChatPanel（聊天）
- TerminalPanel（终端）
- FilesPanel（文件）
- ReviewPanel（审查）
- 新建按钮

### 内容区：
- 当前激活的面板内容

## 技术栈

- React + TypeScript
- Vite
- Tailwind CSS
- Lucide React（SVG 图标库）
- Zustand（状态管理）

## 文件结构

```
packages/ui-core/src/
├── components/
│   ├── layout/
│   │   ├── LeftPanel/
│   │   │   ├── index.tsx
│   │   │   ├── SearchBox.tsx
│   │   │   ├── ModeTabs.tsx
│   │   │   ├── TaskList.tsx
│   │   │   ├── GroupList.tsx
│   │   │   └── SessionList.tsx
│   │   ├── MainArea/
│   │   │   ├── index.tsx
│   │   │   ├── ConversationView.tsx
│   │   │   ├── TaskKanbanView.tsx
│   │   │   └── DAGView.tsx
│   │   └── RightPanel/
│   │       ├── index.tsx
│   │       └── TabBar.tsx
│   └── icons/
│       └── StatusIcons.tsx
└── core/
    └── store/
        ├── leftPanelStore.ts
        ├── mainAreaStore.ts
        └── rightPanelStore.ts
```

## 实现步骤

1. 创建左侧面板组件
2. 创建主区域视图切换
3. 重构右侧面板
4. 集成所有组件
5. 添加状态管理
6. 测试和优化
