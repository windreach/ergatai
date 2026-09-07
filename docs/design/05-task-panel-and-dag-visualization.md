# 任务面板与 DAG 可视化设计

状态：Draft  
日期：2026-09-07  
范围：Ergatai 多 Agent 协作平台 - 通用任务管理与 DAG 可视化

## 1. 设计目标

设计通用的任务面板，同时支持群聊模式和 Agent 模式：

- **统一任务管理**：不区分模式，统一展示和管理所有任务
- **DAG 可视化**：直观展示任务依赖关系、执行进度、状态
- **任务追踪**：实时跟踪任务执行状态、进度、结果
- **多视图支持**：提供列表、详情、DAG 图等多种视图

## 2. 核心概念

### 2.1 任务模型

任务面板基于统一的任务模型，不区分群聊模式或 Agent 模式：

```typescript
interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  
  // 任务来源
  source: TaskSource;
  
  // 执行信息
  assignee?: AgentInfo;
  collaborators?: AgentInfo[];
  
  // 依赖关系
  dependsOn?: string[];
  blockedBy?: string[];
  
  // 时间信息
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  
  // 进度信息
  progress?: number; // 0-100
  estimatedDuration?: number; // 秒
  
  // DAG 信息
  dagId?: string;
  dagNodeId?: string;
  
  // 结果
  result?: TaskResult;
}

type TaskStatus = 
  | 'pending'      // 待执行
  | 'queued'       // 已排队
  | 'running'      // 执行中
  | 'waiting'      // 等待依赖/审批
  | 'completed'    // 已完成
  | 'failed'       // 失败
  | 'cancelled';   // 已取消

type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

type TaskSource = 
  | { type: 'group_chat'; conversationId: string; messageId: string }
  | { type: 'agent_mode'; sessionId: string; parentAgentId: string }
  | { type: 'dag'; dagId: string; nodeId: string }
  | { type: 'manual'; userId: string };

interface AgentInfo {
  id: string;
  name: string;
  type: string; // Claude, Codex, GPT-4, etc.
  avatar?: string;
}

interface TaskResult {
  summary: string;
  artifacts?: Artifact[];
  metrics?: TaskMetrics;
}
```

### 2.2 DAG 模型

DAG（有向无环图）用于编排多任务依赖关系：

