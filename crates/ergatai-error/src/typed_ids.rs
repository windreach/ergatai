//! 强类型 ID 定义
//!
//! 提供类型安全的 ID 包装器，替代裸 i64 和 String。

use crate::id::{format as format_id, generate, parse_to_i64_with_type, IdType};
use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, Value, ValueRef};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

/// 宏：定义 ID 强类型
///
/// 为每个 ID 类型生成：
/// - 结构体定义（newtype pattern）
/// - Display/FromStr（格式化/解析）
/// - ToSql/FromSql（SQLite）
/// - Serialize/Deserialize（JSON）
/// - Hash/Eq/Clone/Copy（基础 trait）
macro_rules! define_id_type {
    ($name:ident, $id_type:expr, $prefix:expr) => {
        /// 强类型 ID 包装器
        ///
        /// 内部存储为 i64（Snowflake 算法），按创建时间排序。
        /// API 边界使用字符串格式（如 `conv_12345_001_0001`）。
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(i64);

        impl $name {
            /// 从原始 i64 创建
            ///
            /// # Warning
            /// 此方法不验证输入值。负数或 0 会导致 `encode()` 输出 `{prefix}_invalid_0_0`。
            /// 对于外部输入，请使用 `decode()` 或 `FromStr::from_str()`。
            pub fn new(raw: i64) -> Self {
                Self(raw)
            }

            /// 生成新的 ID
            pub fn generate() -> Self {
                Self(generate())
            }

            /// 获取原始 i64 值
            #[inline]
            pub fn as_i64(&self) -> i64 {
                self.0
            }

            /// 格式化为字符串（用于 API 响应、日志）
            pub fn encode(&self) -> String {
                format_id(self.0, $id_type)
            }

            /// 从字符串解析（用于 API 请求）
            pub fn decode(s: &str) -> Result<Self, IdParseError> {
                let raw = parse_to_i64_with_type(s, $id_type)
                    .ok_or_else(|| IdParseError::InvalidFormat {
                        expected_type: $prefix,
                        actual: s.to_string(),
                    })?;
                Ok(Self(raw))
            }
        }

        // Display: 格式化为带前缀的字符串
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.encode())
            }
        }

        // OpenAPI schema (serialized as a prefixed string)
        impl utoipa::PartialSchema for $name {
            fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
                String::schema()
            }
        }

        impl utoipa::ToSchema for $name {}

        // FromStr: 从字符串解析
        impl FromStr for $name {
            type Err = IdParseError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::decode(s)
            }
        }

        // ToSql: SQLite 写入
        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                Ok(ToSqlOutput::Owned(Value::Integer(self.0)))
            }
        }

        // FromSql: SQLite 读取
        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                match value {
                    ValueRef::Integer(i) => Ok(Self(i)),
                    _ => Err(rusqlite::types::FromSqlError::InvalidType),
                }
            }
        }

        // Serialize: JSON 序列化为字符串
        impl Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                serializer.serialize_str(&self.encode())
            }
        }

        // Deserialize: JSON 从字符串或数字反序列化（向后兼容）
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                use serde::de::{Error, Visitor};

                struct IdVisitor;

                impl<'de> Visitor<'de> for IdVisitor {
                    type Value = $name;

                    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                        formatter.write_str(&format!(
                            "a string like \"{}_<timestamp>_<instance>_<sequence>\" or a number",
                            $prefix
                        ))
                    }

                    // 支持字符串格式: "conv_123_001_0001"
                    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
                    where
                        E: Error,
                    {
                        $name::decode(value).map_err(E::custom)
                    }

                    // 支持数字格式: 1234567890 (向后兼容旧数据)
                    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E>
                    where
                        E: Error,
                    {
                        Ok($name::new(value))
                    }

                    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
                    where
                        E: Error,
                    {
                        if value > i64::MAX as u64 {
                            Err(E::custom(format!("u64 value {} exceeds i64::MAX", value)))
                        } else {
                            Ok($name::new(value as i64))
                        }
                    }
                }

                deserializer.deserialize_any(IdVisitor)
            }
        }

        // From<i64>: 允许从 i64 转换
        impl From<i64> for $name {
            fn from(raw: i64) -> Self {
                Self(raw)
            }
        }

        // From<$name> for i64: 允许转换为 i64
        impl From<$name> for i64 {
            fn from(id: $name) -> Self {
                id.0
            }
        }
    };
}

