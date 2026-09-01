# 应用级文件锁系统设计

## 1. 背景与问题

### 1.1 当前系统问题

1. **过度复杂**: 使用 Linux fanotify 内核级拦截 + LD_PRELOAD + IPC 服务器，代码量 ~3000 行
2. **跨平台限制**: fanotify 仅 Linux 可用，其他平台依赖 FileSystemWatcher (post-facto 检测)
3. **ACP PID 缺失**: 当前使用 `connect_with()` 高层 API，无法获取子进程 PID
4. **锁续期问题**: 依赖 TTL 过期，无法基于实际文件活跃度续期
5. **违规检测缺失**: 无法实时检测 agent 是否修改了未授权文件

### 1.2 设计目标

1. **简化架构**: 移除内核级强制，改用应用级锁 + 提示词注入
2. **精准检测**: 通过 PID 精确识别修改文件的 agent
3. **版本控制**: 使用文件 hash 作为版本号，支持快照恢复
4. **违规处理**: 实时检测违规并回退文件
5. **跨平台**: 不依赖 Linux 特性，全平台可用

---

## 2. 核心设计

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent 启动流程                            │
├─────────────────────────────────────────────────────────────┤
│  1. spawn_process() → 获取 PID                              │
│  2. 存储 PID → agent_id 映射                                │
│  3. 分配文件 → 计算初始 hash                                │
│  4. 注入提示词 → 告诉 agent 只能修改哪些文件                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    运行时监控                                │
├─────────────────────────────────────────────────────────────┤
│  文件系统监控 (inotify/notify) 检测文件修改 + PID           │
                            ↓                                  │
│  PID → agent_id → 检查锁权限                               │
│    ✅ 允许 → 更新 hash                                     │
│    ❌ 违规 → 回退文件 (用 hash 快照)                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    锁生命周期                                │
├─────────────────────────────────────────────────────────────┤
│  创建: agent 启动时分配文件，计算 hash                      │
│  续期: agent 修改文件时更新 hash (基于活跃度)              │
│  释放: agent 退出或锁过期                                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心组件

#### 2.2.1 PID 映射管理

```rust
// AcpBackend 新增字段
pub struct AcpBackend {
    agents: RwLock<HashMap<String, AcpAgentEntry>>,
    pid_to_agent: RwLock<HashMap<u32, String>>,  // 新增
    agent_children: RwLock<HashMap<String, async_process::Child>>,  // 新增
    // ...
}
```

**职责**:
- 启动 agent 时记录 PID → agent_id 映射
- agent 退出时清理映射
- 提供查询接口: `get_agent_by_pid(pid) -> Option<agent_id>`

#### 2.2.2 文件锁管理 (简化版)

```rust
// 删除复杂的 fanotify/LD_PRELOAD 相关代码
// 保留核心锁管理逻辑

pub struct FileLockManager {
    conn: Arc<Mutex<Connection>>,
    project_root: PathBuf,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增
    // 删除: active_write_locks_cache (不再需要)
    // 删除: enforcer 相关字段
}
```

**核心方法**:
```rust
impl FileLockManager {
    // 创建锁 (agent 启动时)
    pub fn acquire_lock(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError>;
    
    // 更新 hash (agent 修改文件时)
    pub fn update_file_hash(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError>;
    
    // 释放锁
    pub fn release_lock(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError>;
    
    // PID 查询
    pub fn get_agent_by_pid(&self, pid: u32) -> Option<String>;
    
    // 违规检测
    pub fn check_permission(
        &self,
        file_path: &str,
        pid: u32,
    ) -> Result<PermissionResult, ErgataiError>;
}

pub enum PermissionResult {
    Allowed,
    Denied { reason: String },
}
```

#### 2.2.3 文件系统监控

