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
