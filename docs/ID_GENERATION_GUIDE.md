# ID 生成模块使用指南

## 概述

`ergatai-core::id` 模块提供了统一的 ID 生成系统，使用 Snowflake 算法生成有序、紧凑、可解析的 64-bit 整数 ID。

## 特性

- ✅ **有序性**：基于时间戳，适合 B-tree 索引
- ✅ **紧凑性**：64-bit 整数（原始 i64 为 8 bytes；格式化字符串约 25 bytes vs UUID 的 36 bytes）
- ✅ **可解析**：包含类型、时间戳、实例 ID 和序列号
- ✅ **可排序**：按创建时间自然排序
- ✅ **可读性**：格式化版本包含类型前缀

## 快速开始

### 1. 初始化（应用启动时调用一次）

```rust
use ergatai_core::id::init;

// 在 main.rs 或应用启动时调用
// instance_id: 0-1023，不同进程使用不同值
init(1);
```

### 2. 生成 ID

```rust
use ergatai_core::id::generate;

// 生成 64-bit 整数 ID（用于数据库存储）
let message_id = generate();
let conversation_id = generate();
```

### 3. 格式化 ID（用于日志/API）

```rust
use ergatai_core::id::{generate, format, IdType};

let id = generate();
let formatted = format(id, IdType::Message);
// 输出: "msg_367597485448_001_0001"
//       {type}_{timestamp}_{instance}_{sequence}
```

### 4. 解析 ID

```rust
use ergatai_core::id::{format, generate, parse, IdType};

let id = generate();
let formatted = format(id, IdType::Conversation);

if let Some((id_type, timestamp, instance, sequence)) = parse(&formatted) {
    println!("Type: {:?}", id_type);      // IdType::Conversation
    println!("Timestamp: {}", timestamp);  // 毫秒时间戳
    println!("Instance: {}", instance);    // 实例 ID
    println!("Sequence: {}", sequence);    // 序列号
}
```

### 5. 提取 ID 组件

```rust
use ergatai_core::id::{extract_instance, extract_sequence, extract_timestamp, generate};

let id = generate();

let timestamp = extract_timestamp(id);  // 毫秒时间戳
let instance = extract_instance(id);    // 实例 ID (0-1023)
let sequence = extract_sequence(id);    // 序列号 (0-4095)
```

## ID 类型

| 类型 | 前缀 | 用途 |
|------|------|------|
| `Message` | `msg` | Agent 间消息 |
| `Conversation` | `conv` | 对话追踪 |
| `Chat` | `chat` | 用户聊天会话 |
| `Lock` | `lock` | 文件锁 |
| `Snapshot` | `snap` | Git COW 快照 |
| `Permission` | `perm` | 权限请求 |
| `Session` | `sess` | 会话 |
| `Agent` | `agent` | Agent |
| `Workspace` | `ws` | Workspace |
| `Dag` | `dag` | DAG 编排 |
| `Task` | `task` | DAG 节点 |

## 数据库集成

### SQLite 表设计

```sql
-- 消息表
CREATE TABLE messages (
    id INTEGER PRIMARY KEY,           -- 雪花 ID（64-bit 整数）
    type TEXT NOT NULL,               -- "msg", "conv" 等
    from_agent TEXT,
    to_agent TEXT,
    content TEXT,
    created_at INTEGER NOT NULL,      -- 冗余时间戳，便于查询
    ...
);

-- 创建索引（整数主键，自动有序）
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_messages_agents ON messages(from_agent, to_agent);
```

### Rust 代码示例

```rust
use ergatai_core::id::{generate, format, IdType};
use rusqlite::Connection;

fn insert_message(conn: &Connection, content: &str) -> Result<(), rusqlite::Error> {
    // 生成 ID
    let id = generate();
    let formatted_id = format(id, IdType::Message);
    
    // 提取时间戳
    let created_at = ergatai_core::id::extract_timestamp(id);
    
    // 插入数据库
    conn.execute(
        "INSERT INTO messages (id, type, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, "msg", content, created_at],
    )?;
    
    println!("Inserted message with ID: {}", formatted_id);
    Ok(())
}
```

