import { describe, expect, it } from "vitest"
import {
  buildElicitationFormData,
  parsePendingElicitation,
  type PendingElicitation,
} from "@/components/dialogs/elicitation-form"

describe("parsePendingElicitation", () => {
  it("parses an OpenCode question form schema", () => {
    const parsed = parsePendingElicitation({
      requestId: "elic-1",
      source: "elicitation",
      agentId: "agent-1",
      title: "Questions",
      input: {
        message: "File info",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: {
            q0: {
              type: "string",
              title: "文件信息",
              description: "你想创建什么类型的文件？",
              oneOf: [
                {
                  const: "有具体内容",
                  title: "有具体内容",
                  description: "需要指定内容和路径",
                },
                { const: "空文件", title: "空文件", description: "只需要路径" },
              ],
            },
            q0_custom: { type: "string", title: "文件信息 (other)" },
            q1: {
              type: "array",
              title: "附加项",
              description: "选择附加内容",
              items: {
                anyOf: [{ const: "README", title: "README", description: "" }],
              },
            },
            q1_custom: { type: "string", title: "附加项 (other)" },
          },
          required: ["q0", "q1"],
        },
      },
    })

    expect(parsed).not.toBeNull()
    expect(parsed?.questions).toHaveLength(2)
    expect(parsed?.questions[0]).toMatchObject({
      key: "q0",
      header: "文件信息",
      question: "你想创建什么类型的文件？",
      multiSelect: false,
      valueType: "string",
    })
    expect(parsed?.questions[0].options.map((option) => option.label)).toEqual([
      "有具体内容",
      "空文件",
    ])
    expect(parsed?.questions[1]).toMatchObject({
      key: "q1",
      multiSelect: true,
      valueType: "array",
    })
    expect(parsed?.questions[1].options.map((option) => option.label)).toEqual([
      "README",
    ])
  })

  it("ignores non-form elicitations", () => {
    expect(
      parsePendingElicitation({
        requestId: "elic-2",
        source: "elicitation",
        title: "Open URL",
        input: { message: "Open this", mode: "url", url: "https://example.com" },
      }),
    ).toBeNull()
  })

  it("falls back to the request title when the schema is missing", () => {
    expect(
      parsePendingElicitation({
        requestId: "elic-3",
        source: "elicitation",
        title: "Question",
        input: { message: "Hi", mode: "form" },
      }),
    ).toBeNull()
  })
})

describe("buildElicitationFormData", () => {
  const elicitation: PendingElicitation = {
    request: {
      requestId: "elic-1",
      source: "elicitation",
      title: "Questions",
      input: {},
    },
    message: "File info",
    questions: [
      {
        key: "q0",
        question: "Which file?",
        header: "File",
        options: [{ label: "README.md", description: "" }],
        multiSelect: false,
        valueType: "string",
      },
      {
        key: "q1",
        question: "Extras",
        header: "Extras",
        options: [{ label: "docs", description: "" }],
        multiSelect: true,
        valueType: "array",
      },
      {
        key: "q2",
        question: "Enable?",
        header: "Enable",
        options: [],
        multiSelect: false,
        valueType: "boolean",
      },
      {
        key: "q3",
        question: "Count",
        header: "Count",
        options: [],
        multiSelect: false,
        valueType: "integer",
      },
    ],
  }

  it("maps answers to the OpenCode form field shape", () => {
    expect(
      buildElicitationFormData(elicitation, {
        q0: ["README.md"],
        q1: ["docs", "custom"],
        q2: ["Yes"],
        q3: ["3"],
      }),
    ).toEqual({
      q0: "README.md",
      q1: ["docs", "custom"],
      q2: true,
      q3: 3,
    })
  })

  it("omits unanswered questions", () => {
    expect(
      buildElicitationFormData(elicitation, {
        q0: ["README.md"],
      }),
    ).toEqual({ q0: "README.md" })
  })
})
