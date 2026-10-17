# 废弃锁机制清理提案

**日期**: 2026-10-10  
**状态**: 提案阶段  
**作者**: AI Assistant (Code Review)

---

## 📋 背景

Ergatai 的文件锁机制已经从 **显式权限控制** 演进为 **ACP 权限预锁定** 架构。当前实现中存在多个已废弃的代码路径，这些代码：

1. **不再使用** - 主流程已切换到 ACP 权限预锁定
2. **容易误导** - 新开发者可能误以为这些是活跃代码
3. **增加维护成本** - 需要理解和测试这些废弃路径
4. **文档不符** - 代码注释和实际行为不一致

---

## 🎯 当前正确的锁架构

### 主流程 (应该保留)

```
Agent 调用工具 (Edit/Delete/Move/Execute)
    ↓
ACP 生成 RequestPermissionRequest
    ↓
InteractivePermissionHandler.evaluate()
    ↓
try_pre_lock_files() ← 工具执行前预锁定
    ↓
lock_mgr.try_acquire_write_lock_preemptive()
    ↓
├─ 成功 → 允许工具执行
└─ 冲突 → 拒绝工具调用
    ↓
工具执行 (已持有锁)
    ↓
工具完成 → 释放锁
```

**关键文件**:
- `crates/ergatai-runtime/src/permission.rs` - ACP 权限处理器
- `crates/ergatai-lock/src/manager.rs` - 预锁定实现
- `crates/ergatai-lock/src/lock_manager.rs` - 锁状态管理

---

## 🗑️ 应该删除的废弃代码

### 1. FileSystemWatcher 自动锁机制

**文件**: `crates/ergatai-lock/src/watcher.rs`

**原因**:
- ❌ 仅作为降级兜底存在，但降级场景极少发生
- ❌ 无法确定真实 Agent (agent_id="system")
- ❌ 事后检测，不是真正的互斥
- ❌ 跨平台行为不一致 (Linux vs macOS/Windows)
- ❌ 注释中明确标注为 "fallback"，但实际很少触发

**当前代码**:
```rust
// watcher.rs
pub struct FileSystemWatcher {
    // ...
}

impl FileSystemWatcher {
    fn auto_acquire_write_lock(&self, file_path: &Path) -> ErgataiResult<()> {
        let agent_id = SYSTEM_AGENT_ID; // "system" ← 无法确定真实 Agent
        let session_id = WATCHER_SESSION_ID; // "watcher"
        
        self.lock_manager.auto_acquire_write_lock(
            agent_id,
            session_id,
            file_path,
            &self.project_id,
        )
    }
}
```

**删除影响**: 
- ✅ 无负面影响 - 正常流程不会触发
- ✅ 简化代码库 - 移除 ~500 行代码
- ✅ 减少测试负担 - 不需要测试 Watcher 行为

**建议**: 删除整个 `watcher.rs` 文件，以及相关的初始化代码。

---

### 2. NATS 锁事件集成

**文件**: 
- `crates/ergatai-lock/src/nats_integration.rs` (如果存在)
- `crates/ergatai-nats/src/lock_events.rs` (如果存在)

**原因**:
- ❌ 锁现在是本地 SQLite 管理，不需要 NATS 分布式协调
- ❌ NATS 仅用于 Agent 间消息传递，不参与锁管理
- ❌ 代码中可能有 NATS 发布锁事件的逻辑，但已经不用

**检查点**:
```bash
# 搜索 NATS 锁相关代码
grep -r "nats.*lock\|lock.*nats" crates/ergatai-lock/
grep -r "lock_event\|LockEvent" crates/ergatai-nats/
```

**删除影响**:
- ✅ 无负面影响 - 锁管理已经是本地的
- ✅ 减少 NATS 依赖复杂度

**建议**: 删除所有 NATS 锁事件发布/订阅代码。

---

### 3. fanotify Enforcer (已标记废弃)

