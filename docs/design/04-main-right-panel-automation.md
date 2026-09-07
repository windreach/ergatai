# 主区域与右侧面板自动化交互设计

状态：Draft  
日期：2026-09-07  
范围：Ergatai 多 Agent 协作平台 - 主区域行为驱动的右侧面板自动化

## 1. 设计目标

实现主区域（中间对话区域）行为驱动的右侧工具面板自动化：

- **智能面板打开**：根据主区域的行为自动打开相关工具面板
- **减少手动操作**：用户无需手动切换面板，系统自动展示相关上下文
- **提升工作流效率**：审批、代码查看、终端输出等场景自动呈现
- **可配置性**：用户可以控制自动化行为，避免过度打扰

## 2. 核心概念

### 2.1 行为-面板映射

主区域的特定行为会触发右侧面板的自动化操作：

| 主区域行为 | 触发的右侧面板 | 触发条件 |
|-----------|---------------|---------|
| Agent 发送代码变更审批请求 | ReviewPanel | 消息包含 approval_request 类型 |
| Agent 创建或修改文件 | FilesPanel | 消息包含 file_change 事件 |
| Agent 执行命令 | TerminalPanel | 消息包含 command_execution 事件 |
| Agent 发送需要详细查看的消息 | ChatPanel | 用户点击"查看详情" |
| 任务创建或状态更新 | 任务详情面板（未来） | 消息包含 task_update 事件 |

### 2.2 自动化策略

系统提供三种自动化策略：

#### 策略 1：全自动模式

- 所有行为都自动打开对应面板
- 新面板以新标签页形式打开
- 自动切换到新打开的标签页
- 适合需要高度关注 Agent 行为的场景

#### 策略 2：智能模式（推荐）

- 重要行为（如审批请求）自动打开面板
- 次要行为（如文件修改）在已有面板中更新
- 如果面板已打开，只更新内容，不切换标签
- 如果面板未打开，创建新标签页但不自动切换
- 平衡自动化和用户控制

#### 策略 3：手动模式

- 所有面板都需要用户手动打开
- 主区域只显示通知标记
- 用户点击通知后才打开对应面板
- 适合不希望被打扰的场景

## 3. 详细设计

### 3.1 代码变更审批场景

**场景描述**：Agent 在主区域发送代码变更审批请求

#### 主区域表现

```
+--------------------------------------+
| 用户：请修复登录超时问题              |
+--------------------------------------+
| Codex：我已经定位到问题，需要修改      |
| src/auth/session.ts 文件。            |
|                                      |
| +----------------------------------+ |
| | 代码变更审批请求                    | |
| | 文件：src/auth/session.ts         | |
| | 变更：+12 行，-3 行               | |
| | 原因：修复 refresh token 竞态条件 | |
| |                                  | |
| | [查看变更] [批准] [拒绝]          | |
| +----------------------------------+ |
|                                      |
| Codex：请在右侧面板查看详细变更。     |
+--------------------------------------+
```

#### 右侧面板自动化行为

**步骤 1：检测审批请求**
- 主区域检测到消息包含 approval_request 类型
- 提取审批 ID、文件路径、变更摘要

**步骤 2：决定面板行为**
```typescript
if (strategy === 'auto') {
  // 全自动模式：打开或切换到 ReviewPanel
  openOrSwitchToReviewPanel(approvalId);
} else if (strategy === 'smart') {
  // 智能模式
  if (hasOpenReviewPanel()) {
    // 如果已有 ReviewPanel，更新内容
    updateReviewPanel(approvalId);
  } else {
    // 创建新标签页但不切换
    createReviewPanelTab(approvalId, { activate: false });
    showNotification('代码变更已打开到右侧面板');
  }
} else {
  // 手动模式：只显示通知
  showNotification('有代码变更待审批，点击查看');
}
```

**步骤 3：打开 ReviewPanel**
- 创建新的 ReviewPanel 标签页
- 加载审批详情和 diff 视图
- 标签页标题显示为"审批：{文件名}"

#### ReviewPanel 内容

