//! State Channel — 定义节点间数据流的契约
//!
//! StateChannel 描述一个节点如何读取和写入共享状态。
//! 类似 LangGraph 的 state annotation，但适配 Ergatai 的进程级 agent 模型。
//!
//! # Example
//!
//! ```yaml
//! tasks:
//!   - name: review
//!     agent: reviewer
//!     task: tasks/review.md
//!     state_schema:
//!       name: review_state
//!       inputs:
//!         - name: code_path
//!           value_type: string
//!           required: true
//!       outputs:
//!         - name: review_result
//!           value_type: string
//!           required: true
//!         - name: issue_count
//!           value_type: number
//!           required: false
//! ```

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 状态值类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StateValueType {
    /// 字符串类型
    String,
    /// 数字类型（整数或浮点数）
    Number,
    /// 布尔类型
    Boolean,
    /// JSON object（自由结构）
    Object,
    /// JSON array
    Array,
}

impl std::fmt::Display for StateValueType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StateValueType::String => write!(f, "string"),
            StateValueType::Number => write!(f, "number"),
            StateValueType::Boolean => write!(f, "boolean"),
            StateValueType::Object => write!(f, "object"),
            StateValueType::Array => write!(f, "array"),
        }
    }
}

/// 单个状态字段的定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateField {
    /// 字段名（如 "review_result", "issue_count"）
    pub name: String,

    /// 值类型
    pub value_type: StateValueType,

    /// 是否必需（默认 false）
    #[serde(default)]
    pub required: bool,

    /// 默认值（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,

    /// 人类可读描述（可选）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 状态合并策略（当多个节点写入同一字段时）
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MergeStrategy {
    /// 后写覆盖（默认）
    #[default]
    Overwrite,

    /// 追加到数组（值必须是 array 类型）
    Append,

    /// 取最大值（数字类型）
    Max,

    /// 取最小值（数字类型）
    Min,

    /// 自定义合并（由 reducer 表达式定义）
    /// 表达式中可以使用 `existing` 和 `new` 变量
    Reducer {
        /// 合并表达式，如 "existing + new"
        expr: String,
    },
}

/// 状态通道：定义节点的输入/输出状态契约
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChannel {
    /// 通道名称（如 "review_state", "code_artifacts"）
    pub name: String,

    /// 输入字段（节点从 context 读取的）
    #[serde(default)]
    pub inputs: Vec<StateField>,

    /// 输出字段（节点写入 context 的）
    #[serde(default)]
    pub outputs: Vec<StateField>,

    /// 合并策略（每个字段的合并方式）
    #[serde(default)]
    pub merge_strategies: HashMap<String, MergeStrategy>,
}

impl StateChannel {
    /// 从 TaskNode 的 expected_outputs 自动推断 StateChannel
    ///
    /// 向后兼容：没有显式 state_schema 时，从 expected_outputs 生成
    pub fn from_expected_outputs(
        node_id: &str,
        expected_outputs: &HashMap<String, String>,
    ) -> Self {
        let outputs = expected_outputs
            .iter()
            .map(|(name, desc)| StateField {
                name: name.clone(),
                value_type: StateValueType::String, // 默认推断为 String
                required: false,
                default: None,
                description: Some(desc.clone()),
            })
            .collect();

        StateChannel {
            name: format!("{}_channel", node_id),
            inputs: Vec::new(),
            outputs,
            merge_strategies: HashMap::new(),
        }
    }

    /// 验证给定的 JSON 值是否符合此通道的输出定义
    ///
    /// # Returns
    ///
    /// - `Ok(())` — 所有必需字段存在且类型匹配
    /// - `Err(errors)` — 验证失败，返回所有错误信息
    pub fn validate_outputs(&self, values: &serde_json::Value) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        let obj = match values.as_object() {
            Some(o) => o,
            None => {
                errors.push("outputs must be a JSON object".to_string());
                return Err(errors);
            }
        };

