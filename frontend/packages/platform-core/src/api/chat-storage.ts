import type { UIMessage } from "ai";

const databaseName = "ergatai-chat";
const databaseVersion = 1;
const storeName = "conversations";
const legacyKeyPrefix = "ergatai.chat.v1:";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open chat storage"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Chat storage request failed"));
  });
}

function isUIMessage(value: unknown): value is UIMessage {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && "role" in value
    && "parts" in value
    && Array.isArray((value as UIMessage).parts);
}

export interface ChatConversationSummary {
  id: string;
  title: string;
}

function conversationTitle(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (const message of messages) {
    if (!isUIMessage(message)) continue;

    for (const part of message.parts) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
        return part.text.trim().slice(0, 80);
      }
    }
  }

  return "";
}

export async function listChatConversations(): Promise<ChatConversationSummary[]> {
  try {
    const database = await openDatabase();
    const store = database.transaction(storeName, "readonly").objectStore(storeName);
    const keys = await requestToPromise(store.getAllKeys());
    const values = await requestToPromise(store.getAll());

    return keys
      .map((key, index) => {
        const id = typeof key === "string" ? key : String(key);
        const title = conversationTitle(values[index]);
        return { id, title, hasContent: title.length > 0 };
      })
      .filter((entry): entry is ChatConversationSummary & { hasContent: boolean } => entry.hasContent)
      .map(({ id, title }) => ({ id, title }));
  } catch {
    return [];
  }
}

function readLegacyMessages(conversationId: string): UIMessage[] {
  try {
    const value = localStorage.getItem(`${legacyKeyPrefix}${conversationId}`);
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isUIMessage) : [];
  } catch {
    return [];
  }
}

export async function loadChatMessages(conversationId: string): Promise<UIMessage[]> {
  try {
    const database = await openDatabase();
    const store = database.transaction(storeName, "readonly").objectStore(storeName);
    const stored: unknown = await requestToPromise(store.get(conversationId));

    if (Array.isArray(stored)) {
      return stored.filter(isUIMessage);
    }

    const legacyMessages = readLegacyMessages(conversationId);
    if (legacyMessages.length > 0) {
      await saveChatMessages(conversationId, legacyMessages);
      localStorage.removeItem(`${legacyKeyPrefix}${conversationId}`);
    }
    return legacyMessages;
  } catch {
    return readLegacyMessages(conversationId);
  }
}

export async function saveChatMessages(conversationId: string, messages: UIMessage[]): Promise<void> {
  const database = await openDatabase();
  const store = database.transaction(storeName, "readwrite").objectStore(storeName);
  await requestToPromise(store.put(messages, conversationId));
}

export async function clearChatMessages(conversationId: string): Promise<void> {
  const database = await openDatabase();
  const store = database.transaction(storeName, "readwrite").objectStore(storeName);
  await requestToPromise(store.delete(conversationId));
  localStorage.removeItem(`${legacyKeyPrefix}${conversationId}`);
}

function mockMessage(
  id: string,
  role: UIMessage["role"],
  text: string,
  offsetMs: number,
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
    createdAt: new Date(Date.now() - offsetMs).toISOString(),
  } as UIMessage;
}

export async function seedMockConversations(): Promise<void> {
  try {
    const seeds: Array<[string, UIMessage[]]> = [
      [
        "mock-architecture-review",
        [
          mockMessage("m1", "user", "帮我分析一下这个项目的整体架构", 600_000),
          mockMessage("m2", "assistant", "## Workspace Analysis\n\nThis workspace contains **12 crates** and follows a modular architecture. `ergatai-core` is the aggregation layer, while the API and CLI layers expose the same capability set through different transports.\n\n### Module Map\n\n| Module | Responsibility | Status |\n|---|---|---|\n| `ergatai-core` | Aggregates shared domain types | Ready |\n| `ergatai-nats` | JetStream messaging and WorkQueue | Ready |\n| `ergatai-dag` | Workflow orchestration | Ready |\n\n### Recommendation\n\nKeep the WorkQueue TTL at 24 hours until long-running tasks have durable checkpoints.", 540_000),
        ],
      ],
      [
        "mock-frontend-design",
        [
          mockMessage("m3", "user", "前端的面板结构是怎么设计的？", 300_000),
          mockMessage("m4", "assistant", "## Frontend Architecture\n\nThe UI uses **five independently routable panels**:\n\n1. AI conversation\n2. Terminal\n3. Browser preview\n4. Files\n5. Review\n\nEach panel consumes the same registry contract, so switching `MockChatTransport` to `DefaultChatTransport` should not require UI changes.", 240_000),
        ],
      ],
      [
        "mock-debug-locking",
        [
          mockMessage("m5", "user", "ergatai-lock 的 watchdog 是怎么处理租约过期的？", 120_000),
          mockMessage("m6", "assistant", "The watchdog monitors lock leases on a background timer. When a lease's TTL is about to expire, it attempts to renew. If renewal fails (e.g. the owner is gone), the watcher transitions the lock to `expired` and notifies all subscribers. This ensures stale holders don't block new acquisitions indefinitely.", 60_000),
        ],
      ],
    ];

    for (const [id, messages] of seeds) {
      await saveChatMessages(id, messages);
    }
  } catch {
    // Seeding is best-effort; ignore failures.
  }
}
