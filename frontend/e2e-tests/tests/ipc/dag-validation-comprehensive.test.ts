/**
 * E2E UI 测试 - DAG YAML 完整校验（9 条严格规则）
 * 对应 CLAUDE.md 中 yaml_parser.rs 的 9 条校验规则
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('E2E: DAG YAML 完整校验规则', () => {
  let electron: any
  let page: any

  beforeAll(async () => {
    const launched = await launchIntegrationElectron()
    electron = launched.electron
    page = launched.page
  })

  afterAll(async () => {
    await cleanupIntegration(electron)
  })

  beforeEach(async () => {
    await page.evaluate(async () => {
      await (window as any).trpc.test.helpers.cleanup.mutate()
    })
  })

  // ─── 规则 1: 顶层未知字段 (deny_unknown_fields) ───
  describe('规则 1: 顶层未知字段', () => {
    test('拼写错误的顶层字段应该被拒绝', async () => {
      const yaml = `
name: test-dag
communcation: open
tasks:
  - name: task1
    agent: claude
    prompt: "Task 1"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('合法的顶层字段应该通过', async () => {
      const yaml = `
name: valid-dag
description: A valid DAG
priority: high
communication: open
max_agent_calls: 100
stall_timeout_secs: 300
node_timeout_secs: 900
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
      expect(result.summary).toBeDefined()
    })
  })

  // ─── 规则 2: 任务名非空 ───
  describe('规则 2: 任务名非空', () => {
    test('空任务名应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: ""
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('空白任务名应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: "   "
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })
  })

  // ─── 规则 3: 任务名唯一 ───
  describe('规则 3: 任务名唯一', () => {
    test('重复任务名应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task-alpha
    agent: claude
    prompt: "Task A"
  - name: task-alpha
    agent: cursor
    prompt: "Duplicate!"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('不同任务名应该通过', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: alpha
    agent: claude
    prompt: "Task A"
  - name: beta
    agent: cursor
    prompt: "Task B"
  - name: gamma
    agent: codex
    prompt: "Task C"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
      expect(result.summary.taskCount).toBe(3)
    })
  })

  // ─── 规则 4: priority 枚举 ───
  describe('规则 4: priority 枚举', () => {
    test('DAG 级 priority 应为 low|medium|high', async () => {
      for (const priority of ['low', 'medium', 'high', 'LOW', 'Medium', 'HIGH']) {
        const yaml = `
name: test-dag
priority: ${priority}
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
        const result = await page.evaluate(async (y: string) => {
          return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
        }, yaml)

        expect(result.valid).toBe(true)
      }
    })

    test('无效 priority 应该被拒绝', async () => {
      const yaml = `
name: test-dag
priority: critical
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('任务级 priority 也应遵守枚举', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
    priority: urgent
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })
  })

  // ─── 规则 5: 正值约束 ───
  describe('规则 5: 正值约束', () => {
    test('timeout 为 0 应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
    timeout: 0
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('max_agent_calls 为 0 应该被拒绝', async () => {
      const yaml = `
name: test-dag
max_agent_calls: 0
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('stall_timeout_secs 为负数应该被拒绝', async () => {
      const yaml = `
name: test-dag
stall_timeout_secs: -10
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('node_timeout_secs 为正数应该通过', async () => {
      const yaml = `
name: test-dag
node_timeout_secs: 600
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })
  })

  // ─── 规则 6: communication 格式 ───
  describe('规则 6: communication 格式', () => {
    test('open 通信模式应该通过', async () => {
      const yaml = `
name: test-dag
communication: open
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('adjacent 通信模式应该通过', async () => {
      const yaml = `
name: test-dag
communication: adjacent
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
  - name: task2
    agent: cursor
    prompt: "Task"
    depends_on:
      - task1
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('star:{hub} 通信模式应该通过', async () => {
      const yaml = `
name: test-dag
communication: star:claude
tasks:
  - name: task1
    agent: claude
    prompt: "Hub task"
  - name: task2
    agent: cursor
    prompt: "Worker task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('无效通信模式应该被拒绝', async () => {
      const yaml = `
name: test-dag
communication: mesh
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })
  })

  // ─── 规则 7: 模板变量引用 ───
  describe('规则 7: 模板变量引用', () => {
    test('引用已声明的 parameters 应该通过', async () => {
      const yaml = `
name: test-dag
parameters:
  - name: repo_url
    default: "https://github.com/test"
tasks:
  - name: task1
    agent: claude
    prompt: "Clone {{repo_url}}"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('引用未声明的 parameters 应该被拒绝', async () => {
      const yaml = `
name: test-dag
parameters:
  - name: repo_url
    default: "https://github.com/test"
tasks:
  - name: task1
    agent: claude
    prompt: "Clone {{unknown_var}}"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('无 parameters 声明时应跳过模板检查', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Do something with {{any_var}}"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      // 没有声明 parameters，跳过检查 → 通过
      expect(result.valid).toBe(true)
    })
  })

  // ─── 规则 8: 依赖存在性 ───
  describe('规则 8: 依赖存在性', () => {
    test('depends_on 引用存在的任务应该通过', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: build
    agent: claude
    prompt: "Build"
  - name: test
    agent: cursor
    prompt: "Test"
    depends_on:
      - build
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('depends_on 引用不存在的任务应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: test
    agent: cursor
    prompt: "Test"
    depends_on:
      - nonexistent-task
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    test('多依赖应该全部检查', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: build
    agent: claude
    prompt: "Build"
  - name: lint
    agent: codex
    prompt: "Lint"
  - name: deploy
    agent: cursor
    prompt: "Deploy"
    depends_on:
      - build
      - lint
      - missing-task
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })
  })

  // ─── 规则 9: scope glob 合法性 ───
  describe('规则 9: scope glob 合法性', () => {
    test('合法 glob 应该通过', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
    scope: "src/**/*.ts"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
    })

    test('绝对路径 scope 应该被拒绝（必须是相对路径）', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
    scope: "/etc/passwd"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })

    test('非法 glob 模式应该被拒绝', async () => {
      const yaml = `
name: test-dag
tasks:
  - name: task1
    agent: claude
    prompt: "Task"
    scope: "[invalid"
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(false)
    })
  })

  // ─── 综合场景 ───
  describe('综合 DAG 场景', () => {
    test('复杂多任务 DAG 应该通过所有校验', async () => {
      const yaml = `
name: full-pipeline
description: Complete CI/CD pipeline
priority: high
communication: adjacent
max_agent_calls: 50
stall_timeout_secs: 600
node_timeout_secs: 1800
parameters:
  - name: branch
    default: "main"
  - name: deploy_target
    default: "staging"
tasks:
  - name: lint
    agent: claude
    prompt: "Lint code on {{branch}}"
    complexity: low
    scope: "src/**/*.ts"
  - name: build
    agent: cursor
    prompt: "Build project"
    complexity: medium
    depends_on:
      - lint
  - name: test
    agent: codex
    prompt: "Run tests on {{branch}}"
    complexity: high
    depends_on:
      - build
  - name: deploy
    agent: claude
    prompt: "Deploy to {{deploy_target}}"
    complexity: medium
    depends_on:
      - test
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
      expect(result.summary).toBeDefined()
      expect(result.summary.taskCount).toBe(4)
    })

    test('validate_dag_yaml 应该返回任务摘要', async () => {
      const yaml = `
name: summary-test
tasks:
  - name: alpha
    agent: claude
    prompt: "Alpha"
    complexity: low
  - name: beta
    agent: cursor
    prompt: "Beta"
    complexity: high
    depends_on:
      - alpha
`
      const result = await page.evaluate(async (y: string) => {
        return await (window as any).trpc.test.ergatai.validateDagYaml.mutate({ yaml: y })
      }, yaml)

      expect(result.valid).toBe(true)
      expect(result.summary.taskCount).toBe(2)
    })
  })
})
