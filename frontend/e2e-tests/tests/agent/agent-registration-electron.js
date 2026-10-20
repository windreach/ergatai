#!/usr/bin/env node
/**
 * Agent 注册 UI 测试
 * 使用通用 Electron 启动器
 */

const { launchElectron, takeScreenshot } = require('../../fixtures/electron-launcher');
const path = require('path');
const fs = require('fs');

const REPORTS_DIR = path.join(__dirname, '../../reports');

// 确保 reports 目录存在
if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

async function selectProject(page, projectName) {
  console.log(`\n=== 选择项目：${projectName} ===`);

  // 1. 点击 "Select workspace" 按钮
  await page.waitForSelector('button:has-text("Select workspace")', { timeout: 10000 });
  await page.click('button:has-text("Select workspace")');

  // 2. 等待下拉菜单出现
  await page.waitForTimeout(1000);

  // 3. 点击目标项目
  await page.waitForSelector(`text=${projectName}`, { timeout: 5000 });
  await page.click(`text=${projectName}`);

  // 4. 等待页面加载
  await page.waitForTimeout(2000);

  // 截图查看当前状态
  await takeScreenshot(page, '02-project-selected', REPORTS_DIR);

  console.log(`✅ 项目 "${projectName}" 已选择`);
}

async function navigateToAddAgent(page) {
  console.log('\n=== 导航到 Add Agent 页面 ===');

  // 点击左侧边栏的 "Add Agent" 按钮
  await page.waitForSelector('button:has-text("Add Agent")', { timeout: 10000 });
  await page.click('button:has-text("Add Agent")');

  // 等待页面加载
  await page.waitForTimeout(2000);

  // 截图查看当前状态
  await takeScreenshot(page, '03-add-agent-page', REPORTS_DIR);

  console.log('✅ 已导航到 Add Agent 页面');
}

async function setupMockAgent(page, agentName, startupCommand) {
  console.log(`\n=== 注册 Agent: ${agentName} ===`);

  // 滚动到页面底部找到表单
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // 截图查看表单
  await takeScreenshot(page, 'before-agent-form', REPORTS_DIR);

  // 查找并填写表单
  const nameInput = await page.$('input[placeholder*="name" i], #agent-name');
  const commandInput = await page.$('textarea[placeholder*="command" i], #startup-command, input[placeholder*="command" i]');

  if (!nameInput || !commandInput) {
    // 尝试查找其他表单元素
    const inputs = await page.$$('input');
    console.log(`找到 ${inputs.length} 个 input 元素`);

    const textareas = await page.$$('textarea');
    console.log(`找到 ${textareas.length} 个 textarea 元素`);

    throw new Error('找不到表单元素');
  }

  // 填写表单
  await nameInput.fill(agentName);
  await commandInput.fill(startupCommand);

  // 点击创建按钮
  const createButton = await page.$('button:has-text("Create agent"), button:has-text("创建"), button:has-text("Add agent")');
  if (createButton) {
    await createButton.click();
    await page.waitForTimeout(2000);
  }

  // 截图查看结果
  await takeScreenshot(page, 'after-agent-create', REPORTS_DIR);

  console.log(`✅ Agent "${agentName}" 注册成功`);
}

async function main() {
  console.log('========================================');
  console.log('Electron UI 测试 (使用通用启动器)');
  console.log('========================================');

  const results = [];
  let electron;

  try {
    // 使用通用启动器
    electron = await launchElectron();
    const { page } = electron;

    // 截图：初始状态
    await takeScreenshot(page, '01-initial', REPORTS_DIR);
    console.log('截图已保存：01-initial.png');

    // 测试 1：选择项目
    try {
      await selectProject(page, 'ergatai');
      results.push({ test: '选择 ergatai 项目', passed: true });
      console.log('✅ 测试 1 通过');
    } catch (error) {
      console.error('❌ 测试 1 失败:', error.message);
      await takeScreenshot(page, '02-project-failed', REPORTS_DIR);
      results.push({ test: '选择 ergatai 项目', passed: false });
    }

    // 测试 2：导航到 Add Agent 页面
    try {
      await navigateToAddAgent(page);
      results.push({ test: '导航到 Add Agent 页面', passed: true });
      console.log('✅ 测试 2 通过');
    } catch (error) {
      console.error('❌ 测试 2 失败:', error.message);
      await takeScreenshot(page, '03-add-agent-failed', REPORTS_DIR);
      results.push({ test: '导航到 Add Agent 页面', passed: false });
    }

    // 测试 3：注册第一个 Mock Agent
    try {
      await setupMockAgent(page, 'Mock Agent 1', 'python3 /root/ergatai/scripts/mock-acp-agent.py agent-1');
      results.push({ test: '注册第一个 Mock Agent', passed: true });
      console.log('✅ 测试 3 通过');
    } catch (error) {
      console.error('❌ 测试 3 失败:', error.message);
      results.push({ test: '注册第一个 Mock Agent', passed: false });
    }

    // 测试 4：注册第二个 Mock Agent
    try {
      await setupMockAgent(page, 'Mock Agent 2', 'python3 /root/ergatai/scripts/mock-acp-agent.py agent-2');
      results.push({ test: '注册第二个 Mock Agent', passed: true });
      console.log('✅ 测试 4 通过');
    } catch (error) {
      console.error('❌ 测试 4 失败:', error.message);
      results.push({ test: '注册第二个 Mock Agent', passed: false });
    }

  } finally {
    // 关闭 Electron 应用
    if (electron) {
      await electron.close();
    }
  }

  // 输出测试结果
  console.log('\n========================================');
  console.log('测试结果汇总');
  console.log('========================================');
  for (const result of results) {
    const status = result.passed ? '✅' : '❌';
    console.log(`${status} ${result.test}`);
  }

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  console.log(`\n总计：${passedCount}/${totalCount} 通过`);

  if (passedCount < totalCount) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('测试运行失败:', error);
  process.exit(1);
});
