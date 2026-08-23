# Task A - 详细任务描述

## 目标
实现一个简单的计数器功能，用于演示多 agent 协作。

## 具体要求

### 功能需求
1. 创建一个计数器模块，支持以下操作：
   - `increment()`: 计数器加 1
   - `decrement()`: 计数器减 1
   - `get_value()`: 获取当前值
   - `reset()`: 重置为 0

2. 使用 Rust 实现，确保线程安全（使用 `Arc<Mutex<i32>>` 或类似机制）

3. 编写单元测试，覆盖所有操作

### 技术约束
- 使用 Rust 2021 edition
- 遵循项目的代码规范
- 文件放在 `examples/counter/` 目录下

### 交付物
1. `examples/counter/mod.rs` - 计数器模块实现
2. `examples/counter/tests.rs` - 单元测试
3. `examples/counter/README.md` - 使用说明

## 验收标准
- 所有单元测试通过
- 代码通过 `cargo clippy` 检查
- 文档清晰完整

## 注意事项
- 确保并发安全
- 考虑错误处理
- 代码要有适当的注释
