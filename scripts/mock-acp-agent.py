#!/usr/bin/env python3
"""
简易 ACP Agent 模拟器
符合 Agent Client Protocol (JSON-RPC over stdio)
"""

import sys
import json
import time
import random
import threading
from typing import Optional, Dict, Any

class SimpleAcpAgent:
    """简易 ACP Agent 实现"""

    def __init__(self, agent_name: str = "mock-agent"):
        self.agent_name = agent_name
        self.session_id = None
        self.running = True
        self.conversation_history = []
        self.pending_responses = {}  # 存储待响应的请求 ID
        self.response_lock = threading.Lock()

    def log(self, message: str):
        """日志输出到 stderr"""
        print(f"[{self.agent_name}] {message}", file=sys.stderr)

    def send_response(self, id: Any, result: Any):
        """发送 JSON-RPC 响应"""
        response = {
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }
        print(json.dumps(response), flush=True)
        self.log(f"响应: {json.dumps(result, ensure_ascii=False)[:100]}")

    def send_error(self, id: Any, code: int, message: str):
        """发送 JSON-RPC 错误"""
        error = {
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code,
                "message": message
            }
        }
        print(json.dumps(error), flush=True)
        self.log(f"错误: {message}")

    def send_request(self, method: str, params: Dict) -> Any:
        """发送 JSON-RPC 请求并等待响应"""
        request_id = f"req_{int(time.time() * 1000)}"
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        }

        self.log(f"=== 发送请求 ===")
        self.log(f"Method: {method}")
        self.log(f"ID: {request_id}")
        self.log(f"Params: {json.dumps(params, ensure_ascii=False)[:200]}")

        print(json.dumps(request), flush=True)

        self.log(f"请求已发送到 stdout")

        # 记录待响应的请求
        with self.response_lock:
            self.pending_responses[request_id] = None

        # 等待响应（通过主循环处理）
        # 这里简化处理：直接返回，让主循环继续
        # 真实场景需要异步等待
        return request_id

    def send_notification(self, method: str, params: Dict):
        """发送 JSON-RPC 通知"""
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }
        print(json.dumps(notification), flush=True)
        self.log(f"通知: {method}")

    def handle_initialize(self, id: Any, params: Dict):
        """处理 initialize 请求"""
        self.log("收到 initialize 请求")
        result = {
            "protocolVersion": 1,
            "capabilities": {
                "tools": {},
                "prompts": {},
                "resources": {}
            },
            "agentInfo": {
                "name": self.agent_name,
                "version": "1.0.0-mock",
                "description": "Simple ACP mock agent"
            }
        }
        self.send_response(id, result)

    def handle_session_start(self, id: Any, params: Dict):
        """处理 session/start 请求"""
        # 使用毫秒时间戳 + 随机数确保唯一性，防止同秒启动的 agent 获得相同 ID
        self.session_id = params.get("sessionId", f"session-{int(time.time() * 1000)}-{random.randint(1000, 9999)}")
        self.log(f"会话启动: {self.session_id}")

        result = {
            "sessionId": self.session_id,
            "status": "started"
        }
        self.send_response(id, result)

        # 发送会话启动通知
        self.send_notification("session/started", {
            "sessionId": self.session_id
        })

    def handle_session_new(self, id: Any, params: Dict):
        """处理 session/new 请求（ACP 协议替代方法）"""
        # 使用毫秒时间戳 + 随机数确保唯一性，防止同秒启动的 agent 获得相同 ID
        self.session_id = params.get("sessionId", f"session-{int(time.time() * 1000)}-{random.randint(1000, 9999)}")
        self.log(f"会话创建 (session/new): {self.session_id}")

        result = {
            "sessionId": self.session_id,
            "status": "created"
        }
        self.send_response(id, result)

    def handle_session_prompt(self, id: Any, params: Dict):
        """处理 session/prompt 请求（接收消息）"""
        # ACP SDK sends prompt content as "prompt" field (not "message")
        content_blocks = params.get("prompt", [])
        message = ""
        for block in content_blocks:
            if block.get("type") == "text":
                message += block.get("text", "")

        # Fallback to "message" field for backward compatibility
        if not message:
            message = params.get("message", "")

        self.conversation_history.append({
            "role": "user",
            "content": message,
            "timestamp": time.time()
        })

        self.log(f"收到消息: {message[:50]}...")

        # 模拟思考过程 - 使用正确的 ACP 协议格式
        self.send_notification("session/update", {
            "sessionId": self.session_id,
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {
                    "type": "text",
                    "text": f"[{self.agent_name}] 正在思考..."
                }
            }
        })

        time.sleep(0.3)  # 模拟处理时间

        # 模拟工具调用（如果消息包含 "tool" 或 "工具"）
        if "tool" in message.lower() or "工具" in message:
            self.log("模拟工具调用...")

            tool_call_id = f"tool_{int(time.time())}"

            # 发送工具调用开始事件 (ToolCall)
            self.send_notification("session/update", {
                "sessionId": self.session_id,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool_call_id,
                    "title": "read_file",
                    "kind": "read",
                    "status": "pending",
                    "locations": [{"path": "/tmp/test.txt", "line": 1}],
                    "rawInput": {"path": "/tmp/test.txt"}
                }
            })

            time.sleep(0.2)  # 模拟工具执行

            # 发送工具调用进行中事件 (ToolCallUpdate)
            self.send_notification("session/update", {
                "sessionId": self.session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": tool_call_id,
                    "fields": {
                        "status": "in_progress",
                        "content": [{"type": "text", "text": "正在读取文件..."}]
                    }
                }
            })

            time.sleep(0.2)

            # 发送工具调用完成事件 (ToolCallUpdate)
            self.send_notification("session/update", {
                "sessionId": self.session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": tool_call_id,
                    "fields": {
                        "status": "completed",
                        "content": [{"type": "text", "text": "文件内容：这是测试文件的内容。"}],
                        "rawOutput": {"content": "这是测试文件的内容。"}
                    }
                }
            })

            time.sleep(0.2)

        # 模拟文件修改（如果消息包含 "修改文件" 或 "write"）
        if "修改文件" in message or "write" in message.lower():
            self.log("模拟文件修改操作...")

            tool_call_id = f"bash_{int(time.time())}"

            # 发送真实的权限请求（RequestPermissionRequest）
            self.log("发送权限请求...")
            perm_request_id = self.send_request("session/request_permission", {
                "sessionId": self.session_id,
                "toolCall": {
                    "toolCallId": tool_call_id,
                    # ToolCallUpdateFields 使用 #[serde(flatten)]，所以字段在 toolCallId 同级
                    "kind": "edit",
                    "locations": [{"path": "test.txt", "line": 1}],
                    "rawInput": {"command": "echo 'Modified by agent' > test.txt"}
                },
                "options": [
                    {"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"},
                    {"optionId": "reject_once", "name": "Reject once", "kind": "reject_once"}
                ]
            })
            self.log(f"权限请求已发送，等待审批 (id={perm_request_id})")

            # 等待权限审批（简化版：等待 2 秒）
            # 真实场景应该异步等待响应
            time.sleep(2.0)

            # 发送 bash 工具调用（包含文件写入）
            self.send_notification("session/update", {
                "sessionId": self.session_id,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": tool_call_id,
                    "title": "bash",
                    "kind": "edit",
                    "status": "pending",
                    "locations": [{"path": "test.txt", "line": 1}],
                    "rawInput": {"command": "echo 'Modified by agent' > test.txt"}
                }
            })

            time.sleep(0.3)  # 模拟工具执行

            # 发送工具调用完成事件
            self.send_notification("session/update", {
                "sessionId": self.session_id,
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": tool_call_id,
                    "fields": {
                        "status": "completed",
                        "content": [{"type": "text", "text": "文件已修改"}],
                        "rawOutput": {"exit_code": 0, "output": ""}
                    }
                }
            })

            time.sleep(0.2)

        # 生成模拟响应
        response_text = self.generate_response(message)

        # 发送文本响应 - 使用正确的 ACP 协议格式
        self.send_notification("session/update", {
            "sessionId": self.session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {
                    "type": "text",
                    "text": response_text
                }
            }
        })

        self.conversation_history.append({
            "role": "assistant",
            "content": response_text,
            "timestamp": time.time()
        })

        result = {
            "sessionId": self.session_id,
            "stopReason": "end_turn"
        }
        self.send_response(id, result)

    def handle_tools_list(self, id: Any, params: Dict):
        """处理 tools/list 请求"""
        tools = [
            {
                "name": "send_message",
                "description": "Send message to another agent",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "to": {"type": "string"},
                        "message": {"type": "string"}
                    },
                    "required": ["to", "message"]
                }
            },
            {
                "name": "read_file",
                "description": "Read a file",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"}
                    },
                    "required": ["path"]
                }
            }
        ]
        self.send_response(id, {"tools": tools})

    def handle_tool_call(self, id: Any, params: Dict):
        """处理 tool call"""
        tool_name = params.get("name")
        tool_input = params.get("input", {})

        self.log(f"工具调用: {tool_name}")

        # 模拟工具执行
        if tool_name == "send_message":
            result = {
                "status": "sent",
                "messageId": f"msg-{int(time.time())}"
            }
        elif tool_name == "read_file":
            result = {
                "content": "Mock file content",
                "path": tool_input.get("path")
            }
        else:
            result = {
                "status": "unknown tool"
            }

        self.send_response(id, result)

    def generate_response(self, message: str) -> str:
        """生成模拟响应"""
        message_lower = message.lower()

        if "hello" in message_lower or "你好" in message_lower:
            return f"你好！我是 {self.agent_name}，很高兴为你服务。"
        elif "help" in message_lower or "帮助" in message_lower:
            return "我可以帮助完成编程任务、代码审查、文件操作等。"
        elif "task" in message_lower or "任务" in message_lower:
            return f"收到任务，我将开始处理。我的名字是 {self.agent_name}。"
        else:
            return f"[{self.agent_name}] 我理解了你的消息。这是一个模拟响应。"

    def process_message(self, data: Dict):
        """处理收到的 JSON-RPC 消息"""
        # 检查是否是响应（有 result 或 error 字段）
        if "result" in data or "error" in data:
            request_id = data.get("id")
            if request_id:
                with self.response_lock:
                    if request_id in self.pending_responses:
                        self.pending_responses[request_id] = data
                        self.log(f"收到响应: {request_id}")
                        self.log(f"响应内容: {json.dumps(data, ensure_ascii=False)[:2000]}")  # 增加到 2000 字符
            return

        # 否则是请求
        method = data.get("method")
        id = data.get("id")
        params = data.get("params", {})

        self.log(f"请求: {method}")

        if method == "initialize":
            self.handle_initialize(id, params)
        elif method == "session/start":
            self.handle_session_start(id, params)
        elif method == "session/new":
            self.handle_session_new(id, params)
        elif method == "session/prompt":
            self.handle_session_prompt(id, params)
        elif method == "tools/list":
            self.handle_tools_list(id, params)
        elif method == "tools/call":
            self.handle_tool_call(id, params)
        elif method == "shutdown":
            self.log("收到关闭请求")
            self.running = False
            self.send_response(id, {"status": "shutdown"})
        else:
            self.log(f"未知方法: {method}")
            self.send_error(id, -32601, f"Method not found: {method}")

    def run(self):
        """主循环：读取 stdin，处理消息"""
        self.log("ACP Agent 启动")

        for line in sys.stdin:
            if not self.running:
                break

            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
                self.process_message(data)
            except json.JSONDecodeError as e:
                self.log(f"JSON 解析错误: {e}")
                self.send_error(None, -32700, "Parse error")
            except Exception as e:
                self.log(f"处理错误: {e}")
                self.send_error(None, -32603, f"Internal error: {e}")

        self.log("ACP Agent 关闭")

def main():
    """主入口"""
    agent_name = sys.argv[1] if len(sys.argv) > 1 else "mock-agent"
    agent = SimpleAcpAgent(agent_name)
    agent.run()

if __name__ == "__main__":
    main()
