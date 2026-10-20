import test from 'node:test';
import assert from 'node:assert/strict';
import { launchSandboxedBrowser as launch, verifyBrowserProcess, probeEngine, health, createBrowserContext } from '../src/browser.js';
// 非 root 进程的 CapEff/CapPrm 实际为空；capability 不是本层判据。
const safeStatus = 'CapEff:\t0000000000000000\nCapPrm:\t0000000000000000\nCapBnd:\t0000000000040000\nNoNewPrivs:\t1\nSeccomp:\t2\n';
const launchSandboxedBrowser = options => launch({ gid: 65532, readStatus: async () => safeStatus, ...options });
import { renderOffline, readHtml } from '../src/offline.js';
import { createServer } from '../src/server.js';

function fake(status = 'Namespace sandbox Yes\nSeccomp-BPF sandbox Yes') {
  const calls = [];
  const page = {
    goto: async url => calls.push(['goto', url]),
    evaluate: async () => true,
    locator: () => ({ innerText: async () => status }),
    setContent: async html => calls.push(['html', html]),
    title: async () => 'engine-selftest',
    screenshot: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
  };
  const context = {
    newPage: async () => page,
    close: async () => calls.push(['contextClose']),
    setDefaultTimeout: value => calls.push(['timeout', value]),
    route: async (pattern, handler) => { context.http = handler; },
    routeWebSocket: async (pattern, handler) => { context.ws = handler; },
  };
  const browser = {
    newContext: async options => { calls.push(['context', options]); return context; },
    close: async () => calls.push(['close']),
  };
  const chromium = { launch: async options => { calls.push(['launch', options]); return browser; } };
  return { calls, context, page, browser, chromium };
}

test('非 root 空 CapEff 允许通过，身份或防护漂移时拒绝启动', async () => {
  // 回归：真实容器中 UID 65532 的 CapEff 为空，不能被当成配置错误拒绝。
  verifyBrowserProcess(safeStatus, 65532, 65532);
  for (const status of ['', safeStatus.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), safeStatus.replace('Seccomp:\t2', 'Seccomp:\t0')]) {
    const state = fake();
    await assert.rejects(launchSandboxedBrowser({ chromium: state.chromium, platform: 'linux', uid: 65532, readStatus: async () => status }), { status: 503 });
    assert.equal(state.calls.length, 0);
  }
  assert.throws(() => verifyBrowserProcess(safeStatus, 0, 65532));
  assert.throws(() => verifyBrowserProcess(safeStatus, 65532, 0));
});

test('launcher 拒绝 root/非 Linux，固定 sandbox 参数并验证内核 sandbox 状态', async () => {
  const state = fake();
  for (const identity of [{ platform: 'win32', uid: 1000 }, { platform: 'linux', uid: 0 }]) {
    await assert.rejects(launchSandboxedBrowser({ chromium: state.chromium, ...identity }), { status: 503 });
  }
  assert.equal(state.calls.length, 0);
  const browser = await launchSandboxedBrowser({ chromium: state.chromium, platform: 'linux', uid: 65532 });
  assert.deepEqual(state.calls[0], ['launch', { headless: true, chromiumSandbox: true, timeout: 30_000 }]);
  assert.ok(state.calls.some(call => call[0] === 'contextClose'));
  await browser.close();
  const brokenRender = fake();
  brokenRender.page.evaluate = async () => false;
  await assert.rejects(launchSandboxedBrowser({ chromium: brokenRender.chromium, platform: 'linux', uid: 65532 }), { status: 503 });
  assert.equal(brokenRender.calls.at(-1)[0], 'close');
  const brokenShot = fake();
  brokenShot.page.screenshot = async () => Buffer.alloc(0);
  await assert.rejects(launchSandboxedBrowser({ chromium: brokenShot.chromium, platform: 'linux', uid: 65532 }), { status: 503 });
  assert.equal(brokenShot.calls.at(-1)[0], 'close');
});

test('sandbox 验证与关闭同时失败时保留验证异常和阶段', async () => {
  const state = fake();
  const knownError = new Error('known-sandbox-verification');
  const stages = [];
  state.page.goto = async () => { throw knownError; };
  state.browser.close = async () => { throw new Error('cleanup-error'); };
  await assert.rejects(launchSandboxedBrowser({ chromium: state.chromium, platform: 'linux', uid: 65532, onStage: stage => stages.push(stage) }), error => error === knownError);
  assert.equal(stages.at(-1), 'sandbox-verification');
});

test('engine 真实渲染契约与网络 readiness 分离，成功也不能解锁生产', async () => {
  const state = fake();
  const result = await probeEngine(async () => state.browser);
  assert.equal(result.engine.ready, true);
  assert.equal(result.networkBoundary.ready, false);
  assert.equal(result.productionActions, false);
  await assert.rejects(createBrowserContext({ networkBoundary: true }), { status: 503 });
  state.page.screenshot = async () => { throw Error('失败'); };
  assert.equal((await probeEngine(async () => state.browser)).engine.ready, false);
  assert.equal(health().networkBoundary.ready, false);
  assert.equal(state.calls.filter(call => call[0] === 'close').length, 2);
});

test('离线渲染禁 JS/SW/download，拒绝 HTTP/WS，注入优先 CSP，关闭浏览器', async () => {
  const state = fake();
  const result = await renderOffline('<h1>内容</h1><img src="https://example.com">', async () => state.browser);
  assert.equal(result.mimeType, 'image/png');
  const options = state.calls.find(call => call[0] === 'context')[1];
  assert.equal(options.offline, true);
  assert.equal(options.javaScriptEnabled, false);
  assert.equal(options.serviceWorkers, 'block');
  assert.equal(options.acceptDownloads, false);
  const html = state.calls.find(call => call[0] === 'html')[1];
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<h1>'));
  let denied;
  await state.context.http({ abort: async reason => { denied = reason; } });
  assert.equal(denied, 'blockedbyclient');
  let closed = false;
  await state.context.ws({ close: () => { closed = true; } });
  assert.equal(closed, true);
  assert.equal(state.calls.at(-1)[0], 'close');
  state.page.setContent = async () => { throw Error('渲染失败'); };
  await assert.rejects(renderOffline('x', async () => state.browser));
  assert.equal(state.calls.filter(call => call[0] === 'close').length, 2);
});

test('健康接口需动作认证，engine 状态不等于公网就绪', async () => {
  const config = { controlToken: 'a'.repeat(43), actionToken: 'b'.repeat(43) };
  const server = createServer(config);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1/health`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${config.actionToken}` } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(typeof result.engine.ready, 'boolean');
    assert.equal(result.networkBoundary.ready, false);
    assert.equal(result.productionActions, false);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});

test('输入配额在启动之前拒绝，stdin 累积配额受控', async () => {
  let launched = false;
  await assert.rejects(renderOffline('x'.repeat(1024 * 1024 + 1), async () => { launched = true; }), { status: 413 });
  assert.equal(launched, false);
  await assert.rejects(readHtml((async function* () { yield Buffer.alloc(1024 * 1024); yield Buffer.from('x'); })()), { status: 413 });
  assert.equal(await readHtml((async function* () { yield Buffer.from('内容'); })()), '内容');
});
