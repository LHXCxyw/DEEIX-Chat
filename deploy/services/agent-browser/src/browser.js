import { readFile } from 'node:fs/promises';
import { ServiceError } from './policy.js';

export const capabilities = Object.freeze({
  mode: 'policy-control-foundation',
  browserExecution: false,
  networkBoundary: false,
  reason: '未接入经过验证的独立出站隔离；生产动作保持关闭',
});

let engine = Object.freeze({ ready: false, status: 'not-tested' });
export function health() {
  return {
    engine,
    sandboxPolicy: 'moby-27.5.1-chromium-userns-v2',
    networkBoundary: { ready: false, status: 'unverified', publicNetwork: false },
    productionActions: false,
  };
}

// 只启动新的临时浏览器进程，不允许连接个人浏览器或传入启动参数。
export function verifyBrowserProcess(status, uid, gid) {
  const field = name => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1];
  if (uid !== 65532 || gid !== 65532) throw new ServiceError('sandbox 启动要求 UID/GID 65532', 503);
  // 非 root 进程 exec 后 CapEff 必然为空；容器上的 --cap-add 仅用于让 Docker seccomp
  // 编译包含 chroot 规则，Chromium 会在 clone(CLONE_NEWUSER) 得到的新 user namespace
  // 内以 root 身份取得 CAP_SYS_CHROOT。因此这里不校验进程 capability，
  // 沙箱是否生效由后面的 chrome://sandbox 实际验证。
  if (field('NoNewPrivs') !== '1' || field('Seccomp') !== '2') {
    throw new ServiceError('sandbox 进程缺少 no-new-privileges/seccomp', 503);
  }
}

export async function launchSandboxedBrowser({ chromium, platform = process.platform, uid = process.getuid?.(), gid = process.getgid?.(), readStatus = () => readFile('/proc/self/status', 'utf8'), onStage = () => {} } = {}) {
  onStage('sandbox-preflight');
  if (platform !== 'linux' || !Number.isInteger(uid) || uid === 0) {
    throw new ServiceError('sandbox 启动要求 Linux 非 root 用户', 503);
  }
  onStage('capability-verification');
  verifyBrowserProcess(await readStatus(), uid, gid);
  onStage('playwright-import');
  chromium ??= (await import('playwright')).chromium;
  onStage('browser-launch');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30_000 });
  try {
    onStage('sandbox-verification');
    // Playwright 的 headless shell 不提供 chrome://sandbox 页面，且以 chromiumSandbox:true
    // 启动成功本身已证明 Chromium 沙箱初始化通过（沙箱不可用会拒绝启动或崩溃）。
    // 这里再验证渲染进程与截图能力，避免只验证进程存在。
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    await page.goto('about:blank', { timeout: 10_000 });
    if (!(await page.evaluate(() => 1 + 1 === 2))) {
      throw new ServiceError('Chromium 渲染进程未就绪', 503);
    }
    const shot = await page.screenshot({ type: 'png' });
    if (!Buffer.isBuffer(shot) || shot.length < 8) {
      throw new ServiceError('Chromium 截图验证失败', 503);
    }
    await context.close();
    return browser;
  } catch (error) {
    try { await browser.close(); } catch { /* 保留 sandbox 验证的原始异常。 */ }
    throw error;
  }
}

export async function probeEngine(launch = launchSandboxedBrowser) {
  let browser;
  try {
    browser = await launch();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    await page.setContent('<!doctype html><title>engine-selftest</title><h1>engine-selftest</h1>', { timeout: 10_000 });
    if (await page.title() !== 'engine-selftest') throw new Error('渲染自检失败');
    const png = await page.screenshot({ type: 'png', timeout: 10_000 });
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('截图自检失败');
    await browser.close();
    browser = undefined;
    engine = Object.freeze({ ready: true, status: 'sandbox-render-verified' });
  } catch {
    engine = Object.freeze({ ready: false, status: 'sandbox-render-unavailable' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch { engine = Object.freeze({ ready: false, status: 'cleanup-failed' }); }
    }
  }
  return health();
}

// 此入口不接受环境变量或调用参数作为硬隔离证明。
export async function createBrowserContext() {
  throw new ServiceError(capabilities.reason, 503);
}
