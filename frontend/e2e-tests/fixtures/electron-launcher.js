/**
 * Electron 测试启动器（通用模块）
 * 封装 xvfb 配置、启动参数、清理逻辑
 *
 * 使用方式：
 * const { launchElectron } = require('../fixtures/electron-launcher');
 * const { app, page } = await launchElectron();
 */

const { _electron: electron } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');

// 默认配置
const DEFAULT_CONFIG = {
  // Electron 可执行文件路径
  executablePath: path.join(__dirname, '../../node_modules/electron/dist/electron'),

  // 应用入口目录
  appDir: path.join(__dirname, '../..'),

  // 是否使用 xvfb（默认 false，改用 headless 模式）
  useXvfb: process.env.USE_XVFB === 'true',

  // 是否使用 headless 模式（默认 true）
  useHeadless: process.env.USE_HEADLESS !== 'false',

  // 额外的启动参数
  extraArgs: [],

  // 额外的环境变量
  extraEnv: {},

  // 工作目录
  cwd: path.join(__dirname, '../..'),
};

/**
 * 启动 Xvfb 虚拟显示
 */
function startXvfb() {
  return new Promise((resolve, reject) => {
    const display = ':99';
    const xvfb = spawn('Xvfb', [
      display,
      '-screen', '0', '1280x960x24',
      '-ac',
      '+extension', 'GLX',
      '+render',
      '-noreset',
    ], {
      stdio: 'ignore',
      detached: true,
    });

    xvfb.on('error', (err) => {
      reject(new Error(`Xvfb 启动失败: ${err.message}`));
    });

    // 等待 Xvfb 启动
    setTimeout(() => {
      if (xvfb.pid) {
        console.log(`✅ Xvfb 已启动 (PID: ${xvfb.pid}, Display: ${display})`);
        resolve({ process: xvfb, display });
      } else {
        reject(new Error('Xvfb 启动超时'));
      }
    }, 1000);
  });
}

/**
 * 启动 Electron 应用
 */
async function launchElectron(config = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  let xvfbProcess = null;
  let env = { ...process.env, ...mergedConfig.extraEnv };

  // 如果使用 xvfb，先启动 Xvfb
  if (mergedConfig.useXvfb) {
    try {
      const xvfb = await startXvfb();
      xvfbProcess = xvfb.process;
      env.DISPLAY = xvfb.display;
    } catch (error) {
      throw new Error(`无法启动 Xvfb: ${error.message}`);
    }
  }

  // 构建启动参数
  const args = [
    mergedConfig.appDir,
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    ...(mergedConfig.useHeadless ? ['--headless'] : []),
    ...mergedConfig.extraArgs,
  ];

  console.log(`\n启动 Electron (${mergedConfig.useHeadless ? 'Headless' : mergedConfig.useXvfb ? `xvfb ${env.DISPLAY}` : '原生'} 模式)...`);
  console.log('Args:', args.slice(0, 4).join(' '), '...');

  // 启动 Electron
  const app = await electron.launch({
    executablePath: mergedConfig.executablePath,
    args,
    env,
    cwd: mergedConfig.cwd,
  });

  // 监听主进程输出（诊断用）
  app.process().stdout.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('[Main]') || msg.includes('[App]')) {
      console.log('📤 Main:', msg.trim().substring(0, 80));
    }
  });

  app.process().stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ERROR')) {
      console.error('📤 Main stderr:', msg.trim().substring(0, 80));
    }
  });

  // 获取第一个窗口
  const page = await app.firstWindow();

  // 标记页面是否已关闭
  let pageClosed = false;

  // 监听错误（诊断用）
  page.on('pageerror', (error) => {
    console.error('❌ Page error:', error.message.substring(0, 80));
  });

  page.on('close', () => {
    console.log('⚠️  Window closed');
    pageClosed = true;
  });

  // 等待页面加载
  console.log('等待页面加载...');
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  console.log('✅ 页面加载完成');

  // 等待一小段时间，让应用完全初始化
  try {
    await page.waitForTimeout(1000);
  } catch (e) {
    // 如果页面已关闭，忽略这个错误
    if (e.message.includes('closed')) {
      console.warn('⚠️  页面在等待期间关闭');
    } else {
      throw e;
    }
  }

  // 检查页面是否仍然打开
  if (page.isClosed()) {
    console.warn('⚠️  页面已关闭，但 Electron 启动成功');
  }

  console.log(`✅ Electron 已启动，窗口: ${page.url().substring(0, 60)}...`);

  // 返回应用实例、页面和清理函数
  return {
    app,
    page,
    close: async () => {
      console.log('\n关闭 Electron...');
      try {
        // 先关闭所有窗口
        const pages = await app.context().pages();
        for (const p of pages) {
          try {
            await p.close();
          } catch (e) {
            // 忽略
          }
        }

        // 再关闭应用
        await app.close();
        console.log('✅ Electron 已关闭');
      } catch (error) {
        console.error('关闭 Electron 失败:', error.message);
        // 强制杀死进程
        try {
          const proc = app.process();
          if (proc && !proc.killed) {
            proc.kill('SIGKILL');
          }
        } catch (e) {
          // 忽略
        }
      }

      // 关闭 Xvfb
      if (xvfbProcess) {
        try {
          xvfbProcess.kill('SIGKILL');
          console.log('✅ Xvfb 已关闭');
        } catch (e) {
          // 忽略
        }
      }
    },
  };
}

/**
 * 截图辅助函数
 */
async function takeScreenshot(page, name, outputDir = 'e2e-tests/reports') {
  const fs = require('fs');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const filePath = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  console.log(`📸 截图已保存: ${filePath}`);
}

/**
 * 等待元素并点击
 */
async function waitForAndClick(page, selector, options = {}) {
  const timeout = options.timeout || 10000;
  await page.waitForSelector(selector, { timeout });
  await page.click(selector);
}

/**
 * 等待元素并填写
 */
async function waitForAndFill(page, selector, value, options = {}) {
  const timeout = options.timeout || 10000;
  await page.waitForSelector(selector, { timeout });
  await page.fill(selector, value);
}

module.exports = {
  launchElectron,
  takeScreenshot,
  waitForAndClick,
  waitForAndFill,
  DEFAULT_CONFIG,
};