        for field in &self.outputs {
            match obj.get(&field.name) {
                None if field.required => {
                    errors.push(format!("missing required field: {}", field.name));
                }
                Some(val) if !Self::check_type(val, &field.value_type) => {
                    errors.push(format!(
                        "field '{}' expected type {}, got {}",
                        field.name,
                        field.value_type,
                        val
                    ));
                }
                _ => {} // type OK or optional field missing
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// 检查 JSON 值是否符合指定的类型
    fn check_type(val: &serde_json::Value, expected: &StateValueType) -> bool {
        match expected {
            StateValueType::String => val.is_string(),
            StateValueType::Number => val.is_number(),
            StateValueType::Boolean => val.is_boolean(),
            StateValueType::Object => val.is_object(),
            StateValueType::Array => val.is_array(),
        }
    }

    /// 获取指定字段的合并策略
    pub fn merge_strategy_for(&self, field_name: &str) -> MergeStrategy {
        self.merge_strategies
            .get(field_name)
            .cloned()
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_validate_outputs_success() {
        let channel = StateChannel {
            name: "test_channel".to_string(),
            inputs: vec![],
            outputs: vec![
                StateField {
                    name: "result".to_string(),
                    value_type: StateValueType::String,
                    required: true,
                    default: None,
                    description: None,
                },
                StateField {
                    name: "count".to_string(),
                    value_type: StateValueType::Number,
                    required: false,
                    default: None,
                    description: None,
                },
            ],
            merge_strategies: HashMap::new(),
        };

        let values = json!({
            "result": "success",
            "count": 42
        });

        assert!(channel.validate_outputs(&values).is_ok());
    }

    #[test]
    fn test_validate_outputs_missing_required() {
        let channel = StateChannel {
            name: "test_channel".to_string(),
            inputs: vec![],
            outputs: vec![StateField {
                name: "result".to_string(),
                value_type: StateValueType::String,
                required: true,
                default: None,
                description: None,
            }],
            merge_strategies: HashMap::new(),
        };

        let values = json!({});

        let errors = channel.validate_outputs(&values).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("missing required field"));
    }

    #[test]
    fn test_validate_outputs_wrong_type() {
        let channel = StateChannel {
            name: "test_channel".to_string(),
            inputs: vec![],
            outputs: vec![StateField {
                name: "count".to_string(),
                value_type: StateValueType::Number,
                required: true,
                default: None,
                description: None,
            }],
            merge_strategies: HashMap::new(),
        };

        let values = json!({
            "count": "not a number"
        });

        let errors = channel.validate_outputs(&values).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("expected type"));
    }

    #[test]
    fn test_from_expected_outputs() {
        let mut expected_outputs = HashMap::new();
        expected_outputs.insert(
            "review_result".to_string(),
            "The result of the code review".to_string(),
        );
        expected_outputs.insert(
            "issue_count".to_string(),
            "Number of issues found".to_string(),
        );

        let channel = StateChannel::from_expected_outputs("review_node", &expected_outputs);

        assert_eq!(channel.name, "review_node_channel");
        assert_eq!(channel.outputs.len(), 2);
        assert!(channel
            .outputs
            .iter()
            .any(|f| f.name == "review_result" && f.value_type == StateValueType::String));
    }

    #[test]
    fn test_merge_strategy_default() {
        let channel = StateChannel {
            name: "test".to_string(),
            inputs: vec![],
            outputs: vec![],
            merge_strategies: HashMap::new(),
        };

        assert_eq!(
            channel.merge_strategy_for("any_field"),
            MergeStrategy::Overwrite
        );
    }

    #[test]
    fn test_merge_strategy_custom() {
        let mut merge_strategies = HashMap::new();
        merge_strategies.insert("issues".to_string(), MergeStrategy::Append);

        let channel = StateChannel {
            name: "test".to_string(),
            inputs: vec![],
            outputs: vec![],
            merge_strategies,
        };

        assert_eq!(
            channel.merge_strategy_for("issues"),
            MergeStrategy::Append
        );
    }
}
