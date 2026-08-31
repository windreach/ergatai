import { useState } from "react";
import { ConfigProvider, theme, Avatar } from "antd";
import { Bubble, Conversations, Sender } from "@ant-design/x";
import {
  Bot,
  Plus,
  Settings,
} from "lucide-react";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const MOCK_MESSAGES: Message[] = [
  { id: "1", role: "user", content: "帮我分析一下这个项目的架构" },
  {
    id: "2",
    role: "assistant",
    content:
      "这是一个多 agent 协作中间件项目。核心架构分为三层：\n\n1. **通信层** — NATS JetStream 负责 agent 间消息投递\n2. **调度层** — DAG Scheduler 管理任务编排和依赖关系\n3. **执行层** — ACP Backend 与 agent 进程交互\n\n需要我详细分析某个模块吗？",
  },
  {
    id: "3",
    role: "user",
    content: "文件锁机制是怎么实现的？",
  },
  {
    id: "4",
    role: "assistant",
    content:
      "文件锁采用零信任模型，核心机制：\n\n- **双层 Token**: SystemToken（准入）+ FileToken（操作权限）\n- **SQLite WAL**: 高并发锁管理\n- **Git COW 快照**: Copy-on-Write 防止 TOCTOU\n- **fanotify**: Linux 内核级强制拦截\n\n```rust\n// 自动获取写锁\npub async fn auto_acquire_write_lock(\n    &self,\n    agent_id: &str,\n    path: &Path,\n) -> Result<FileToken> {\n    let snapshot = self.create_git_snapshot(path).await?;\n    let token = FileToken::new(agent_id, path, Permission::Write);\n    self.store.insert_token(&token).await?;\n    Ok(token)\n}\n```",
  },
];

function App() {
  const [messages] = useState<Message[]>(MOCK_MESSAGES);
  const [inputValue, setInputValue] = useState("");

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: "#5b8def",
          borderRadius: 8,
          colorBgContainer: "oklch(15% 0.008 260)",
          colorBgElevated: "oklch(18% 0.01 260)",
          colorBgLayout: "oklch(12% 0.008 260)",
          colorBorder: "oklch(25% 0.015 260)",
          colorText: "oklch(92% 0.008 260)",
          colorTextSecondary: "oklch(60% 0.015 260)",
          fontFamily: '"Inter", system-ui, sans-serif',
        },
      }}
    >
      <div className="flex h-screen bg-[var(--background)]">
        {/* Sidebar */}
        <aside className="flex w-[240px] flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm font-medium text-[var(--sidebar-foreground)]">
              Conversations
            </span>
            <button className="rounded-md p-1.5 text-[var(--sidebar-foreground)] transition-colors hover:bg-[var(--sidebar-accent)]">
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Conversation List */}
          <div className="flex-1 overflow-y-auto px-2">
            <Conversations
              items={[
                { key: "1", label: "项目架构分析" },
                { key: "2", label: "文件锁实现" },
                { key: "3", label: "DAG 调度优化" },
              ]}
              activeKey="1"
              className="conversation-list"
            />
          </div>

          {/* Footer */}
          <div className="border-t border-[var(--sidebar-border)] p-3">
            <button className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-[var(--sidebar-foreground)] transition-colors hover:bg-[var(--sidebar-accent)]">
              <Settings className="h-4 w-4" />
              Settings
            </button>
          </div>
        </aside>

        {/* Main Chat Area */}
        <main className="flex flex-1 flex-col">
          {/* Chat Header */}
          <header className="flex items-center border-b border-[var(--border)] px-6 py-3">
            <h1 className="text-sm font-medium text-[var(--foreground)]">
              项目架构分析
            </h1>
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            <div className="mx-auto max-w-2xl space-y-6">
              {messages.map((msg) => (
                <Bubble
                  key={msg.id}
                  placement={msg.role === "user" ? "end" : "start"}
                  content={msg.content}
                  avatar={
                    msg.role === "assistant" ? (
                      <Avatar
                        icon={<Bot className="h-4 w-4" />}
                        style={{
                          background: "var(--primary)",
                          color: "var(--primary-foreground)",
                          borderRadius: "10px",
                        }}
                        size={32}
                      />
                    ) : undefined
                  }
                  className="chat-bubble"
                />
              ))}
            </div>
          </div>

          {/* Input */}
          <div className="border-t border-[var(--border)] px-8 py-5">
            <div className="mx-auto max-w-2xl">
              <Sender
                value={inputValue}
                onChange={setInputValue}
                onSubmit={() => {
                  console.log("submit:", inputValue);
                  setInputValue("");
                }}
                placeholder="Send a message..."
                className="chat-sender"
              />
            </div>
          </div>
        </main>
      </div>
    </ConfigProvider>
  );
}

export default App;