```typescript
interface DAG {
  id: string;
  name: string;
  description?: string;
  
  // 节点列表
  nodes: DAGNode[];
  
  // 边列表（依赖关系）
  edges: DAGEdge[];
  
  // 全局配置
  config?: DAGConfig;
  
  // 执行状态
  status: DAGStatus;
  progress: number; // 0-100
  
  // 时间信息
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

interface DAGNode {
  id: string;
  title: string;
  description?: string;
  
  // 执行信息
  agentId: string;
  taskId?: string; // 关联的任务 ID
  
  // 状态
  status: NodeStatus;
  progress?: number;
  
  // 位置（用于可视化）
  position?: { x: number; y: number };
}

interface DAGEdge {
  from: string; // 节点 ID
  to: string;   // 节点 ID
  label?: string;
}

type NodeStatus = 
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

interface DAGConfig {
  maxConcurrency?: number; // 最大并发数
  timeout?: number; // 全局超时（秒）
  retryPolicy?: RetryPolicy;
}

type DAGStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

## 3. 任务面板设计

### 3.1 面板布局

任务面板支持三种视图模式：

#### 视图 1：列表视图

```
+--------------------------------------+
| 任务列表                    [筛选] [排序] |
+--------------------------------------+
| 状态：全部 | 优先级：全部 | 分配：全部 |
+--------------------------------------+
|                                      |
| [高] 修复登录超时问题                 |
|      Codex | 运行中 | 进度 60%       |
|      创建：2 小时前 | 预计：30 分钟   |
|                                      |
| [高] 审查代码变更                     |
|      Claude | 等待中 | 依赖：#1      |
|      创建：1 小时前                   |
|                                      |
| [中] 更新文档                         |
|      GPT-4 | 已完成 | 耗时：15 分钟  |
|      完成：30 分钟前                  |
|                                      |
| [低] 优化性能                         |
|      Codex | 待执行                   |
|      创建：10 分钟前                  |
|                                      |
+--------------------------------------+
| 共 4 个任务 | 1 运行中 | 1 等待 | 1 完成 |
+--------------------------------------+
```

**功能**：
- 显示所有任务列表
- 支持按状态、优先级、分配人筛选
- 支持按创建时间、优先级、状态排序
- 点击任务进入详情视图

#### 视图 2：详情视图

```
+--------------------------------------+
| < 返回任务列表                        |
+--------------------------------------+
| 修复登录超时问题              [高优先级] |
+--------------------------------------+
| 状态：运行中 | 进度：60%              |
| 分配给：Codex                         |
| 创建时间：2026-09-07 14:30           |
| 开始时间：2026-09-07 14:32           |
| 预计耗时：30 分钟                     |
+--------------------------------------+
| 描述：                                |
| 用户报告登录时出现超时错误，需要定位   |
| 并修复 refresh token 的竞态条件问题。 |
+--------------------------------------+
| 执行过程：                            |
| +----------------------------------+ |
| | 14:32 开始分析问题                | |
| | 14:35 读取 auth/session.ts        | |
| | 14:38 读取 auth/token.ts          | |
| | 14:40 定位到 refresh token 竞态   | |
| | 14:42 准备修复方案                | |
| | 14:45 等待审批（当前）            | |
| +----------------------------------+ |
+--------------------------------------+
| 依赖关系：                            |
| - 无                                  |
+--------------------------------------+
| 产出物：                              |
| - auth-fix.patch (待生成)             |
+--------------------------------------+
| 操作：                                |
| [暂停] [取消] [查看详情] [查看日志]   |
+--------------------------------------+
```

**功能**：
- 显示任务详细信息
- 实时展示执行过程
- 显示依赖关系
- 展示产出物
- 提供操作按钮

#### 视图 3：DAG 视图

```
+--------------------------------------+
| DAG：Auth 修复流程                    |
+--------------------------------------+
|                                      |
|   +-------------+                   |
|   | 1. 分析问题 | ← 已完成          |
|   |   (Codex)   |                   |
|   +------+------+                   |
|          |                           |
|          v                           |
|   +-------------+                   |
|   | 2. 修复代码 | ← 运行中          |
|   |   (Codex)   |                   |
|   +------+------+                   |
|          |                           |
|          v                           |
|   +-------------+                   |
|   | 3. 审查代码 | ← 等待中          |
|   |  (Claude)   |                   |
|   +------+------+                   |
|          |                           |
|          v                           |
|   +-------------+                   |
|   | 4. 更新文档 | ← 待执行          |
|   |   (GPT-4)   |                   |
|   +-------------+                   |
|                                      |
| 进度：1/4 完成 | 运行时间：15 分钟   |
+--------------------------------------+
| [缩放] [适应屏幕] [导出图片]          |
+--------------------------------------+
```

**功能**：
- 可视化展示 DAG 结构
- 实时显示节点状态和进度
- 支持缩放和拖拽
- 点击节点查看详情

### 3.2 视图切换

```
+--------------------------------------+
| [列表] [详情] [DAG]                  |
+--------------------------------------+
```

用户可以在三种视图间自由切换：
- **列表视图**：快速浏览所有任务
- **详情视图**：查看单个任务的详细信息
- **DAG 视图**：查看任务依赖关系和整体进度

### 3.3 任务来源标识

任务面板通过图标和标签标识任务来源：

| 来源 | 图标 | 标签 |
|-----|------|------|
| 群聊模式 | 💬 | 群聊 |
| Agent 模式 | 🤖 | Agent |
| DAG 编排 | 🔀 | DAG |
| 手动创建 | ✍️ | 手动 |

## 4. DAG 可视化设计

### 4.1 可视化布局

DAG 可视化采用自上而下的层次布局：

```
层级 0:  +-------------+
         | 起始节点    |
         +-------------+
                |
