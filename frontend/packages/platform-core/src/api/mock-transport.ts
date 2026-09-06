import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { simulateReadableStream } from "ai";

interface MockScenario {
  delayBetweenChunks: number;
  chunks: UIMessageChunk[];
}

const scenarios: MockScenario[] = [
  {
    delayBetweenChunks: 150,
    chunks: [
      { type: "start" },
      { type: "start-step" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Let me analyze the project structure." },
      { type: "reasoning-delta", id: "r1", delta: " I need to look at the workspace members first." },
      { type: "reasoning-end", id: "r1" },
      { type: "tool-input-start", toolCallId: "tc-1", toolName: "read_file" },
      { type: "tool-input-available", toolCallId: "tc-1", toolName: "read_file", input: { path: "Cargo.toml" } },
      { type: "tool-output-available", toolCallId: "tc-1", output: "[workspace]\nmembers = [12 crates]\nresolver = \"2\"" },
      { type: "tool-input-start", toolCallId: "tc-2", toolName: "bash" },
      { type: "tool-input-available", toolCallId: "tc-2", toolName: "bash", input: { command: "ls crates/" } },
      { type: "tool-output-available", toolCallId: "tc-2", output: "ergatai-agent  ergatai-api  ergatai-core  ergatai-dag  ..." },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "## Workspace Analysis\n\n" },
      { type: "text-delta", id: "t1", delta: "This workspace contains **12 crates** and follows a modular architecture. " },
      { type: "text-delta", id: "t1", delta: "`ergatai-core` is the aggregation layer, while the API and CLI layers expose the same capability set through different transports.\n\n" },
      { type: "text-delta", id: "t1", delta: "### Module Map\n\n" },
      { type: "text-delta", id: "t1", delta: "| Module | Responsibility | Status |\n|---|---|---|\n| `ergatai-core` | Aggregates shared domain types | Ready |\n| `ergatai-nats` | JetStream messaging and WorkQueue | Ready |\n| `ergatai-dag` | Workflow orchestration | Ready |\n| `ergatai-lock` | Zero-trust file locking | In review |\n\n" },
      { type: "text-delta", id: "t1", delta: "### Current Recommendation\n\n" },
      { type: "text-delta", id: "t1", delta: "> Keep the WorkQueue TTL at 24 hours until long-running tasks have durable checkpoints.\n\n" },
      { type: "text-delta", id: "t1", delta: "A minimal workspace manifest should remain explicit about resolver behavior:\n\n" },
      { type: "text-delta", id: "t1", delta: "```toml\n[workspace]\nmembers = [\n  \"crates/ergatai-agent\",\n  \"crates/ergatai-api\",\n  \"crates/ergatai-core\",\n]\nresolver = \"2\"\n```\n\n" },
      { type: "text-delta", id: "t1", delta: "Next, I can generate a dependency graph and flag crates that bypass `ergatai-lock`." },
      { type: "text-end", id: "t1" },
      { type: "finish-step" },
      { type: "finish" },
    ],
  },
  {
    delayBetweenChunks: 120,
    chunks: [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "## Frontend Architecture\n\n" },
      { type: "text-delta", id: "t2", delta: "The UI uses **five independently routable panels**:\n\n" },
      { type: "text-delta", id: "t2", delta: "1. AI conversation\n2. Terminal\n3. Browser preview\n4. Files\n5. Review\n\n" },
      { type: "text-delta", id: "t2", delta: "Each panel consumes the same registry contract, so switching `MockChatTransport` to `DefaultChatTransport` should not require UI changes.\n\n" },
      { type: "text-delta", id: "t2", delta: "```tsx\nconst { messages, sendMessage, status } = useChat({\n  transport,\n});\n```\n\n" },
      { type: "text-delta", id: "t2", delta: "The AI SDK normalizes the stream into `UIMessage.parts`, including `text`, `reasoning`, `file`, and `tool-*` parts." },
      { type: "text-end", id: "t2" },
      { type: "finish-step" },
      { type: "finish" },
    ],
  },
  {
    delayBetweenChunks: 150,
    chunks: [
      { type: "start" },
      { type: "start-step" },
      { type: "tool-input-start", toolCallId: "tc-3", toolName: "grep" },
      { type: "tool-input-available", toolCallId: "tc-3", toolName: "grep", input: { pattern: "TODO" } },
      { type: "tool-output-available", toolCallId: "tc-3", output: "3 matches:\n  delivery.rs:42  // TODO: retry\n  scheduler.rs:87 // TODO: cycle\n  main.rs:15      // TODO: rate" },
      { type: "tool-input-start", toolCallId: "tc-4", toolName: "write_file" },
      { type: "tool-input-available", toolCallId: "tc-4", toolName: "write_file", input: { path: "fixes.md" } },
      { type: "tool-output-error", toolCallId: "tc-4", errorText: "Permission denied: /root/fixes.md" },
      { type: "text-start", id: "t3" },
      { type: "text-delta", id: "t3", delta: "## Review Result\n\n" },
      { type: "text-delta", id: "t3", delta: "I found **3 TODO items**:\n\n" },
      { type: "text-delta", id: "t3", delta: "| Location | Issue | Priority |\n|---|---|---|\n| `delivery.rs:42` | Add retry policy | High |\n| `scheduler.rs:87` | Detect DAG cycles | High |\n| `main.rs:15` | Add rate limiting | Medium |\n\n" },
      { type: "text-delta", id: "t3", delta: "The write attempt failed:\n\n```text\nPermission denied: /root/fixes.md\n```\n\n" },
      { type: "text-delta", id: "t3", delta: "> Use the workspace directory instead of `/root`, then retry the write operation." },
      { type: "text-end", id: "t3" },
      { type: "finish-step" },
      { type: "finish" },
    ],
  },
];

