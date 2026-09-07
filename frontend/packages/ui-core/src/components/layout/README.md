# Ergatai 桌面版 - 三栏布局框架

## 已实现

### 核心组件

1. **DesktopLayout** - 三栏布局容器
   - 左侧面板 (280px)
   - 主区域 (flexible)
   - 右侧工具面板 (400px, 可折叠)

2. **LeftPanel** - 左侧导航
   - SearchBox: 搜索输入框
   - ModeTabs: 群聊/Agent 模式切换
   - NewButton: 新建群聊/会话
   - TaskList: 任务列表（持久化，显示标题+状态+时间）
   - GroupList: 群聊列表（成员数+未读数）
   - SessionList: 会话列表（agent类型+未读数）
   - SettingsButton: 设置入口

3. **MainArea** - 主内容区
   - 对话视图（框架）
   - 任务看板（四列：尚未开始、进行中、成功、失败）
   - DAG 视图（框架）
   - 空视图（欢迎页）

4. **RightPanel** - 右侧工具面板
   - 标签页切换（可关闭）
   - 5个面板：Chat, Terminal, Files, Review, Placeholder
   - 可折叠（展开按钮）

## 设计规范

- ✅ 禁止 emoji
- ✅ 使用 SVG 图标（Lucide React）
- ✅ TypeScript + React
- ✅ Tailwind CSS
- ✅ 函数式组件

## 文件结构

```
ui-core/src/components/layout/
├── index.ts                    # 统一导出
├── DesktopLayout/index.tsx
├── LeftPanel/
│   ├── index.tsx
│   ├── SearchBox.tsx
│   ├── ModeTabs.tsx
│   ├── NewButton.tsx
│   ├── TaskList.tsx
│   ├── GroupList.tsx
│   ├── SessionList.tsx
│   └── SettingsButton.tsx
├── MainArea/index.tsx
└── RightPanel/index.tsx
```

## 依赖

已安装：
- react@19.2.8
- lucide-react@1.40.0
- zustand@5.0.15
- tailwind-merge@3.6.0
- @xyflow/react@12.8.6

## 下一步

1. 集成到应用入口（替换或扩展 WorkspaceShell）
2. 实现 Zustand stores（任务、群聊、会话状态）
3. 连接后端 API
4. 实现 DAG 可视化（React Flow）
5. 完善右侧面板功能

## 测试

```bash
cd /root/ergatai/frontend
npm run dev
```

访问应用查看布局效果。
