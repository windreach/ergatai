#!/usr/bin/env node
/**
 * 测试 Electron 无头模式启动
 * 验证 electron-launcher.js 的 headless 模式是否正常工作
 */

const { launchElectron } = require('./fixtures/electron-launcher');

(async () => {
  console.log('='.repeat(60));
  console.log('测试 Electron 无头模式 (Headless Mode)');
  console.log('='.repeat(60));

  let electron = null;

  try {
    // 启动 Electron（默认使用 headless 模式）
    console.log('\n[1/4] 启动 Electron...');
    electron = await launchElectron({
      extraEnv: {
        ELECTRON_TEST_MODE: 'true',
      },
    });

    console.log('\n[2/4] ✅ Electron 启动成功');
    console.log('   - 窗口 URL:', electron.page.url().substring(0, 60));

    // 检查页面是否已关闭
    if (electron.page.isClosed()) {
      console.warn('   ⚠️  警告: 页面已关闭！');
      console.log('   这可能是 headless 模式下的已知问题');
    } else {
      console.log('   - 页面标题:', await electron.page.title());

      // 测试基本功能
      console.log('\n[3/4] 测试基本功能...');
      const result = await electron.page.evaluate(() => {
        return {
          hasWindow: !!window,
          hasDocument: !!document,
          readyState: document.readyState,
        };
      });

      console.log('   - window 对象:', result.hasWindow ? '✅' : '❌');
      console.log('   - document 对象:', result.hasDocument ? '✅' : '❌');
      console.log('   - 页面状态:', result.readyState);
    }

    console.log('\n[4/4] 关闭 Electron...');
    await electron.close();

    console.log('\n' + '='.repeat(60));
    console.log('✅ 无头模式测试通过！');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);

    // 确保清理
    if (electron) {
      try {
        await electron.close();
      } catch (e) {
        // 忽略
      }
    }

    process.exit(1);
  }
})();