```
+--------------------------------------+
| 审批：src/auth/session.ts   [批准] [拒绝] |
+--------------------------------------+
| 变更摘要：                            |
| 文件：src/auth/session.ts            |
| 变更：+12 行，-3 行                  |
| 原因：修复 refresh token 竞态条件   |
+--------------------------------------+
|                                      |
| - const token = getOldToken()        |
| + const token = getNewToken()        |
|   if (!token) {                      |
| -   throw new Error('No token')      |
| +   await refreshToken()             |
| +   token = await createToken()      |
|   }                                  |
|                                      |
| [批准] [需要修改] [拒绝] [查看评论]  |
+--------------------------------------+
```

### 3.2 文件修改场景

**场景描述**：Agent 在主区域通知文件修改

#### 主区域表现

```
+--------------------------------------+
| Codex：我已经修改了以下文件：         |
| - src/auth/session.ts (+12 -3)       |
| - src/utils/helpers.ts (+5 -2)       |
|                                      |
| [查看文件] [查看变更]                |
+--------------------------------------+
```

#### 右侧面板自动化行为

**步骤 1：检测文件修改事件**
- 主区域检测到消息包含 file_change 事件
- 提取文件路径列表

**步骤 2：决定面板行为**
```typescript
if (strategy === 'auto') {
  // 全自动模式：打开 FilesPanel 显示第一个文件
  openFilesPanel(files[0].path);
} else if (strategy === 'smart') {
  // 智能模式
  if (hasOpenFilesPanel()) {
    // 如果已有 FilesPanel，不自动切换
    showNotification('文件已修改，可在右侧面板查看');
  } else {
    // 创建新标签页但不切换
    createFilesPanelTab(files[0].path, { activate: false });
    showNotification('文件已打开到右侧面板');
  }
}
```

**步骤 3：打开 FilesPanel**
- 创建新的 FilesPanel 标签页
- 加载第一个文件
- 标签页标题显示为文件名

### 3.3 命令执行场景

**场景描述**：Agent 在主区域通知命令执行

#### 主区域表现

```
+--------------------------------------+
| Codex：我正在运行测试...              |
|                                      |
| +----------------------------------+ |
| | 命令执行                          | |
| | $ npm test                        | |
| | 状态：运行中                      | |
| | [查看输出]                        | |
| +----------------------------------+ |
+--------------------------------------+
```

#### 右侧面板自动化行为

**步骤 1：检测命令执行事件**
- 主区域检测到消息包含 command_execution 事件
- 提取命令 ID 和命令内容

**步骤 2：决定面板行为**
```typescript
if (strategy === 'auto' || strategy === 'smart') {
  // 自动或智能模式：打开 TerminalPanel
  if (hasOpenTerminalPanel()) {
    // 切换到已有终端面板
    switchToTerminalPanel();
  } else {
    // 创建新终端面板
    createTerminalPanelTab({ activate: true });
  }
}
```

**步骤 3：打开 TerminalPanel**
- 创建新的 TerminalPanel 标签页
- 连接到命令执行的终端会话
- 实时显示命令输出

### 3.4 消息详情场景

**场景描述**：用户点击主区域消息的"查看详情"

#### 主区域表现

```
+--------------------------------------+
| Codex：我已经完成了代码审查，发现了    |
| 3 个问题。[查看详情]                  |
+--------------------------------------+
```

#### 右侧面板自动化行为

**步骤 1：用户点击"查看详情"**
- 主区域检测到用户点击事件
- 提取消息 ID 和详情类型

**步骤 2：打开 ChatPanel**
- 创建新的 ChatPanel 标签页
- 显示消息的完整上下文
- 标签页标题显示为"消息详情"

## 4. 状态管理

### 4.1 自动化配置

```typescript
interface AutomationConfig {
  // 自动化策略
  strategy: 'auto' | 'smart' | 'manual';
  
  // 各类行为的自动化开关
  enableReviewAutoOpen: boolean;
  enableFilesAutoOpen: boolean;
  enableTerminalAutoOpen: boolean;
  
  // 通知设置
  showNotificationOnAutoOpen: boolean;
  notificationDuration: number; // 毫秒
}

// 默认配置
const defaultConfig: AutomationConfig = {
  strategy: 'smart',
  enableReviewAutoOpen: true,
  enableFilesAutoOpen: true,
  enableTerminalAutoOpen: true,
  showNotificationOnAutoOpen: true,
  notificationDuration: 3000,
};
```