// ============================================================================
// ID 类型定义
// ============================================================================

define_id_type!(ConversationId, IdType::Conversation, "conv");
define_id_type!(MessageId, IdType::Message, "msg");
define_id_type!(WorkspaceId, IdType::Workspace, "ws");
define_id_type!(ChatId, IdType::Chat, "chat");
define_id_type!(AgentId, IdType::Agent, "agent");
// 注意：这里使用 CollaborationSessionId 而不是 SessionId，避免与 agent_client_protocol::SessionId 冲突
define_id_type!(CollaborationSessionId, IdType::Session, "sess");
define_id_type!(LockId, IdType::Lock, "lock");
define_id_type!(SnapshotId, IdType::Snapshot, "snap");
define_id_type!(PermissionId, IdType::Permission, "perm");
define_id_type!(DagId, IdType::Dag, "dag");
define_id_type!(TaskId, IdType::Task, "task");
define_id_type!(CheckpointId, IdType::Checkpoint, "ckpt");
define_id_type!(ProjectId, IdType::Project, "proj");

// ============================================================================
// 错误类型
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdParseError {
    /// 格式无效
    InvalidFormat {
        expected_type: &'static str,
        actual: String,
    },
}

impl fmt::Display for IdParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IdParseError::InvalidFormat {
                expected_type,
                actual,
            } => {
                write!(
                    f,
                    "Invalid {} ID format: '{}' (expected {}_{{timestamp}}_{{instance}}_{{sequence}})",
                    expected_type, actual, expected_type
                )
            }
        }
    }
}

impl std::error::Error for IdParseError {}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conversation_id_roundtrip() {
        let id = ConversationId::generate();
        let encoded = id.encode();
        let decoded = ConversationId::decode(&encoded).unwrap();
        assert_eq!(id, decoded);
    }

    #[test]
    fn test_conversation_id_display() {
        let id = ConversationId::new(1234567890);
        let s = id.to_string();
        assert!(s.starts_with("conv_"));
    }

    #[test]
    fn test_conversation_id_from_str() {
        let id = ConversationId::generate();
        let s = id.to_string();
        let parsed: ConversationId = s.parse().unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn test_conversation_id_type_validation() {
        // 生成一个 conversation ID
        let conv_id = ConversationId::generate();
        let s = conv_id.to_string();

        // 应该能解析为 ConversationId
        assert!(ConversationId::decode(&s).is_ok());

        // 不应该能解析为 MessageId（类型不匹配）
        assert!(MessageId::decode(&s).is_err());
    }

    #[test]
    fn test_conversation_id_sqlite() {
        let id = ConversationId::new(12345);

        // ToSql
        let sql_val = id.to_sql().unwrap();
        match sql_val {
            ToSqlOutput::Owned(Value::Integer(i)) => assert_eq!(i, 12345),
            _ => panic!("Expected Integer"),
        }

        // FromSql
        let value_ref = ValueRef::Integer(12345);
        let parsed = ConversationId::column_result(value_ref).unwrap();
        assert_eq!(parsed, id);
    }

    #[test]
    fn test_conversation_id_json() {
        let id = ConversationId::generate();

        // Serialize
        let json = serde_json::to_string(&id).unwrap();
        assert!(json.starts_with("\"conv_"));

        // Deserialize
        let parsed: ConversationId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, parsed);
    }

    #[test]
    fn test_conversation_id_hashmap() {
        use std::collections::HashMap;

        let mut map = HashMap::new();
        let id1 = ConversationId::generate();
        let id2 = ConversationId::generate();

        map.insert(id1, "agent1");
        map.insert(id2, "agent2");

        assert_eq!(map.get(&id1), Some(&"agent1"));
        assert_eq!(map.get(&id2), Some(&"agent2"));
    }

    #[test]
    fn test_conversation_id_conversion() {
        let raw: i64 = 12345;

        // i64 -> ConversationId
        let id: ConversationId = raw.into();
        assert_eq!(id.as_i64(), 12345);

        // ConversationId -> i64
        let back: i64 = id.into();
        assert_eq!(back, 12345);
    }
}
