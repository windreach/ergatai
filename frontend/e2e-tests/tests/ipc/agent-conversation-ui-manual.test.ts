/**
 * 手动测试 - Agent 间对话 UI 渲染
 *
 * 此测试用于手动验证 agent 间对话的 UI 渲染效果。
 * 运行后会启动 Electron 应用，您需要手动执行以下操作：
 *
 * 1. 创建 workspace 和多个 agent
 * 2. 在 agent 之间发送消息
 * 3. 验证消息在 UI 中的渲染效果
 * 4. 检查 side panel 中的对话显示
 *
 * 测试会自动录制 trace、截图和视频，保存在 test-results/ 目录。
 */

import { test, expect, describe } from '@playwright/test'
import { launchIntegrationElectron, cleanupIntegration } from '../../fixtures/integration-launcher'

describe('手动测试: Agent 间对话 UI', () => {
  test('手动验证 agent 对话渲染', async ({ page }) => {
    // 启动 Electron 应用
    const { electron, page: electronPage } = await launchIntegrationElectron()
    page = electronPage

    try {
      // 等待应用完全加载
      await page.waitForTimeout(3000)

      // 截图记录初始状态
      await page.screenshot({ path: 'test-results/01-initial-state.png' })

      console.log('\n========================================')
      console.log('🎬 手动测试开始')
      console.log('========================================')
      console.log('请执行以下操作：')
      console.log('1. 创建 workspace')
      console.log('2. 启动 2-3 个 agent')
      console.log('3. 在 agent 之间发送消息')
      console.log('4. 观察消息渲染效果')
      console.log('5. 检查 side panel 对话显示')
      console.log('========================================\n')

      // 等待用户手动操作（最多 5 分钟）
      console.log('⏳ 等待手动操作... (按 Ctrl+C 结束)')

      // 每 30 秒截图一次
      let screenshotIndex = 2
      const maxScreenshots = 10

      for (let i = 0; i < maxScreenshots; i++) {
        await page.waitForTimeout(30000) // 30 秒
        await page.screenshot({ path: `test-results/${String(screenshotIndex).padStart(2, '0')}-manual-${i + 1}.png` })
        console.log(`📸 截图 ${screenshotIndex} 已保存`)
        screenshotIndex++
      }

      console.log('\n✅ 手动测试完成，请查看 test-results/ 目录中的截图和视频')

    } finally {
      await cleanupIntegration(electron)
    }
  })
})