```rust
pub struct FileMonitor {
    lock_manager: Arc<FileLockManager>,
    watcher: notify::RecommendedWatcher,
    project_root: PathBuf,
}

impl FileMonitor {
    pub fn start(&mut self) -> Result<(), ErgataiError> {
        // 监控项目目录
        self.watcher.watch(&self.project_root, RecursiveMode::Recursive)?;
        
        // 事件循环
        loop {
            match self.event_rx.recv() {
                Ok(event) => self.handle_event(event)?,
                Err(_) => break,
            }
        }
        
        Ok(())
    }
    
    fn handle_event(&self, event: notify::Event) -> Result<(), ErgataiError> {
        // 获取修改的文件路径
        let file_path = event.paths.first().ok_or(...)?;
        
        // 获取修改者的 PID (Linux: inotify, 其他平台: 通过 /proc 或其他机制)
        let pid = self.get_modifier_pid(file_path)?;
        
        // 检查权限
        match self.lock_manager.check_permission(file_path, pid)? {
            PermissionResult::Allowed => {
                // 更新 hash
                let agent_id = self.lock_manager.get_agent_by_pid(pid).unwrap();
                self.lock_manager.update_file_hash(file_path, &agent_id)?;
            }
            PermissionResult::Denied { reason } => {
                // 回退文件
                self.rollback_file(file_path)?;
                
                // 记录违规
                self.log_violation(pid, file_path, reason)?;
                
                // 可选: 发送警告消息给 agent
            }
        }
        
        Ok(())
    }
}
```

**PID 获取方式**:

| 平台 | 方法 | 说明 |
|------|------|------|
| Linux | `inotify` + `/proc/{pid}/fd` | 通过文件描述符反向查找 PID |
| macOS | `FSEvents` + `proc_pidinfo` | 类似 Linux |
| Windows | `ReadDirectoryChangesW` + `NtQuerySystemInformation` | 复杂，可能需要第三方库 |

**简化方案**: 如果 PID 获取困难，可以先用 tool_calls 追踪 (事后检测)，后续再优化为实时监控。

#### 2.2.4 Hash 版本控制

```rust
// file_locks 表结构
CREATE TABLE file_locks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    current_hash TEXT NOT NULL,           -- 当前文件 hash
    version INTEGER NOT NULL DEFAULT 1,   -- 版本号
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,                  -- ACTIVE | EXPIRED | VIOLATED
    violation_count INTEGER DEFAULT 0,
    
    UNIQUE(file_path) WHERE status = 'ACTIVE'
);

// 快照存储 (可选)
CREATE TABLE file_snapshots (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    hash TEXT NOT NULL,
    git_ref TEXT NOT NULL,                 -- Git 对象引用
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
);
```

**Hash 计算**:
```rust
fn compute_hash(file_path: &Path) -> Result<String, ErgataiError> {
    let content = std::fs::read(file_path)?;
    let hash = sha2::Sha256::digest(&content);
    Ok(format!("sha256:{:x}", hash))
}
```

**Hash 更新流程**:
```
Agent 修改文件
  ↓
文件系统监控检测到修改 + PID
  ↓
PID → agent_id → 检查权限
  ↓
✅ 允许:
  1. 计算新 hash
  2. UPDATE file_locks SET current_hash = new_hash, version = version + 1
  3. (可选) 创建 Git 快照
  ↓
❌ 违规:
  1. 从 DB 读取 current_hash
  2. 从 Git 对象存储恢复文件
  3. 记录违规日志
```

---

## 3. 详细实现计划

### 3.1 阶段 1: ACP 启动重构 (2-3 天)

#### 3.1.1 修改 AcpBackend 结构

```rust
// crates/ergatai-runtime/src/backends/acp.rs

pub struct AcpBackend {
    agents: RwLock<HashMap<String, AcpAgentEntry>>,
    workspaces: RwLock<HashMap<String, WorkspaceEntry>>,
    dead_agents: Arc<parking_lot::Mutex<Vec<String>>>,
    
    // 新增
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
    agent_children: Arc<RwLock<HashMap<String, async_process::Child>>>,
    
    // ... 其他字段
}
```

#### 3.1.2 重构 launch_agent() 方法

