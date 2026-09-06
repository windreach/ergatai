export type BackendMode = "mock" | "real";

type BackendFeature = "chat" | "files" | "review" | "terminal";

function readEnv(key: string): string | undefined {
  const value = import.meta.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMode(key: string): BackendMode | undefined {
  const value = readEnv(key);
  return value === "mock" || value === "real" ? value : undefined;
}

function resolveMode(feature: BackendFeature): BackendMode {
  const explicitMode = readMode(`VITE_${feature.toUpperCase()}_TRANSPORT`)
    ?? readMode("VITE_TRANSPORT");

  return explicitMode ?? "mock";
}

function joinUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.href).toString();
}

export function apiUrl(path: string): string {
  return joinUrl(`${apiBaseUrl}${path}`);
}

export function websocketUrl(path: string): string {
  return apiUrl(path).replace(/^http/i, "ws");
}

const configuredApiBaseUrl = readEnv("VITE_API_BASE_URL");
const apiBaseUrl = configuredApiBaseUrl?.replace(/\/$/, "") ?? "";

export const runtime = Object.freeze({
  apiBaseUrl,
  chatMode: resolveMode("chat"),
  filesMode: resolveMode("files"),
  reviewMode: resolveMode("review"),
  terminalMode: resolveMode("terminal"),
  chatApiUrl: readEnv("VITE_CHAT_API_URL") ?? "/api/v1/chat",
  terminalApiUrl: readEnv("VITE_TERMINAL_API_URL") ?? "/api/v1/terminals/ws",
  terminalDefaultCwd: readEnv("VITE_TERMINAL_DEFAULT_CWD"),
});