层级 1:  +------+------+
         |             |
    +----+----+  +----+----+
    | 节点 A  |  | 节点 B  |
    +---------+  +---------+
         |             |
层级 2:  +------+------+
         |             |
    +----+----+  +----+----+
    | 节点 C  |  | 节点 D  |
    +---------+  +---------+
         |             |
层级 3:  +------+------+
         |             |
    +----+----+  +----+----+
    | 节点 E  |  | 节点 F  |
    +---------+  +---------+
```

### 4.2 节点状态表示

每个节点通过颜色和图标表示状态：

| 状态 | 颜色 | 图标 |
|-----|------|------|
| 待执行 | 灰色 | ○ |
| 运行中 | 蓝色 | ▶ |
| 已完成 | 绿色 | ✓ |
| 失败 | 红色 | ✗ |
| 跳过 | 黄色 | ⊘ |

### 4.3 节点内容

每个节点显示：

```
+------------------+
| 1. 分析问题      |  ← 标题
|    (Codex)       |  ← Agent 信息
|    ✓ 已完成      |  ← 状态
|    进度：100%    |  ← 进度
|    耗时：5 分钟  |  ← 时间
+------------------+
```

### 4.4 交互功能

#### 节点点击

点击节点弹出详情面板：

```
+--------------------------------------+
| 节点详情：分析问题                    |
+--------------------------------------+
| 状态：✓ 已完成                        |
| Agent：Codex                          |
| 开始时间：14:30                       |
| 完成时间：14:35                       |
| 耗时：5 分钟                          |
+--------------------------------------+
| 输入：                                |
| 用户报告登录超时问题                  |
+--------------------------------------+
| 输出：                                |
| 定位到 refresh token 竞态条件         |
+--------------------------------------+
| 产出物：                              |
| - analysis-report.md                  |
+--------------------------------------+
| [查看任务详情] [查看日志] [关闭]      |
+--------------------------------------+
```

#### 边点击

点击边（依赖关系）显示依赖信息：

```
+--------------------------------------+
| 依赖关系                              |
+--------------------------------------+
| 从：分析问题                          |
| 到：修复代码                          |
| 类型：数据依赖                        |
| 传递数据：analysis-report.md          |
+--------------------------------------+
| [关闭]                                |
+--------------------------------------+
```

#### 画布操作

- **缩放**：Ctrl + 滚轮 或 +/- 按钮
- **拖拽**：鼠标拖拽画布
- **适应屏幕**：双击空白区域或点击"适应屏幕"按钮
- **导出图片**：点击"导出图片"按钮下载 PNG/SVG

### 4.5 高级功能

#### 实时进度更新

DAG 可视化支持实时更新：

```typescript
// 监听 DAG 事件
dagEventBus.on('node_status_changed', (event) => {
  const { nodeId, status, progress } = event;
  updateNodeStatus(nodeId, status, progress);
});

dagEventBus.on('node_completed', (event) => {
  const { nodeId, result } = event;
  updateNodeResult(nodeId, result);
  updateDAGProgress();
});
```

#### 并行节点展示

支持并行执行的节点水平排列：

```
         +-------------+
         |   节点 A    |
         +-------------+
                |
    +-----------+-----------+
    |                       |
+---+---+             +---+---+
| 节点 B |             | 节点 C |
+-------+             +-------+
    |                       |
    +-----------+-----------+
                |
         +-------------+
         |   节点 D    |
         +-------------+