```rust
async fn launch_agent(&self, spec: WorkspaceSpec) -> ErgataiResult<AgentHandle> {
    // 1. 解析命令
    let config = AcpAgent::from_str(&spec.command)?;
    let acp_agent = AcpAgent::new(config.into_config());
    
    // 2. 使用 spawn_process() 替代 connect_with()
    let (stdin, stdout, stderr, child) = acp_agent.spawn_process()?;
    let pid = child.id();
    let agent_id = self.next_agent_id(&spec.id);
    
    // 3. 存储 PID 映射
    self.pid_to_agent.write().insert(pid, agent_id.clone());
    
    // 4. 存储 Child
    self.agent_children.write().insert(agent_id.clone(), child);
    
    // 5. 手动建立 ACP 连接
    let connection = Client::builder()
        .name(format!("ergatai-acp-{}", agent_id))
        .on_receive_notification({
            let output = output.clone();
            async move |notification, _cx| {
                // 处理 notification (同之前的逻辑)
            }
        })
        .on_receive_request(request_handler)
        .connect(stdin, stdout)
        .await?;
    
    // 6. 初始化 ACP 会话
    let init_response = connection
        .send_request(InitializeRequest::new(ProtocolVersion::V1))
        .await?;
    
    // 7. 创建/加载会话
    let session_id = self.create_or_load_session(&connection, &spec.work_dir).await?;
    
    // 8. 返回 AgentHandle
    Ok(AgentHandle {
        agent_id: agent_id.clone(),
        workspace: WorkspaceHandle {
            id: spec.id,
            backend: "acp".to_string(),
            metadata: HashMap::new(),
        },
        process_id: Some(pid.to_string()),
        metadata: HashMap::new(),
    })
}
```

#### 3.1.3 重构 stop_agent() 方法

```rust
async fn stop_agent(&self, handle: &AgentHandle) -> ErgataiResult<()> {
    // 1. 获取 Child
    let child = self.agent_children.write().remove(&handle.agent_id);
    
    // 2. 移除 PID 映射
    if let Some(pid_str) = &handle.process_id {
        if let Ok(pid) = pid_str.parse::<u32>() {
            self.pid_to_agent.write().remove(&pid);
        }
    }
    
    // 3. 终止进程 (复用 ChildGuard 逻辑)
    if let Some(mut child) = child {
        #[cfg(unix)]
        if let Some(pid) = rustix::process::Pid::from_raw(child.id().cast_signed()) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
        drop(child.kill().await);
    }
    
    // 4. 清理 agents map
    self.agents.write().remove(&handle.agent_id);
    
    Ok(())
}
```

#### 3.1.4 测试

```rust
#[tokio::test]
async fn test_pid_tracking() {
    let backend = AcpBackend::new();
    let spec = WorkspaceSpec {
        id: "test-ws".to_string(),
        command: "echo hello".to_string(),
        work_dir: PathBuf::from("/tmp"),
        env: HashMap::new(),
    };
    
    let handle = backend.launch_agent(spec).await.unwrap();
    
    // 验证 PID 已记录
    assert!(handle.process_id.is_some());
    let pid = handle.process_id.unwrap().parse::<u32>().unwrap();
    assert_eq!(backend.get_agent_by_pid(pid).await, Some("test-ws-agent-1".to_string()));
    
    // 停止 agent
    backend.stop_agent(&handle).await.unwrap();
    
    // 验证 PID 映射已清理
    assert_eq!(backend.get_agent_by_pid(pid).await, None);
}
```

### 3.2 阶段 2: 文件锁简化 (2-3 天)

#### 3.2.1 删除 fanotify/LD_PRELOAD 相关代码

**删除文件**:
- `crates/ergatai-lock/src/enforcer/` (整个目录)
- `crates/ergatai-preload/` (整个 crate)
- `crates/ergatai-lock/src/ipc_server.rs`
- `crates/ergatai-lock/src/watcher.rs` (FileSystemWatcher)

**删除代码**:
- `FileLockManager::active_write_locks_cache`
- `FileLockManager::auto_acquire_write_lock()`
- `FileLockManager::check_file_lock_status()`
- `manager.rs::init_file_access_with_enforcer()`
- 所有 fanotify/LD_PRELOAD 相关的测试

