/**
 * Shared error shapes for chat surfaces.
 *
 * Runtime errors arrive through SSE, persisted errors arrive through message
 * metadata, and both must render with the same card. Keeping the normalization
 * and copy in `shared/` lets the main process and renderer agree on the shape
 * without importing renderer code.
 */

export type ChatErrorInfo = {
  /** Human-readable error message. May still contain provider noise. */
  message: string
  errorName?: string
  errorType?: string
  service?: string
  code?: string | number
  data?: unknown
  /** Raw assistant text captured before the failure, shown in details. */
  rawText?: string
  /** Number of consecutive identical failures collapsed into this card. */
  repeatCount?: number
}

export type ChatErrorPart = {
  type: "error"
  error: ChatErrorInfo
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function asCode(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined
}

/** Strip provider wrappers so the card body is readable. */
export function cleanErrorMessage(message: string): string {
  let text = (message ?? "").trim()
  if (!text) return "本轮执行失败"

  text = text.replace(/\s*\[code=[^\]]+\]\s*$/i, "")
  text = text.replace(/\s*\{[\s\S]*["']?errorKind["']?[\s\S]*\}\s*$/i, "")
  text = text.replace(/^Internal error:\s*/i, "")
  text = text.replace(/[:\s]+$/, "")
  text = text.replace(/\s{2,}/g, " ")

  return text.trim() || "本轮执行失败"
}

export function normalizeChatError(input: {
  message?: unknown
  error_name?: unknown
  errorName?: unknown
  error_type?: unknown
  errorType?: unknown
  service?: unknown
  code?: unknown
  data?: unknown
  error_data?: unknown
  rawText?: unknown
  repeatCount?: unknown
}): ChatErrorInfo {
  const message =
    asString(input.message) ??
    "本轮执行失败"
  const data = input.data ?? input.error_data
  const repeatCount =
    typeof input.repeatCount === "number" && input.repeatCount > 1
      ? input.repeatCount
      : undefined

  return {
    message,
    errorName: asString(input.error_name) ?? asString(input.errorName),
    errorType: asString(input.error_type) ?? asString(input.errorType),
    service: asString(input.service),
    code: asCode(input.code),
    data,
    rawText: asString(input.rawText),
    repeatCount,
  }
}

/** Build an error info object from persisted message metadata. */
export function chatErrorFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  fallbackMessage?: string,
): ChatErrorInfo | null {
  if (!metadata) return null
  const raw = metadata.error
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  return normalizeChatError({
    message: record.message ?? fallbackMessage,
    errorName: record.errorName ?? record.error_name,
    errorType: record.errorType ?? record.error_type,
    service: record.service,
    code: record.code,
    data: record.data ?? record.error_data,
  })
}

export type ChatErrorDisplay = {
  title: string
  description: string
}

/** Map structured error kinds to short, actionable copy. */
export function getChatErrorDisplay(error: ChatErrorInfo): ChatErrorDisplay {
  const kind = `${error.errorName ?? ""} ${error.errorType ?? ""}`.toLowerCase()
  const cleaned = cleanErrorMessage(error.message)
  const haystack = `${kind} ${cleaned.toLowerCase()}`

  if (haystack.includes("model_not_found") || haystack.includes("selected model")) {
    return {
      title: "模型不可用",
      description:
        "所选模型不存在，或当前账号没有访问权限。请在模型选择器中切换模型后重试。",
    }
  }

  if (
    haystack.includes("invalid_api_key") ||
    haystack.includes("authentication") ||
    haystack.includes("unauthorized") ||
    haystack.includes("401")
  ) {
    return {
      title: "认证失败",
      description: "请重新登录或更新 API Key 后重试。",
    }
  }

  if (haystack.includes("permission_denied") || haystack.includes("forbidden")) {
    return {
      title: "没有访问权限",
      description: "当前账号没有执行该操作的权限，请检查模型或组织权限设置。",
    }
  }

  if (
    haystack.includes("rate_limit") ||
    haystack.includes("free usage limit") ||
    haystack.includes("free-limit") ||
    haystack.includes("quota") ||
    haystack.includes("too many requests")
  ) {
    return {
      title: "请求受限",
      description: "额度不足或触发了限流。请稍后重试，或切换模型/套餐。",
    }
  }

  if (
    haystack.includes("context_length") ||
    haystack.includes("context window") ||
    haystack.includes("too long")
  ) {
    return {
      title: "上下文过长",
      description: "当前会话上下文超出模型限制。请压缩上下文或开启新会话。",
    }
  }

  if (
    haystack.includes("overloaded") ||
    haystack.includes("timeout") ||
    haystack.includes("network") ||
    haystack.includes("unavailable") ||
    haystack.includes("429") ||
    haystack.includes("500") ||
    haystack.includes("502") ||
    haystack.includes("503") ||
    haystack.includes("504")
  ) {
    return {
      title: "服务暂时不可用",
      description: "模型服务暂时不可用，系统会自动重试；也可以手动重试。",
    }
  }

  return {
    title: "本轮执行失败",
    description: cleaned,
  }
}

export function isChatErrorPart(part: unknown): part is ChatErrorPart {
  return chatErrorFromPart(part) !== null
}

/**
 * Normalize either the structured error part (`{ type: "error", error }`) or
 * the AI SDK wire part (`{ type: "error", errorText }`) into a card model.
 */
export function chatErrorFromPart(part: unknown): ChatErrorInfo | null {
  if (!part || typeof part !== "object") return null
  const record = part as Record<string, unknown>
  if (record.type !== "error") return null

  if (record.error && typeof record.error === "object") {
    const error = record.error as Record<string, unknown>
    return normalizeChatError({
      message: error.message ?? record.errorText,
      errorName: error.errorName ?? error.error_name,
      errorType: error.errorType ?? error.error_type,
      service: error.service,
      code: error.code,
      data: error.data ?? error.error_data,
      rawText: error.rawText,
      repeatCount: error.repeatCount,
    })
  }

  if (typeof record.errorText === "string" && record.errorText.trim()) {
    return normalizeChatError({ message: record.errorText })
  }

  return null
}
