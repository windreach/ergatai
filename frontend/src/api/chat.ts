import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai";
import { MockChatTransport } from "@/api/mock-transport";
import { apiUrl, runtime } from "@/config/runtime";

export const chatTransport: ChatTransport<UIMessage> = runtime.chatMode === "mock"
  ? new MockChatTransport()
  : new DefaultChatTransport<UIMessage>({ api: apiUrl(runtime.chatApiUrl) });