**预估删除**: ~2000 行

#### 3.2.2 简化 FileLockManager

```rust
pub struct FileLockManager {
    conn: Arc<Mutex<Connection>>,
    project_root: PathBuf,
    project_root_canonical: PathBuf,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增
    // 删除: active_write_locks_cache
    // 删除: waiters (READ_LATEST 相关)
}

impl FileLockManager {
    pub fn new(
        db_path: &Path,
        project_root: PathBuf,
        pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增参数
    ) -> Result<Self, ErgataiError> {
        // ... 初始化逻辑
    }
    
    // 新增: 创建锁
    pub fn acquire_lock(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        let hash = compute_hash(&self.project_root.join(&normalized_path))?;
        
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO file_locks (id, file_path, agent_id, current_hash, version, created_at, updated_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, ?6, 'ACTIVE')",
            params![
                uuid::Uuid::new_v4().to_string(),
                normalized_path,
                agent_id,
                hash,
                Utc::now().to_rfc3339(),
                (Utc::now() + Duration::hours(24)).to_rfc3339(),
            ],
        )?;
        
        Ok(())
    }
    
    // 新增: 更新 hash
    pub fn update_file_hash(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        let hash = compute_hash(&self.project_root.join(&normalized_path))?;
        
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_locks SET current_hash = ?1, version = version + 1, updated_at = ?2
             WHERE file_path = ?3 AND agent_id = ?4 AND status = 'ACTIVE'",
            params![hash, Utc::now().to_rfc3339(), normalized_path, agent_id],
        )?;
        
        Ok(())
    }
    
    // 新增: 释放锁
    pub fn release_lock(
        &self,
        file_path: &str,
        agent_id: &str,
    ) -> Result<(), ErgataiError> {
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_locks SET status = 'EXPIRED', updated_at = ?1
             WHERE file_path = ?2 AND agent_id = ?3 AND status = 'ACTIVE'",
            params![Utc::now().to_rfc3339(), normalized_path, agent_id],
        )?;
        
        Ok(())
    }
    
    // 新增: PID 查询
    pub fn get_agent_by_pid(&self, pid: u32) -> Option<String> {
        self.pid_to_agent.read().get(&pid).cloned()
    }
    
    // 新增: 权限检查
    pub fn check_permission(
        &self,
        file_path: &str,
        pid: u32,
    ) -> Result<PermissionResult, ErgataiError> {
        let agent_id = match self.get_agent_by_pid(pid) {
            Some(id) => id,
            None => return Ok(PermissionResult::Denied {
                reason: format!("Unknown PID: {}", pid),
            }),
        };
        
        let normalized_path = self.validate_and_normalize_path(file_path)?;
        let conn = self.conn.lock();
        
        let has_lock: bool = conn.query_row(
            "SELECT COUNT(*) > 0 FROM file_locks
             WHERE file_path = ?1 AND agent_id = ?2 AND status = 'ACTIVE'",
            params![normalized_path, agent_id],
            |row| row.get(0),
        )?;
        
        if has_lock {
            Ok(PermissionResult::Allowed)
        } else {
            Ok(PermissionResult::Denied {
                reason: format!("Agent {} does not have lock for {}", agent_id, file_path),
            })
        }
    }
}
```

#### 3.2.3 更新 manager.rs

```rust
// crates/ergatai-lock/src/manager.rs

pub async fn init_file_access(
    project_id: &str,
    project_root: &Path,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增参数
) -> ErgataiResult<()> {
    // 创建 FileLockManager (传入 pid_to_agent)
    let lock_manager = FileLockManager::new(&lock_db_path, project_root.to_path_buf(), pid_to_agent)?;
    
    // ... 其他初始化逻辑
    
    Ok(())
}

// 删除: init_file_access_with_enforcer()
```

#### 3.2.4 测试

