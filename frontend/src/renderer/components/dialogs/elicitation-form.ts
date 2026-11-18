export type ElicitationSourceRequest = {
  requestId: string
  source: "acp" | "elicitation" | "launch-gate"
  agentId?: string | null
  title: string
  input?: unknown
}

type ElicitationChoice = { label: string; description: string }
type ElicitationValueType = "string" | "array" | "boolean" | "number" | "integer"

export type ElicitationQuestion = {
  key: string
  question: string
  header: string
  options: ElicitationChoice[]
  multiSelect: boolean
  valueType: ElicitationValueType
}

export type PendingElicitation = {
  request: ElicitationSourceRequest
  message: string
  questions: ElicitationQuestion[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function extractElicitationChoices(
  property: Record<string, unknown>,
): ElicitationChoice[] {
  const titledChoices = [property.oneOf, property.anyOf].find(Array.isArray)
  if (Array.isArray(titledChoices)) {
    return titledChoices
      .map((choice) => {
        const item = asRecord(choice)
        if (!item) return null
        const label = String(item.title ?? item.const ?? "")
        if (!label) return null
        return { label, description: String(item.description ?? "") }
      })
      .filter((choice): choice is ElicitationChoice => choice != null)
  }

  if (Array.isArray(property.enum)) {
    return property.enum.map((value) => ({
      label: String(value),
      description: "",
    }))
  }

  const items = asRecord(property.items)
  if (items) {
    return extractElicitationChoices(items)
  }

  return []
}

/**
 * Convert an ACP form elicitation into the question shape used by the shared
 * question dock. OpenCode's `question` tool maps to fields `q0`, `q1`, ...
 * with an optional `<key>_custom` free-text companion field.
 */
export function parsePendingElicitation(
  request: ElicitationSourceRequest,
): PendingElicitation | null {
  if (request.source !== "elicitation") return null

  const input = asRecord(request.input)
  if (!input || input.mode !== "form") return null

  const schema = asRecord(input.requestedSchema)
  const properties = schema ? asRecord(schema.properties) : null
  if (!properties) return null

  const questions: ElicitationQuestion[] = []
  for (const [key, rawProperty] of Object.entries(properties)) {
    if (key.endsWith("_custom")) continue

    const property = asRecord(rawProperty)
    if (!property) continue

    const type = typeof property.type === "string" ? property.type : ""
    const valueType: ElicitationValueType | null =
      type === "string" || type === "array" || type === "boolean" ||
      type === "number" || type === "integer"
        ? (type as ElicitationValueType)
        : null
    if (!valueType) continue

    if (type === "boolean") {
      questions.push({
        key,
        question: String(property.description ?? property.title ?? key),
        header: String(property.title ?? "Question"),
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        multiSelect: false,
        valueType,
      })
      continue
    }

    questions.push({
      key,
      question: String(property.description ?? property.title ?? key),
      header: String(property.title ?? "Question"),
      options: extractElicitationChoices(property),
      multiSelect: type === "array",
      valueType,
    })
  }

  if (questions.length === 0) return null

  return {
    request,
    message: String(input.message ?? request.title),
    questions,
  }
}

export function buildElicitationFormData(
  elicitation: PendingElicitation,
  answers: Record<string, string[]>,
): Record<string, unknown> {
  const formData: Record<string, unknown> = {}
  for (const question of elicitation.questions) {
    const values = answers[question.key] ?? []
    if (values.length === 0) continue

    switch (question.valueType) {
      case "array":
        formData[question.key] = values
        break
      case "boolean":
        formData[question.key] = values[0] === "Yes"
        break
      case "number":
      case "integer": {
        const parsed = Number(values[0])
        if (!Number.isNaN(parsed)) {
          formData[question.key] = parsed
        }
        break
      }
      default:
        formData[question.key] = values[0]
    }
  }
  return formData
}