```

#### 条件分支展示

支持条件分支的可视化：

```
         +-------------+
         |   节点 A    |
         +-------------+
                |
        +-------+-------+
        |               |
   [条件: x > 0]   [条件: x <= 0]
        |               |
   +----+----+     +----+----+
   | 节点 B  |     | 节点 C  |
   +---------+     +---------+
        |               |
        +-------+-------+
                |
         +-------------+
         |   节点 D    |
         +-------------+
```

## 5. 状态管理

### 5.1 任务状态管理

```typescript
interface TaskState {
  tasks: Task[];
  currentView: 'list' | 'detail' | 'dag';
  selectedTaskId?: string;
  filters: TaskFilters;
  sortBy: TaskSortBy;
}

interface TaskFilters {
  status?: TaskStatus[];
  priority?: TaskPriority[];
  assignee?: string[];
  source?: TaskSource['type'][];
}

type TaskSortBy = 
  | { field: 'createdAt'; order: 'asc' | 'desc' }
  | { field: 'priority'; order: 'asc' | 'desc' }
  | { field: 'status'; order: 'asc' | 'desc' };

// Zustand store
const useTaskStore = create((set) => ({
  tasks: [],
  currentView: 'list',
  selectedTaskId: null,
  filters: {},
  sortBy: { field: 'createdAt', order: 'desc' },
  
  addTask: (task) => set((state) => ({
    tasks: [...state.tasks, task],
  })),
  
  updateTask: (id, updates) => set((state) => ({
    tasks: state.tasks.map(t => 
      t.id === id ? { ...t, ...updates } : t
    ),
  })),
  
  setCurrentView: (view) => set({ currentView: view }),
  
  selectTask: (id) => set({ selectedTaskId: id }),
  
  setFilters: (filters) => set({ filters }),
  
  setSortBy: (sortBy) => set({ sortBy }),
}));
```

### 5.2 DAG 状态管理

```typescript
interface DAGState {
  dags: DAG[];
  currentDAGId?: string;
  selectedNodeId?: string;
  zoom: number;
  pan: { x: number; y: number };
}

const useDAGStore = create((set) => ({
  dags: [],
  currentDAGId: null,
  selectedNodeId: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  
  addDAG: (dag) => set((state) => ({
    dags: [...state.dags, dag],
  })),
  
  updateDAG: (id, updates) => set((state) => ({
    dags: state.dags.map(d => 
      d.id === id ? { ...d, ...updates } : d
    ),
  })),
  
  setCurrentDAG: (id) => set({ currentDAGId: id }),
  
  selectNode: (id) => set({ selectedNodeId: id }),
  
  setZoom: (zoom) => set({ zoom }),
  
  setPan: (pan) => set({ pan }),
}));
```

## 6. 组件结构

### 6.1 任务面板组件

```
TaskPanel
+-- TaskViewSwitcher
|   +-- ListViewButton
|   +-- DetailViewButton
|   +-- DAGViewButton
+-- TaskListView
|   +-- TaskFilters
|   +-- TaskSorter
|   +-- TaskList
|       +-- TaskListItem[]
+-- TaskDetailView
|   +-- TaskHeader
|   +-- TaskInfo
|   +-- TaskTimeline
|   +-- TaskDependencies
|   +-- TaskArtifacts
|   +-- TaskActions
+-- TaskDAGView
|   +-- DAGCanvas
|   |   +-- DAGNode[]
|   |   +-- DAGEdge[]
|   +-- DAGControls
|   |   +-- ZoomControl
|   |   +-- FitScreenButton
|   |   +-- ExportButton
|   +-- DAGNodeDetail
+-- TaskSummary
```

### 6.2 DAG 可视化组件

```
DAGCanvas
+-- SVG 层
|   +-- 边（Edges）
|   |   +-- DAGEdge[]
|   +-- 节点（Nodes）
|       +-- DAGNode[]
+-- HTML 覆盖层
|   +-- 节点详情弹出框
|   +-- 边详情弹出框
+-- 控制层
    +-- 缩放控制
    +-- 拖拽控制
    +-- 选择控制
