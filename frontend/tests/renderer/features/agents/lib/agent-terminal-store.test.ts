import { beforeEach, describe, expect, it } from "vitest"
import {
  applyAgentTerminalExtension,
  applyAgentTerminalUpdate,
  getAgentTerminals,
  isAgentTerminalVisible,
  resetAgentTerminalStoreForTests,
  type AgentTerminalTask,
} from "../../../../../src/renderer/features/agents/lib/agent-terminal-store"

describe("agent-terminal-store", () => {
  beforeEach(() => {
    resetAgentTerminalStoreForTests()
  })

  it("upserts terminal tasks by terminal id", () => {
    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "pnpm test",
      command: "pnpm test",
      output: "running...",
      status: "running",
      updated_at: 1,
    })
    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "pnpm test",
      command: "pnpm test",
      output: "done\n",
      status: "completed",
      exit_code: 0,
      updated_at: 2,
    })

    const terminals = getAgentTerminals("conv_1")
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({
      terminalId: "tool_1",
      title: "pnpm test",
      output: "done\n",
      status: "completed",
      exitCode: 0,
      startedAt: 1,
      finishedAt: 2,
      updatedAt: 2,
    })
  })

  it("appends output deltas and accepts full snapshots", () => {
    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "watch",
      output_delta: "first ",
    })
    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "watch",
      output_delta: "second",
    })
    expect(getAgentTerminals("conv_1")[0]?.output).toBe("first second")

    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "watch",
      output: "replacement",
    })
    expect(getAgentTerminals("conv_1")[0]?.output).toBe("replacement")

    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "watch",
      status: "completed",
    })
    expect(getAgentTerminals("conv_1")[0]?.output).toBe("replacement")
  })

  it("binds a shell async task to its terminal and uses its lifecycle", () => {
    applyAgentTerminalExtension("conv_1", "terminal_task_update", {
      terminal_id: "tool_1",
      title: "Terminal",
      status: "completed",
      exit_code: 0,
    })

    expect(
      applyAgentTerminalExtension("conv_1", "async_task_spawned", {
        taskType: "shell",
        toolCallId: "tool_1",
        asyncTaskId: "task_1",
        name: "Run in background",
      }),
    ).toBe(true)

    expect(getAgentTerminals("conv_1")[0]).toMatchObject({
      terminalId: "tool_1",
      title: "Run in background",
      status: "running",
      backgrounded: true,
      exitCode: undefined,
    })

    applyAgentTerminalExtension("conv_1", "async_task_state_update", {
      asyncTaskId: "task_1",
      state: "completed",
    })
    expect(getAgentTerminals("conv_1")[0]?.status).toBe("completed")
  })

  it("replays a background task snapshot without losing its name or output", () => {
    applyAgentTerminalExtension(
      "conv_1",
      "terminal_task_update",
      { terminal_id: "tool_1", title: "Terminal", status: "running" },
      1_000,
    )
    applyAgentTerminalExtension(
      "conv_1",
      "async_task_spawned",
      {
        taskType: "shell",
        toolCallId: "tool_1",
        asyncTaskId: "task_1",
        name: "Run in background",
      },
      1_000,
    )
    applyAgentTerminalExtension(
      "conv_1",
      "terminal_task_update",
      {
        terminal_id: "tool_1",
        title: "Terminal",
        output_delta: "started\n",
        status: "running",
      },
      2_000,
    )
    // Old runtimes marked the tool result as completed; the async state is the
    // authoritative completion signal.
    applyAgentTerminalExtension(
      "conv_1",
      "terminal_task_update",
      {
        terminal_id: "tool_1",
        title: "Terminal",
        output: "started\ndone\n",
        exit_code: 0,
        status: "completed",
      },
      2_000,
    )

    expect(getAgentTerminals("conv_1")[0]).toMatchObject({
      terminalId: "tool_1",
      title: "Run in background",
      output: "started\ndone\n",
      status: "running",
    })

    applyAgentTerminalExtension(
      "conv_1",
      "async_task_state_update",
      { asyncTaskId: "task_1", state: "completed" },
      61_000,
    )

    const task = getAgentTerminals("conv_1")[0]
    expect(task).toMatchObject({
      terminalId: "tool_1",
      title: "Run in background",
      output: "started\ndone\n",
      status: "completed",
      startedAt: 1_000,
      finishedAt: 61_000,
    })
    expect(task ? isAgentTerminalVisible(task, 61_000) : false).toBe(true)
  })

  it("keeps tasks isolated per conversation", () => {
    applyAgentTerminalUpdate("conv_1", {
      terminal_id: "tool_1",
      title: "first",
    })
    applyAgentTerminalUpdate("conv_2", {
      terminal_id: "tool_2",
      title: "second",
    })

    expect(getAgentTerminals("conv_1").map((task) => task.terminalId)).toEqual([
      "tool_1",
    ])
    expect(getAgentTerminals("conv_2").map((task) => task.terminalId)).toEqual([
      "tool_2",
    ])
  })

  it("ignores payloads without a terminal id", () => {
    expect(applyAgentTerminalUpdate("conv_1", { title: "no id" })).toBe(false)
    expect(getAgentTerminals("conv_1")).toEqual([])
  })

  it("only shows tasks that lived at least 15 seconds", () => {
    const task: AgentTerminalTask = {
      terminalId: "tool_1",
      title: "test",
      output: "",
      status: "running",
      backgrounded: false,
      startedAt: 1_000,
      updatedAt: 1_000,
    }

    expect(isAgentTerminalVisible(task, 15_999)).toBe(false)
    expect(isAgentTerminalVisible(task, 16_000)).toBe(true)

    const quickCompleted: AgentTerminalTask = {
      ...task,
      status: "completed",
      finishedAt: 5_000,
    }
    expect(isAgentTerminalVisible(quickCompleted, 100_000)).toBe(false)

    const longCompleted: AgentTerminalTask = {
      ...task,
      status: "completed",
      finishedAt: 20_000,
    }
    expect(isAgentTerminalVisible(longCompleted, 100_000)).toBe(true)
  })

  it("accepts camelCase fields as a fallback", () => {
    applyAgentTerminalUpdate("conv_1", {
      terminalId: "tool_3",
      title: "camel",
      exitCode: 2,
      updatedAt: 3,
    })

    expect(getAgentTerminals("conv_1")[0]).toMatchObject({
      terminalId: "tool_3",
      title: "camel",
      exitCode: 2,
      updatedAt: 3,
    })
  })
})