```rust
#[test]
fn test_lock_lifecycle() {
    let pid_to_agent = Arc::new(RwLock::new(HashMap::new()));
    pid_to_agent.write().insert(1234, "agent-1".to_string());
    
    let manager = FileLockManager::new(&db_path, project_root, pid_to_agent).unwrap();
    
    // 创建锁
    manager.acquire_lock("src/auth.rs", "agent-1").unwrap();
    
    // 检查权限
    assert!(matches!(manager.check_permission("src/auth.rs", 1234).unwrap(), PermissionResult::Allowed));
    assert!(matches!(manager.check_permission("src/auth.rs", 5678).unwrap(), PermissionResult::Denied { .. }));
    
    // 更新 hash
    manager.update_file_hash("src/auth.rs", "agent-1").unwrap();
    
    // 释放锁
    manager.release_lock("src/auth.rs", "agent-1").unwrap();
    
    // 验证锁已释放
    assert!(matches!(manager.check_permission("src/auth.rs", 1234).unwrap(), PermissionResult::Denied { .. }));
}
```

### 3.3 阶段 3: 文件系统监控 (3-4 天)

#### 3.3.1 创建 FileMonitor

```rust
// crates/ergatai-lock/src/monitor.rs

use notify::{Watcher, RecursiveMode, Event, EventKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct FileMonitor {
    lock_manager: Arc<FileLockManager>,
    project_root: PathBuf,
    watcher: notify::RecommendedWatcher,
    event_rx: crossbeam_channel::Receiver<notify::Result<Event>>,
}

impl FileMonitor {
    pub fn new(
        lock_manager: Arc<FileLockManager>,
        project_root: PathBuf,
    ) -> Result<Self, ErgataiError> {
        let (tx, rx) = crossbeam_channel::unbounded();
        
        let watcher = notify::recommended_watcher(move |res| {
            tx.send(res).unwrap();
        })?;
        
        Ok(Self {
            lock_manager,
            project_root,
            watcher,
            event_rx: rx,
        })
    }
    
    pub fn start(&mut self) -> Result<(), ErgataiError> {
        // 监控项目目录
        self.watcher.watch(&self.project_root, RecursiveMode::Recursive)?;
        
        // 启动事件处理循环
        let lock_manager = self.lock_manager.clone();
        let event_rx = self.event_rx.clone();
        
        std::thread::spawn(move || {
            for res in event_rx {
                match res {
                    Ok(event) => {
                        if let Err(e) = Self::handle_event(&lock_manager, event) {
                            tracing::error!("Failed to handle file event: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("File monitor error: {}", e);
                    }
                }
            }
        });
        
        Ok(())
    }
    
    fn handle_event(
        lock_manager: &Arc<FileLockManager>,
        event: Event,
    ) -> Result<(), ErgataiError> {
        // 只处理修改事件
        if !matches!(event.kind, EventKind::Modify(_)) {
            return Ok(());
        }
        
        let file_path = match event.paths.first() {
            Some(path) => path,
            None => return Ok(()),
        };
        
        // 获取修改者的 PID
        // 注意: notify crate 不提供 PID，需要平台特定实现
        // 这里先用简化方案: 假设可以获取 PID
        let pid = Self::get_modifier_pid(file_path)?;
        
        // 检查权限
        match lock_manager.check_permission(file_path, pid)? {
            PermissionResult::Allowed => {
                let agent_id = lock_manager.get_agent_by_pid(pid).unwrap();
                lock_manager.update_file_hash(file_path, &agent_id)?;
                tracing::debug!("Updated hash for {} by {}", file_path.display(), agent_id);
            }
            PermissionResult::Denied { reason } => {
                // 回退文件
                Self::rollback_file(lock_manager, file_path)?;
                
                // 记录违规
                Self::log_violation(lock_manager, pid, file_path, &reason)?;
                
                tracing::warn!("Violation detected: {}", reason);
            }
        }
        
        Ok(())
    }
    
    // 平台特定: 获取修改者的 PID
    #[cfg(target_os = "linux")]
    fn get_modifier_pid(file_path: &Path) -> Result<u32, ErgataiError> {
        // Linux: 通过 /proc/{pid}/fd 反向查找
        // 这里简化: 遍历所有 /proc/{pid}/fd，找到指向 file_path 的
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let pid_str = entry.file_name();
            if let Ok(pid) = pid_str.to_string_lossy().parse::<u32>() {
                let fd_dir = format!("/proc/{}/fd", pid);
                if let Ok(fds) = std::fs::read_dir(&fd_dir) {
                    for fd in fds {
                        if let Ok(fd) = fd {
                            if let Ok(link) = std::fs::read_link(fd.path()) {
                                if link == file_path {
                                    return Ok(pid);
                                }
                            }
                        }
                    }
                }
            }
        }
        
        Err(ErgataiError::internal("Could not find PID for file modifier"))
    }
    
    #[cfg(not(target_os = "linux"))]
    fn get_modifier_pid(_file_path: &Path) -> Result<u32, ErgataiError> {
        // 其他平台: 暂不支持，返回错误
        // 后续可以用 tool_calls 追踪替代
        Err(ErgataiError::internal("PID detection not supported on this platform"))
    }
    
    fn rollback_file(
        lock_manager: &Arc<FileLockManager>,
        file_path: &Path,
    ) -> Result<(), ErgataiError> {
        // 从 DB 读取 current_hash
        // 从 Git 对象存储恢复文件
        // 这里简化: 直接删除文件 (实际应该从快照恢复)
        std::fs::remove_file(file_path)?;
        tracing::info!("Rolled back file: {}", file_path.display());
        Ok(())
    }
    
    fn log_violation(
        lock_manager: &Arc<FileLockManager>,
        pid: u32,
        file_path: &Path,
        reason: &str,
    ) -> Result<(), ErgataiError> {
        // 记录到审计日志
        lock_manager.log_audit(
            "VIOLATION",
            file_path.to_string_lossy().as_ref(),
            reason,
        )?;
        Ok(())
    }
}
```

