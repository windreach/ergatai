/**
 * E2E: conversation model survives spawn / suspend / resume.
 *
 * This launches the real Electron app + real ergatai backend with a mock ACP
 * agent profile, then exercises the canonical ensure path through both REST and
 * the renderer tRPC bridge.
 */

import { test, expect, describe, beforeAll, afterAll } from '@playwright/test'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import {
  api,
  cleanupIntegration,
  launchIntegrationElectron,
} from '../../fixtures/integration-launcher'

const authHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${api.token}`,
}

async function postJson(pathname: string, body: unknown): Promise<any> {
  const response = await fetch(`${api.baseUrl}${pathname}`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) {
    throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(json)}`)
  }
  return json
}

describe('E2E: 统一 agent 启动与 conversation model', () => {
  let electron: any
  let page: any
  let dataDir: string
  let workDir: string

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ergatai-e2e-launch-data-'))
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ergatai-e2e-launch-work-'))
    // Isolate the backend database and profile registry from the developer's
    // real ~/.local/share/ergatai data.
    process.env.ERGATAI_DATA_DIR = dataDir

    const launched = await launchIntegrationElectron()
    electron = launched.electron
    page = launched.page
  }, 120_000)

  afterAll(async () => {
    await cleanupIntegration(electron)
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.rm(workDir, { recursive: true, force: true })
  })

  test('selected model survives spawn, suspend, and resume', async () => {
    const mockScript = path.resolve(
      __dirname,
      '../../../../scripts/mock-acp-agent.py',
    )
    await api.registerAgentProfile({
      name: 'mock-acp',
      command: `python3 ${mockScript}`,
      agent_type: 'acp',
    })

    const workspace = await api.createWorkspace({
      name: 'E2E Launch Workspace',
      work_dir: workDir,
    })
    expect(workspace.workspace_id).toBeTruthy()

    const chat = await postJson('/api/v1/chats', {
      workspace_id: workspace.workspace_id,
      name: 'E2E Launch Chat',
    })
    expect(chat.id).toBeTruthy()

    const conversation = await postJson('/api/v1/conversations', {
      chat_id: chat.id,
      name: 'E2E Launch Conversation',
    })
    expect(conversation.id).toBeTruthy()

    // Explicit selection seeds the durable conversation setting and launches.
    const ensured = await postJson('/api/v1/agent-launch/ensure', {
      conversation_id: conversation.id,
      profile: 'mock-acp',
      model: 'glm-5.3-flash',
      model_mode: 'override',
    })
    expect(ensured.action).toBe('spawned')
    expect(ensured.model?.selection?.id).toBe('glm-5.3-flash')
    expect(ensured.model_source).toBe('request')

    // The renderer tRPC bridge must expose the same durable setting.
    const settings = await page.evaluate(
      async (conversationId: string) => {
        return await (window as any).trpc.ergatai.getConversationLaunchSettings.query({
          conversationId,
        })
      },
      conversation.id,
    )
    expect(settings?.model).toBe('glm-5.3-flash')

    // Suspend, then ensure again without a model. The durable conversation
    // selection must be restored instead of the adapter native default.
    await postJson(`/api/v1/agents/${ensured.agent_id}/suspend`, {
      reason: 'manual',
    })

    const resumed = await postJson('/api/v1/agent-launch/ensure', {
      conversation_id: conversation.id,
    })
    expect(resumed.action).toBe('resumed')
    expect(resumed.model?.selection?.id).toBe('glm-5.3-flash')

    // Cleanup the live process; the temp data dir is removed in afterAll.
    await fetch(`${api.baseUrl}/api/v1/agents/${resumed.agent_id}`, {
      method: 'DELETE',
      headers: authHeaders,
    }).catch(() => {})
  }, 180_000)
})
