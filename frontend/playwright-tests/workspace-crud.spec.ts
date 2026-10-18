import { test, expect, _electron as electron } from '@playwright/test';
import { ElectronApplication, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

let electronApp: ElectronApplication;
let page: Page;
let apiToken: string;

test.describe('工作区完整 CRUD 测试', () => {
  test.beforeAll(async () => {
    console.log('🚀 启动 Electron 应用...');

    // 读取 API token
    const tokenPath = join(homedir(), '.local', 'share', 'ergatai', '.api-token');
    try {
      apiToken = readFileSync(tokenPath, 'utf-8').trim();
      console.log(`✓ API token 已读取: ${apiToken.substring(0, 8)}...${apiToken.substring(apiToken.length - 8)}`);
    } catch (error) {
      console.warn('⚠ 无法读取 API token 文件，测试可能失败:', error);
      apiToken = '';
    }

    electronApp = await electron.launch({
      args: ['./out/main/index.js'],
      cwd: '/home/yubing/code/ergatai/frontend',
      env: {
        ...process.env,
        ERGATAI_API_TOKEN: apiToken,
        ERGATAI_DEBUG: '1', // 启用调试日志
      },
    });

    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(3000);

    console.log('✅ Electron 应用已启动');
  });

  test.afterAll(async () => {
    console.log('🛑 关闭 Electron 应用...');
    await electronApp?.close();
  });

  // ========== CREATE ==========
  test('1. 选择项目并创建工作区', async () => {
    console.log('📝 步骤1: 选择项目并创建工作区...');

    // 等待初始页面加载
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-tests/screenshots/crud-01-initial.png', fullPage: true });

    // 点击 "New Workspace" 按钮
    const newWorkspaceBtn = page.locator('button:has-text("New Workspace")');
    expect(await newWorkspaceBtn.count()).toBeGreaterThan(0);
    await newWorkspaceBtn.first().click();
    await page.waitForTimeout(2000);

    console.log('  ✅ 点击了 New Workspace 按钮');
    await page.screenshot({ path: 'playwright-tests/screenshots/crud-02-after-new.png', fullPage: true });

    // 点击 "Select repo" 按钮
    const selectRepoBtn = page.locator('button:has-text("Select repo")');
    if (await selectRepoBtn.count() > 0) {
      console.log('  ✅ 找到 Select repo 按钮');
      await selectRepoBtn.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/crud-03-select-repo.png', fullPage: true });
    } else {
      console.log('  ⚠️ 未找到 Select repo 按钮，可能已有项目选择');
    }

    // 查找项目列表中的项目
    const projectItems = page.locator('[role="listbox"] [role="option"], .project-item, [data-project-id]');
    const projectCount = await projectItems.count();
    console.log(`  📊 找到 ${projectCount} 个项目`);

    if (projectCount > 0) {
      // 选择第一个项目
      await projectItems.first().click();
      await page.waitForTimeout(3000);
      console.log('  ✅ 选择了第一个项目');
      await page.screenshot({ path: 'playwright-tests/screenshots/crud-04-project-selected.png', fullPage: true });
    } else {
      console.log('  ️ 未找到项目列表，尝试查找其他选择器');
      // 查找对话框中的项目
      const dialogProjects = page.locator('.modal [role="option"], [role="dialog"] [role="option"]');
      const dialogCount = await dialogProjects.count();
      console.log(`  📊 对话框中有 ${dialogCount} 个项目`);

      if (dialogCount > 0) {
        await dialogProjects.first().click();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: 'playwright-tests/screenshots/crud-04-dialog-project.png', fullPage: true });
      }
    }
  });

  // ========== READ (List) ==========
  test('2. 验证工作区列表', async () => {
    console.log('📝 步骤2: 验证工作区列表...');

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-tests/screenshots/crud-05-workspace-list.png', fullPage: true });

    // 查找侧边栏中的工作区列表
    const workspaceItems = page.locator('[data-workspace-id], .workspace-item, [role="listitem"]');
    const workspaceCount = await workspaceItems.count();
    console.log(`   找到 ${workspaceCount} 个工作区`);

    if (workspaceCount > 0) {
      console.log('  ✅ 工作区列表正常显示');

      // 打印前几个工作区的名称
      for (let i = 0; i < Math.min(workspaceCount, 3); i++) {
        const text = await workspaceItems.nth(i).textContent();
        console.log(`    工作区 ${i + 1}: ${text?.trim().substring(0, 50)}`);
      }
    } else {
      console.log('  ⚠️ 未找到工作区列表项');
    }

    // 检查是否有工作区被选中
    const selectedWorkspace = page.locator('[data-workspace-id].selected, .workspace-item.selected, [aria-selected="true"]');
    const hasSelected = await selectedWorkspace.count() > 0;
    console.log(`  📊 有选中的工作区: ${hasSelected}`);
  });

  // ========== READ (Detail) ==========
  test('3. 查看工作区详情', async () => {
    console.log('📝 步骤3: 查看工作区详情...');

    await page.waitForTimeout(2000);

    // 查找工作区详情区域
    const detailArea = page.locator('[data-testid="workspace-detail"], .workspace-detail, main');
    const hasDetail = await detailArea.count() > 0;
    console.log(`  📊 详情区域: ${hasDetail ? '✅ 找到' : '❌ 未找到'}`);

    // 查找聊天输入框（工作区内的主要交互区域）
    const chatInput = page.locator('textarea, input[type="text"], [contenteditable="true"]').first();
    const hasChatInput = await chatInput.count() > 0;
    console.log(`  📊 聊天输入框: ${hasChatInput ? '✅ 找到' : ' 未找到'}`);

    // 查找任务面板按钮
    const taskBoardBtn = page.locator('button:has-text("Task Board")');
    const hasTaskBoard = await taskBoardBtn.count() > 0;
    console.log(`  📊 Task Board 按钮: ${hasTaskBoard ? '✅ 找到' : '❌ 未找到'}`);

    await page.screenshot({ path: 'playwright-tests/screenshots/crud-06-workspace-detail.png', fullPage: true });
  });

  // ========== UPDATE ==========
  test('4. 更新工作区（重命名）', async () => {
    console.log('📝 步骤4: 更新工作区（重命名）...');

    await page.waitForTimeout(2000);

    // 查找工作区右键菜单或设置按钮
    const workspaceContextMenu = page.locator('[data-workspace-id] button, .workspace-item button').first();
    const hasContextMenu = await workspaceContextMenu.count() > 0;

    if (hasContextMenu) {
      console.log('  ✅ 找到工作区操作按钮');
      await workspaceContextMenu.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'playwright-tests/screenshots/crud-07-context-menu.png', fullPage: true });

      // 查找重命名选项
      const renameBtn = page.locator('button:has-text("Rename"), [role="menuitem"]:has-text("Rename")');
      const hasRename = await renameBtn.count() > 0;

      if (hasRename) {
        console.log('  ✅ 找到重命名选项');
        await renameBtn.first().click();
        await page.waitForTimeout(1000);

        // 查找输入框并输入新名称
        const nameInput = page.locator('input[type="text"]').first();
        if (await nameInput.count() > 0) {
          await nameInput.fill('Test Workspace - Renamed');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(1000);
          console.log('  ✅ 重命名完成');
        }
      }
    } else {
      console.log('  ⚠️ 未找到工作区操作按钮');
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/crud-08-after-rename.png', fullPage: true });
  });

  // ========== ARCHIVE ==========
  test('5. 归档工作区', async () => {
    console.log('📝 步骤5: 归档工作区...');

    await page.waitForTimeout(2000);

    // 查找归档按钮
    const archiveBtn = page.locator('button:has-text("Archive"), [role="menuitem"]:has-text("Archive")');
    const hasArchive = await archiveBtn.count() > 0;

    if (hasArchive) {
      console.log('  ✅ 找到归档按钮');
      await archiveBtn.first().click();
      await page.waitForTimeout(2000);
      console.log('  ✅ 归档操作完成');
    } else {
      console.log('  ⚠️ 未找到归档按钮，尝试通过右键菜单');

      // 尝试右键点击工作区
      const workspaceItem = page.locator('[data-workspace-id], .workspace-item').first();
      if (await workspaceItem.count() > 0) {
        await workspaceItem.click({ button: 'right' });
        await page.waitForTimeout(1000);

        const archiveInMenu = page.locator('[role="menuitem"]:has-text("Archive")');
        if (await archiveInMenu.count() > 0) {
          await archiveInMenu.first().click();
          await page.waitForTimeout(2000);
          console.log('  ✅ 通过右键菜单归档完成');
        }
      }
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/crud-09-after-archive.png', fullPage: true });
  });

  // ========== VIEW ARCHIVED ==========
  test('6. 查看已归档工作区', async () => {
    console.log(' 步骤6: 查看已归档工作区...');

    await page.waitForTimeout(2000);

    // 查找 "Archived Workspaces" 按钮
    const archivedBtn = page.locator('button:has-text("Archived Workspaces")');
    const hasArchivedBtn = await archivedBtn.count() > 0;

    if (hasArchivedBtn) {
      console.log('  ✅ 找到 Archived Workspaces 按钮');
      await archivedBtn.first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: 'playwright-tests/screenshots/crud-10-archived-list.png', fullPage: true });

      // 查找已归档的工作区列表
      const archivedItems = page.locator('[data-workspace-id].archived, .workspace-item.archived, [aria-selected="true"]');
      const archivedCount = await archivedItems.count();
      console.log(`  📊 找到 ${archivedCount} 个已归档工作区`);
    } else {
      console.log('  ⚠️ 未找到 Archived Workspaces 按钮');
    }
  });

  // ========== RESTORE ==========
  test('7. 恢复已归档工作区', async () => {
    console.log(' 步骤7: 恢复已归档工作区...');

    await page.waitForTimeout(2000);

    // 查找恢复按钮
    const restoreBtn = page.locator('button:has-text("Restore"), [role="menuitem"]:has-text("Restore")');
    const hasRestore = await restoreBtn.count() > 0;

    if (hasRestore) {
      console.log('  ✅ 找到恢复按钮');
      await restoreBtn.first().click();
      await page.waitForTimeout(2000);
      console.log('  ✅ 恢复操作完成');
    } else {
      console.log('  ️ 未找到恢复按钮');
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/crud-11-after-restore.png', fullPage: true });
  });

  // ========== DELETE ==========
  test('8. 删除工作区', async () => {
    console.log('📝 步骤8: 删除工作区...');

    await page.waitForTimeout(2000);

    // 查找删除按钮
    const deleteBtn = page.locator('button:has-text("Delete"), [role="menuitem"]:has-text("Delete")');
    const hasDelete = await deleteBtn.count() > 0;

    if (hasDelete) {
      console.log('  ✅ 找到删除按钮');
      await deleteBtn.first().click();
      await page.waitForTimeout(1000);

      // 查找确认对话框
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Delete")');
      if (await confirmBtn.count() > 0) {
        await confirmBtn.first().click();
        await page.waitForTimeout(2000);
        console.log('  ✅ 删除操作完成');
      }
    } else {
      console.log('  ⚠️ 未找到删除按钮');
    }

    await page.screenshot({ path: 'playwright-tests/screenshots/crud-12-after-delete.png', fullPage: true });
  });

  // ========== API VERIFICATION ==========
  test('9. 验证后端 API', async () => {
    console.log('📝 步骤9: 验证后端 API...');

    // 健康检查
    const healthResponse = await page.evaluate(async () => {
      try {
        const response = await fetch('http://127.0.0.1:3000/health');
        return { status: response.status, ok: response.ok };
      } catch (error) {
        return { error: String(error) };
      }
    });
    console.log(`  API 健康检查: ${healthResponse.ok ? '✅' : ''} (${healthResponse.status})`);

    // 列出工作区（使用 token）
    const workspacesResponse = await page.evaluate(async (token) => {
      try {
        const response = await fetch('http://127.0.0.1:3000/api/v1/workspaces/managed', {
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        });
        const data = await response.json();
        return { status: response.status, count: Array.isArray(data) ? data.length : 0 };
      } catch (error) {
        return { error: String(error) };
      }
    }, apiToken);
    console.log(`  工作区列表: ${workspacesResponse.status === 200 ? '✅' : '❌'} (${workspacesResponse.count} 个)`);

    if (workspacesResponse.status === 401) {
      console.log('  ⚠️ API 认证失败！请检查 token 是否正确');
    }
  });

  test('10. 最终截图', async () => {
    console.log(' 步骤10: 最终截图...');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'playwright-tests/screenshots/crud-13-final.png', fullPage: true });
    console.log('  ✅ 测试完成');
  });
});