## 迁移现有代码

### 从 UUID 迁移

**之前**：
```rust
use uuid::Uuid;

let message_id = Uuid::new_v4().to_string();  // "550e8400-e29b-41d4-a716-446655440000"
```

**之后**：
```rust
use ergatai_core::id::{generate, format, IdType};

let message_id = generate();  // 64-bit 整数
let formatted = format(message_id, IdType::Message);  // "msg_367597485448_001_0001"
```

### 从自定义格式迁移

**之前**：
```rust
fn generate_message_id() -> String {
    format!("msg_{}", uuid::Uuid::new_v4())
}
```

**之后**：
```rust
use ergatai_core::id::{generate, format, IdType};

let message_id = generate();
let formatted = format(message_id, IdType::Message);
```

## 性能对比

| 方案 | 存储空间 | 索引性能 | 可读性 | 有序性 |
|------|---------|---------|--------|--------|
| UUID v4（字符串） | 36 bytes | 差（无序） | 差 | ❌ |
| ULID（字符串） | 26 bytes | 良 | 中 | ✅ |
| **Snowflake（格式化字符串，当前实现）** | **~25 bytes** | **优** | **优** | **✅** |
| Snowflake（原始 i64，可选） | 8 bytes | **优** | 差 | **✅** |

**存储节省说明**：
- 当前实现存储格式化字符串（如 `"msg_367597485448_001_0001"`），实际节省约 **30%**（25 bytes vs 36 bytes）
- 如果数据库使用 `INTEGER` 类型存储原始 i64，理论上可节省 **78%**（8 bytes vs 36 bytes）
- 格式化字符串便于调试和日志可读性；原始 i64 适合纯存储优化场景

## 最佳实践

1. **初始化一次**：在应用启动时调用 `init(instance_id)`
2. **使用整数存储**：数据库中使用 `INTEGER` 或 `BIGINT` 存储 ID
3. **格式化用于日志**：仅在日志/API 响应中使用 `format()` 函数
4. **提取时间戳**：使用 `extract_timestamp()` 获取创建时间
5. **不同实例不同 ID**：分布式部署时，每个实例使用不同的 `instance_id`

## 线程安全

`snowdon` 库保证线程安全和无锁并发。多个线程可以同时调用 `generate()` 而不会产生重复 ID。

```rust
use std::thread;
use ergatai_core::id::{generate, init};

init(1);

let handles: Vec<_> = (0..10)
    .map(|_| {
        thread::spawn(move || {
            (0..1000).map(|_| generate()).collect::<Vec<_>>()
        })
    })
    .collect();

let all_ids: Vec<_> = handles
    .into_iter()
    .flat_map(|h| h.join().unwrap())
    .collect();

// 所有 10000 个 ID 都是唯一的
assert_eq!(all_ids.len(), 10000);
```

## 故障排除

### 问题：生成的 ID 不是唯一的

**解决方案**：确保在分布式环境中每个实例使用不同的 `instance_id`。

### 问题：时间戳看起来不对

**解决方案**：Snowflake 使用 Twitter epoch（2010-11-04），不是 UNIX epoch。使用 `extract_timestamp()` 获取原始时间戳，然后加上 Twitter epoch 偏移量转换为 UNIX 时间戳。

### 问题：instance_id 超出范围

**解决方案**：`instance_id` 必须在 0-1023 范围内。如果超出，会自动取模（`instance_id & 0x3FF`）。

## 参考资料

- [Twitter Snowflake](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake)
- [snowdon crate](https://crates.io/crates/snowdon)
- [ergatai-core::id 文档](https://docs.rs/ergatai-core/latest/ergatai_core/id/)