#### 3.3.2 集成到 manager.rs

```rust
// crates/ergatai-lock/src/manager.rs

pub async fn init_file_access(
    project_id: &str,
    project_root: &Path,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
) -> ErgataiResult<()> {
    let lock_manager = FileLockManager::new(&lock_db_path, project_root.to_path_buf(), pid_to_agent.clone())?;
    let lock_manager = Arc::new(lock_manager);
    
    // 启动文件监控
    let mut monitor = FileMonitor::new(lock_manager.clone(), project_root.to_path_buf())?;
    monitor.start()?;
    
    // 存储到全局状态
    manager.projects.insert(
        project_id.to_string(),
        ProjectFileAccess {
            lock_manager,
            monitor: Some(monitor),  // 新增
            // ...
        },
    );
    
    Ok(())
}
```

#### 3.3.3 测试

```rust
#[tokio::test]
async fn test_file_monitor() {
    // 启动监控
    let monitor = FileMonitor::new(lock_manager.clone(), project_root.clone()).unwrap();
    monitor.start().unwrap();
    
    // 创建锁
    lock_manager.acquire_lock("test.txt", "agent-1").unwrap();
    
    // 修改文件 (模拟 agent-1)
    std::fs::write(project_root.join("test.txt"), "new content").unwrap();
    
    // 验证 hash 已更新
    tokio::time::sleep(Duration::from_millis(100)).await;  // 等待监控处理
    let lock = lock_manager.get_lock("test.txt").unwrap();
    assert_eq!(lock.version, 2);
    
    // 修改文件 (模拟未知 agent)
    // 验证文件被回退
}
```

### 3.4 阶段 4: 提示词注入 (1 天)

#### 3.4.1 修改 AcpBackend::launch_agent()