### 4.2 事件监听

```typescript
// 主区域事件监听器
class MainAreaEventListeners {
  constructor(
    private automationService: AutomationService,
    private rightPanelStore: RightPanelStore,
  ) {}

  onMessageReceived(message: Message) {
    // 检测审批请求
    if (message.type === 'approval_request') {
      this.automationService.handleApprovalRequest(message);
    }
    
    // 检测文件修改
    if (message.type === 'file_change') {
      this.automationService.handleFileChange(message);
    }
    
    // 检测命令执行
    if (message.type === 'command_execution') {
      this.automationService.handleCommandExecution(message);
    }
  }

  onUserClickDetail(messageId: string) {
    this.automationService.handleViewDetail(messageId);
  }
}
```

### 4.3 自动化服务

```typescript
class AutomationService {
  constructor(
    private config: AutomationConfig,
    private rightPanelStore: RightPanelStore,
    private notificationService: NotificationService,
  ) {}

  handleApprovalRequest(message: ApprovalRequestMessage) {
    if (!this.config.enableReviewAutoOpen) return;
    
    if (this.config.strategy === 'auto') {
      this.openOrSwitchToReviewPanel(message.approvalId);
    } else if (this.config.strategy === 'smart') {
      if (this.rightPanelStore.hasReviewPanel()) {
        this.rightPanelStore.updateReviewPanel(message.approvalId);
      } else {
        this.rightPanelStore.createReviewPanelTab(message.approvalId, {
          activate: false,
        });
        if (this.config.showNotificationOnAutoOpen) {
          this.notificationService.show('代码变更已打开到右侧面板');
        }
      }
    } else {
      // 手动模式
      if (this.config.showNotificationOnAutoOpen) {
        this.notificationService.show('有代码变更待审批，点击查看');
      }
    }
  }

  handleFileChange(message: FileChangeMessage) {
    if (!this.config.enableFilesAutoOpen) return;
    
    if (this.config.strategy === 'auto') {
      this.rightPanelStore.openFilesPanel(message.files[0].path);
    } else if (this.config.strategy === 'smart') {
      if (!this.rightPanelStore.hasFilesPanel()) {
        this.rightPanelStore.createFilesPanelTab(message.files[0].path, {
          activate: false,
        });
        if (this.config.showNotificationOnAutoOpen) {
          this.notificationService.show('文件已打开到右侧面板');
        }
      }
    }
  }

  handleCommandExecution(message: CommandExecutionMessage) {
    if (!this.config.enableTerminalAutoOpen) return;
    
    if (this.config.strategy === 'auto' || this.config.strategy === 'smart') {
      if (this.rightPanelStore.hasTerminalPanel()) {
        this.rightPanelStore.switchToTerminalPanel();
      } else {
        this.rightPanelStore.createTerminalPanelTab({ activate: true });
      }
    }
  }

  handleViewDetail(messageId: string) {
    this.rightPanelStore.createChatPanelTab(messageId, {
      activate: true,
      viewMode: 'detail',
    });
  }
}
```

## 5. 用户界面

### 5.1 设置面板

在设置中提供自动化配置选项：

```
+--------------------------------------+
| 主区域与右侧面板自动化                |
+--------------------------------------+
|                                      |
| 自动化策略：                          |
| (*) 智能模式（推荐）                  |
| ( ) 全自动模式                        |
| ( ) 手动模式                          |
|                                      |
| 自动化开关：                          |
| [x] 代码变更审批自动打开审查面板      |
| [x] 文件修改自动打开文件面板          |
| [x] 命令执行自动打开终端面板          |
|                                      |
| 通知设置：                            |
| [x] 自动打开面板时显示通知            |
| 通知持续时间：[3 秒 ▼]                |
|                                      |
+--------------------------------------+
```