let scenarioIndex = 0;

type MockSendOptions = Parameters<ChatTransport<UIMessage>["sendMessages"]>[0];
type MockPermission = "manual" | "auto" | "full";

const approvalRequestChunks: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "tool-input-start", toolCallId: "approval-tool", toolName: "write_file" },
  { type: "tool-input-available", toolCallId: "approval-tool", toolName: "write_file", input: { path: "/tmp/allowed.txt", content: "approved" } },
  { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "approval-tool", reason: "Write outside the opened workspace", approvalDescriptor: { path: "/tmp/allowed.txt" } },
  { type: "finish-step" },
  { type: "finish" },
];

const approvedToolChunks: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "tool-output-available", toolCallId: "approval-tool", output: "Wrote 9 bytes to /tmp/allowed.txt" },
  { type: "text-start", id: "approval-text" },
  { type: "text-delta", id: "approval-text", delta: "## Approval Complete\n\n" },
  { type: "text-delta", id: "approval-text", delta: "The write was **approved** and completed successfully.\n\n```text\nWrote 9 bytes to /tmp/allowed.txt\n```" },
  { type: "text-end", id: "approval-text" },
  { type: "finish-step" },
  { type: "finish" },
];

const deniedToolChunks: UIMessageChunk[] = [
  { type: "start" },
  { type: "start-step" },
  { type: "tool-output-denied", toolCallId: "approval-tool" },
  { type: "text-start", id: "denial-text" },
  { type: "text-delta", id: "denial-text", delta: "The write was **denied**. I will not modify `/tmp/allowed.txt`." },
  { type: "text-end", id: "denial-text" },
  { type: "finish-step" },
  { type: "finish" },
];

function createMockStream(chunks: UIMessageChunk[], abortSignal: AbortSignal | undefined, chunkDelayInMs: number) {
  const stream = simulateReadableStream({
    initialDelayInMs: 300,
    chunkDelayInMs,
    chunks,
  });
  if (!abortSignal) return stream;
  const reader = stream.getReader();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (abortSignal.aborted) {
        await reader.cancel();
        controller.close();
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel() {
      void reader.cancel();
    },
  });
}

export class MockChatTransport implements ChatTransport<UIMessage> {
  async sendMessages({ abortSignal, messages, trigger, body }: MockSendOptions): Promise<ReadableStream<UIMessageChunk>> {
    const permission = (body as { permission?: MockPermission } | undefined)?.permission;
    const lastMessage = messages[messages.length - 1];
    const lastParts = lastMessage?.parts ?? [];
    const approvalResponse = lastParts.find((part) => (part as Record<string, unknown>).state === "approval-responded") as
      | { approval?: { approved?: boolean } }
      | undefined;

    if (permission === "manual" && trigger === "submit-message" && lastMessage?.role === "user") {
      return createMockStream(approvalRequestChunks, abortSignal, 150);
    }
    if (approvalResponse) {
      return createMockStream(approvalResponse.approval?.approved ? approvedToolChunks : deniedToolChunks, abortSignal, 150);
    }

    const scenario = scenarios[scenarioIndex % scenarios.length];
    scenarioIndex += 1;
    return createMockStream(scenario.chunks, abortSignal, scenario.delayBetweenChunks);
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }
}