```rust
async fn launch_agent(&self, spec: WorkspaceSpec) -> ErgataiResult<AgentHandle> {
    // ... 启动 agent (同 3.1.2)
    
    // 分配文件 (从 spec 或 DAG 任务获取)
    let allowed_files = spec.allowed_files.clone();
    
    // 创建 .ergatai/locks/{agent_id}.json
    let lock_info = serde_json::json!({
        "agent_id": agent_id,
        "allowed_files": allowed_files,
        "created_at": Utc::now().to_rfc3339(),
    });
    
    let lock_file_path = spec.work_dir.join(".ergatai/locks").join(format!("{}.json", agent_id));
    std::fs::create_dir_all(lock_file_path.parent().unwrap())?;
    std::fs::write(&lock_file_path, serde_json::to_string_pretty(&lock_info)?)?;
    
    // 为每个文件创建锁
    for file in &allowed_files {
        self.lock_manager.acquire_lock(file, &agent_id)?;
    }
    
    // 注入提示词
    let prompt = format!(
        "You are working in a multi-agent environment.\n\
         You may ONLY modify these files:\n{}\n\
         Baseline info: {}\n\
         Do NOT modify any other files. Violations will be detected and reverted.",
        allowed_files.join("\n"),
        lock_file_path.display()
    );
    
    // 通过 ACP session/prompt 注入
    connection.send_request(PromptRequest::new(vec![ContentBlock::Text(TextContent::new(prompt))])).await?;
    
    Ok(handle)
}
```

### 3.5 阶段 5: 集成测试 (2 天)

#### 3.5.1 端到端测试

```rust
#[tokio::test]
async fn test_multi_agent_file_locks() {
    // 启动两个 agent
    let backend = AcpBackend::new();
    
    let spec_a = WorkspaceSpec {
        id: "ws-a".to_string(),
        allowed_files: vec!["src/auth.rs".to_string()],
        // ...
    };
    
    let spec_b = WorkspaceSpec {
        id: "ws-b".to_string(),
        allowed_files: vec!["src/dashboard.rs".to_string()],
        // ...
    };
    
    let handle_a = backend.launch_agent(spec_a).await.unwrap();
    let handle_b = backend.launch_agent(spec_b).await.unwrap();
    
    // Agent A 修改 src/auth.rs (应该成功)
    backend.inject_message(&handle_a, "Modify src/auth.rs").await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    // 验证 hash 已更新
    
    // Agent B 修改 src/auth.rs (应该被阻止)
    backend.inject_message(&handle_b, "Modify src/auth.rs").await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    // 验证文件被回退，违规日志已记录
    
    // 清理
    backend.stop_agent(&handle_a).await.unwrap();
    backend.stop_agent(&handle_b).await.unwrap();
}
```

---

## 4. 数据结构

### 4.1 数据库表

```sql
-- 文件锁 (简化版)
CREATE TABLE file_locks (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL,
    violation_count INTEGER DEFAULT 0,
    
    UNIQUE(file_path) WHERE status = 'ACTIVE'
);

-- 审计日志
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    action TEXT NOT NULL,
    file_path TEXT,
    reason TEXT
);

-- 文件快照 (可选)
CREATE TABLE file_snapshots (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    hash TEXT NOT NULL,
    git_ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
);
```

### 4.2 内存结构

```rust
// AcpBackend
pub struct AcpBackend {
    agents: RwLock<HashMap<String, AcpAgentEntry>>,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
    agent_children: Arc<RwLock<HashMap<String, async_process::Child>>>,
    // ...
}

// FileLockManager
pub struct FileLockManager {
    conn: Arc<Mutex<Connection>>,
    project_root: PathBuf,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,
    // ...
}

// FileMonitor
pub struct FileMonitor {
    lock_manager: Arc<FileLockManager>,
    project_root: PathBuf,
    watcher: notify::RecommendedWatcher,
    // ...
}
```

---

## 5. API 变更

### 5.1 新增 API

```rust
// FileLockManager
pub fn acquire_lock(&self, file_path: &str, agent_id: &str) -> Result<(), ErgataiError>;
pub fn update_file_hash(&self, file_path: &str, agent_id: &str) -> Result<(), ErgataiError>;
pub fn release_lock(&self, file_path: &str, agent_id: &str) -> Result<(), ErgataiError>;
pub fn get_agent_by_pid(&self, pid: u32) -> Option<String>;
pub fn check_permission(&self, file_path: &str, pid: u32) -> Result<PermissionResult, ErgataiError>;

// AcpBackend
pub fn get_agent_by_pid(&self, pid: u32) -> Option<String>;
```