```

## 7. 实现建议

### 7.1 DAG 可视化库选择

推荐使用 **React Flow**（原 React Flow）：

```typescript
import ReactFlow, {
  Node,
  Edge,
  Controls,
  MiniMap,
  Background,
} from 'react-flow-renderer';

function DAGView() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    // 从 DAG 数据转换为 React Flow 格式
    const flowNodes = dag.nodes.map(node => ({
      id: node.id,
      data: { label: node.title, ...node },
      position: node.position || calculatePosition(node),
      type: 'dagNode',
    }));

    const flowEdges = dag.edges.map(edge => ({
      id: `${edge.from}-${edge.to}`,
      source: edge.from,
      target: edge.to,
      label: edge.label,
    }));

    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [dag]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
    >
      <Controls />
      <MiniMap />
      <Background />
    </ReactFlow>
  );
}
```

### 7.2 自定义节点组件

```typescript
function DAGNodeComponent({ data }) {
  const statusColors = {
    pending: '#9ca3af',
    running: '#3b82f6',
    completed: '#10b981',
    failed: '#ef4444',
    skipped: '#f59e0b',
  };

  return (
    <div className={`dag-node status-${data.status}`}>
      <div className="node-header">
        <span className="node-title">{data.title}</span>
        <span 
          className="node-status" 
          style={{ backgroundColor: statusColors[data.status] }}
        />
      </div>
      <div className="node-body">
        <div className="node-agent">{data.agentName}</div>
        {data.progress !== undefined && (
          <div className="node-progress">
            <div 
              className="progress-bar" 
              style={{ width: `${data.progress}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
```

### 7.3 实时更新

```typescript
// 订阅任务更新
useEffect(() => {
  const unsubscribe = taskEventBus.subscribe('task_updated', (task) => {
    updateTask(task.id, task);
  });

  return unsubscribe;
}, []);

// 订阅 DAG 更新
useEffect(() => {
  const unsubscribe = dagEventBus.subscribe('dag_updated', (dag) => {
    updateDAG(dag.id, dag);
  });

  return unsubscribe;
}, []);
```

## 8. 边界情况处理

### 8.1 大型 DAG

**问题**：DAG 节点数量过多（100+）导致渲染缓慢

**解决方案**：
- 使用虚拟滚动，只渲染可见区域的节点
- 支持折叠/展开子图
- 提供概览模式（MiniMap）
- 分层加载，先显示关键路径

### 8.2 循环依赖检测

**问题**：用户创建的任务存在循环依赖

**解决方案**：
- 在创建任务时检测循环依赖
- 如果检测到循环，阻止创建并提示错误
- 提供循环依赖可视化工具，帮助用户定位问题

### 8.3 任务失败处理

**问题**：DAG 中某个节点失败

**解决方案**：
- 标记失败节点为红色
- 自动跳过依赖该节点的下游节点
- 提供重试按钮
- 显示失败原因和日志链接

### 8.4 并发更新冲突

**问题**：多个 Agent 同时更新同一个任务

**解决方案**：
- 使用乐观锁机制
- 后端处理冲突合并
- 前端显示冲突提示
- 提供手动解决冲突的界面

## 9. 开放问题

1. **任务面板位置**：任务面板应该放在右侧工具面板，还是独立的全屏视图？
2. **DAG 编辑**：是否支持在可视化界面中编辑 DAG（拖拽节点、添加边）？
3. **任务模板**：是否支持保存和复用任务模板？
4. **跨 DAG 依赖**：是否支持不同 DAG 之间的任务依赖？
5. **实时协作**：多个用户同时查看同一个 DAG 时，如何同步状态？

## 10. 成功指标

- 任务列表加载时间 < 500ms
- DAG 可视化渲染时间 < 1s（100 节点以内）
- 任务状态更新延迟 < 200ms
- 用户能在 3 秒内找到目标任务
- DAG 可视化支持 500+ 节点不卡顿