**文件**: `crates/ergatai-lock/src/enforcer/fanotify.rs` (或类似路径)

**原因**:
- ❌ 代码中已明确标注 `⚠️ DEPRECATED`
- ❌ 仅 Linux 支持，跨平台不一致
- ❌ 已被 ACP 权限预锁定完全替代
- ❌ 需要 CAP_SYS_ADMIN 权限，容器环境受限

**当前代码** (预期):
```rust
// enforcer/fanotify.rs
/// ⚠️ DEPRECATED: fanotify Enforcer
/// 
/// This enforcer uses Linux fanotify to intercept file access
/// and validate FileTokens. It has been superseded by ACP
/// permission-integrated pre-emptive locking.
pub struct FanotifyEnforcer {
    // ...
}
```

**删除影响**:
- ✅ 无负面影响 - 已经不再使用
- ✅ 减少 Linux 特定代码
- ✅ 移除 CAP_SYS_ADMIN 依赖说明

**建议**: 删除整个 fanotify enforcer 实现。

---

### 4. FileToken 零信任验证

**文件**: `crates/ergatai-lock/src/token.rs`

**原因**:
- ⚠️ **FileToken 结构本身保留** - 仍用于内部锁追踪
- ❌ **删除零信任验证逻辑** - 不再用于每次文件访问的 Token 验证
- ❌ 代码中可能有 `validate_token()` 等函数，但已不用

**检查点**:
```bash
# 搜索 Token 验证代码
grep -r "validate_token\|verify_token" crates/ergatai-lock/
```

**保留**:
- ✅ `FileToken` 结构定义
- ✅ Token 创建和管理 (用于内部追踪)
- ✅ Git 快照关联

**删除**:
- ❌ Token 验证逻辑 (如果存在)
- ❌ fanotify 集成代码 (引用 Token)

**建议**: 保留 Token 结构，删除验证和 fanotify 集成代码。

---

### 5. 事后冲突检测逻辑

**文件**: `crates/ergatai-lock/src/manager.rs` (部分函数)

**原因**:
- ❌ 预锁定已经实现真正的互斥
- ❌ 事后检测是降级方案，现在不需要
- ❌ 代码中可能有 `detect_conflicts_post_hoc()` 等函数

**检查点**:
```bash
# 搜索事后检测代码
grep -r "post_hoc\|after_modification\|detect_conflict" crates/ergatai-lock/src/manager.rs
```

**删除影响**:
- ✅ 无负面影响 - 预锁定已经足够
- ✅ 简化锁管理器逻辑

**建议**: 删除事后冲突检测相关函数。

---

## 📊 删除优先级

| 代码 | 优先级 | 理由 |
|------|--------|------|
| **fanotify Enforcer** | 🔴 高 | 已明确标记废弃，Linux 特定 |
| **FileSystemWatcher** | 🟡 中 | 降级兜底，但极少触发 |
| **NATS 锁事件** | 🟡 中 | 不参与锁管理，但可能不存在 |
| **FileToken 验证** | 🟢 低 | 可能已经清理过了 |
| **事后冲突检测** | 🟢 低 | 需要确认具体实现 |

---

## 🔍 清理步骤

### 第一阶段: 确认废弃代码

```bash
# 1. 搜索 fanotify 相关代码
find crates/ergatai-lock -name "*.rs" -exec grep -l "fanotify" {} \;

# 2. 搜索 FileSystemWatcher 使用
grep -r "FileSystemWatcher" crates/ --include="*.rs"

# 3. 搜索 NATS 锁事件
grep -r "lock.*event\|LockEvent" crates/ergatai-nats/ --include="*.rs"

# 4. 搜索事后检测
grep -r "post_hoc\|after_modification" crates/ergatai-lock/ --include="*.rs"
```

### 第二阶段: 删除代码