### 5.2 通知提示

当面板自动打开时，显示轻量通知：

```
+--------------------------------------+
| 代码变更已打开到右侧面板    [关闭]   |
+--------------------------------------+
```

通知特点：
- 显示在右上角
- 3 秒后自动消失
- 可手动关闭
- 点击通知可以切换到对应面板

### 5.3 主区域快捷操作

在主区域的消息上提供快捷操作：

```
+--------------------------------------+
| Codex：我已经修改了代码。             |
|                                      |
| [查看文件] [查看变更] [查看终端]     |
+--------------------------------------+
```

点击按钮的行为：
- 如果面板已打开：切换到该面板
- 如果面板未打开：创建新面板并切换

## 6. 边界情况处理

### 6.1 多个审批请求同时到达

**问题**：多个 Agent 同时发送审批请求

**解决方案**：
- 为每个审批请求创建独立的 ReviewPanel 标签页
- 标签页标题显示文件名以区分
- 智能模式下只自动打开第一个，其余显示通知

### 6.2 面板已达到数量限制

**问题**：右侧面板标签页数量达到上限（如 10 个）

**解决方案**：
- 提示用户关闭一些标签页
- 或自动关闭最久未使用的标签页
- 或复用已有的同类面板

### 6.3 用户正在查看其他面板

**问题**：用户正在查看右侧面板，新的自动化行为触发

**解决方案**：
- 智能模式：不自动切换，只显示通知
- 全自动模式：切换到新面板，但保留用户之前的位置
- 提供"返回上一个面板"的快捷操作

### 6.4 网络延迟或面板加载失败

**问题**：面板加载失败或网络延迟

**解决方案**：
- 显示加载状态
- 提供重试按钮
- 加载失败时显示错误信息
- 不影响主区域的正常使用

## 7. 实现建议

### 7.1 组件结构

```
MainArea
+-- MessageList
|   +-- Message
|       +-- ApprovalCard -> onClick -> AutomationService.handleApprovalRequest
|       +-- FileChangeCard -> onClick -> AutomationService.handleFileChange
|       +-- CommandCard -> onClick -> AutomationService.handleCommandExecution
+-- AutomationService
    +-- AutomationConfig
    +-- RightPanelStore
    +-- NotificationService
```

### 7.2 事件总线

使用事件总线解耦主区域和右侧面板：

```typescript
// 事件定义
type AutomationEvent =
  | { type: 'approval_request'; approvalId: string }
  | { type: 'file_change'; files: FileInfo[] }
  | { type: 'command_execution'; commandId: string }
  | { type: 'view_detail'; messageId: string };

// 事件总线
class AutomationEventBus {
  private listeners: Map<string, Function[]> = new Map();

  subscribe(eventType: string, listener: Function) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(listener);
  }

  emit(event: AutomationEvent) {
    const listeners = this.listeners.get(event.type) || [];
    listeners.forEach(listener => listener(event));
  }
}
```

### 7.3 配置持久化

```typescript
// 保存配置到 localStorage
function saveAutomationConfig(config: AutomationConfig) {
  localStorage.setItem('automation_config', JSON.stringify(config));
}

// 从 localStorage 加载配置
function loadAutomationConfig(): AutomationConfig {
  const saved = localStorage.getItem('automation_config');
  if (saved) {
    return JSON.parse(saved);
  }
  return defaultConfig;
}
```

## 8. 开放问题

1. **面板复用策略**：如果已有 ReviewPanel，是创建新标签页还是复用？
2. **通知优先级**：多个通知同时到达时如何排序？
3. **面板关闭策略**：审批完成后是否自动关闭 ReviewPanel？
4. **跨会话持久化**：自动化配置是否需要在多设备间同步？
5. **性能影响**：频繁的面板打开/切换是否会影响性能？

## 9. 成功指标

- 审批请求到达后 1 秒内 ReviewPanel 打开
- 用户无需手动查找相关面板
- 自动化行为不会过度打扰用户
- 用户可以在设置中完全控制自动化行为
- 面板打开成功率 > 99%