### 5.2 删除 API

```rust
// FileLockManager (删除)
pub async fn auto_acquire_write_lock(...) -> Result<(), ErgataiError>;
pub fn check_file_lock_status(...) -> Result<(bool, Option<(String, String)>), ErgataiError>;
pub fn has_write_lock(...) -> Result<bool, ErgataiError>;

// manager.rs (删除)
pub async fn init_file_access_with_enforcer(...) -> ErgataiResult<()>;
```

### 5.3 修改 API

```rust
// manager.rs
pub async fn init_file_access(
    project_id: &str,
    project_root: &Path,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增参数
) -> ErgataiResult<()>;

// FileLockManager::new()
pub fn new(
    db_path: &Path,
    project_root: PathBuf,
    pid_to_agent: Arc<RwLock<HashMap<u32, String>>>,  // 新增参数
) -> Result<Self, ErgataiError>;
```

---

## 6. 迁移策略

### 6.1 分阶段实施

1. **阶段 1**: ACP 启动重构 (无破坏性变更)
   - 添加 PID 追踪
   - 保留现有锁逻辑
   
2. **阶段 2**: 文件锁简化 (破坏性变更)
   - 删除 fanotify/LD_PRELOAD
   - 实现新的锁 API
   
3. **阶段 3**: 文件系统监控 (新增功能)
   - 实现 FileMonitor
   - 集成违规检测
   
4. **阶段 4**: 提示词注入 (增强功能)
   - 注入文件限制提示
   
5. **阶段 5**: 集成测试
   - 端到端测试
   - 性能测试

### 6.2 向后兼容

- 阶段 1 完全向后兼容
- 阶段 2-5 会删除旧 API，需要更新调用方
- 提供迁移指南文档

---

## 7. 风险与缓解

### 7.1 风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| PID 获取失败 | 无法检测违规 | 降级为 tool_calls 追踪 |
| 文件监控延迟 | 违规文件已被修改 | 快速回退 + 审计日志 |
| Agent 不遵守提示词 | 频繁违规 | 优化任务分配，减少冲突 |
| Hash 冲突 | 误判 | 使用 SHA-256，概率极低 |
| 性能问题 | 文件监控开销大 | 只监控活跃 agent 的文件 |

### 7.2 缓解策略

1. **渐进式部署**: 先在测试环境验证，再逐步推广
2. **监控指标**: 记录违规次数、回退次数、性能指标
3. **快速回滚**: 保留旧代码分支，出问题可快速回滚
4. **文档完善**: 详细的使用指南和故障排查手册

---

## 8. 时间估算

| 阶段 | 任务 | 预估时间 |
|------|------|----------|
| 阶段 1 | ACP 启动重构 | 2-3 天 |
| 阶段 2 | 文件锁简化 | 2-3 天 |
| 阶段 3 | 文件系统监控 | 3-4 天 |
| 阶段 4 | 提示词注入 | 1 天 |
| 阶段 5 | 集成测试 | 2 天 |
| **总计** | - | **10-13 天** |

---

## 9. 下一步

1. **评审设计文档**: 团队评审，收集反馈
2. **创建原型**: 验证 spawn_process() 可行性
3. **开始阶段 1**: ACP 启动重构
4. **持续集成**: 每个阶段完成后合并到主分支

---

## 附录

### A. 相关代码位置

- ACP SDK: `docs/acp/rust-sdk/src/agent-client-protocol/src/acp_agent.rs`
- AcpBackend: `crates/ergatai-runtime/src/backends/acp.rs`
- FileLockManager: `crates/ergatai-lock/src/lock_manager.rs`
- Manager: `crates/ergatai-lock/src/manager.rs`

### B. 参考资料

- ACP SDK 文档: `docs/acp/rust-sdk/md/`
- notify crate: https://docs.rs/notify
- inotify (Linux): https://man7.org/linux/man-pages/man7/inotify.7.html