```bash
# 1. 删除 fanotify enforcer
rm crates/ergatai-lock/src/enforcer/fanotify.rs

# 2. 删除 FileSystemWatcher
rm crates/ergatai-lock/src/watcher.rs

# 3. 更新 mod.rs
# 编辑 crates/ergatai-lock/src/lib.rs 移除相关模块声明

# 4. 删除初始化代码
# 编辑相关启动代码，移除 Watcher/fanotify 初始化
```

### 第三阶段: 更新测试

```bash
# 1. 删除相关测试
find crates/ergatai-lock/tests -name "*watcher*" -delete
find crates/ergatai-lock/tests -name "*fanotify*" -delete

# 2. 更新集成测试
# 移除测试中对 Watcher 行为的断言

# 3. 运行测试
cargo test --package ergatai-lock
cargo test --package ergatai-runtime
```

### 第四阶段: 更新文档

```bash
# 1. 更新 README
# 移除 fanotify/FileSystemWatcher 相关说明

# 2. 更新架构文档
# 说明当前使用 ACP 权限预锁定

# 3. 添加迁移说明
# 如果有外部依赖，说明迁移路径
```

---

## ✅ 验证清单

删除后需要验证:

- [ ] `cargo build` 成功
- [ ] `cargo test` 全部通过
- [ ] 锁功能正常 (Edit/Delete/Move 工具互斥)
- [ ] 多 Agent 并发编辑正确锁定
- [ ] 锁冲突正确拒绝工具调用
- [ ] 无编译警告 (unused imports 等)
- [ ] 文档更新完成

---

## 📝 风险评估

### 低风险

- ✅ fanotify enforcer - 已标记废弃
- ✅ NATS 锁事件 - 应该不存在或已清理

### 中风险

- ⚠️ FileSystemWatcher - 需要确认降级场景是否真的会发生
  - **缓解措施**: 保留错误日志，监控降级触发频率

### 需要确认

- ❓ FileToken 验证逻辑 - 需要确认是否还有残留
- ❓ 事后冲突检测 - 需要确认具体实现和依赖

---

## 🎯 预期收益

### 代码质量

- ✅ **减少代码量** - 预计删除 1000-2000 行代码
- ✅ **简化架构** - 单一锁获取路径，易于理解
- ✅ **减少分支** - 移除降级路径的条件判断

### 维护成本

- ✅ **减少测试** - 不需要测试 Watcher/fanotify 行为
- ✅ **减少文档** - 不需要维护多套锁机制说明
- ✅ **减少依赖** - 移除 Linux 特定依赖 (fanotify)

### 开发者体验

- ✅ **更清晰的代码** - 新开发者不会被废弃代码误导
- ✅ **更少的困惑** - 不需要理解"为什么有两套锁机制"
- ✅ **更快的构建** - 减少编译时间 (虽然微小)

---

## 📚 相关文档

- [ACP 权限系统设计](./ACP_PERMISSION_DESIGN.md) (如果存在)
- [文件锁架构](./FILE_LOCK_ARCHITECTURE.md) (如果存在)
- [迁移指南](./MIGRATION_GUIDE.md) (如果存在)

---

## 🤔 开放问题

1. **FileSystemWatcher 真的不需要吗?**
   - 需要确认降级场景的实际触发频率
   - 如果从不触发，可以安全删除
   - 如果偶尔触发，需要保留或改进预锁定

2. **NATS 锁事件是否完全移除?**
   - 需要搜索确认是否存在
   - 如果存在，评估是否可以删除

3. **FileToken 的未来?**
   - 当前用于内部追踪，是否足够?
   - 是否需要进一步简化?

---

## 📞 下一步行动

1. **审查本文档** - 确认删除范围
2. **执行搜索** - 确认废弃代码位置
3. **创建 PR** - 分阶段删除代码
4. **测试验证** - 确保功能正常
5. **更新文档** - 反映新架构

---

**备注**: 本文档基于代码审查和架构理解生成，具体删除前需要确认代码实际使用情况。建议先在一个分支上尝试删除，验证无问题后再合并。
