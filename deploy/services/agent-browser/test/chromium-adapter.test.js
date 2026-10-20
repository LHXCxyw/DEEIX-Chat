import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachTaskBrowser, launchChromiumTask } from '../src/chromium-adapter.js';
import { createServer } from '../src/server.js';
import { Policy } from '../src/policy.js';

function fake() {
  const context = new EventEmitter();
  const calls = [];
  context.setDefaultTimeout = value => calls.push(['timeout', value]);
  context.setDefaultNavigationTimeout = value => calls.push(['navigationTimeout', value]);
  context.routeWebSocket = async (pattern, handler) => { context.ws = handler; };
  context.route = async (pattern, handler) => { context.routeHandler = handler; };
  context.newPage = async () => {
    const page = new EventEmitter();
    page.isClosed = () => false;
    page.url = () => 'https://preview.example.com/';
    page.goto = async (url, options) => { calls.push(['goto', url, options]); };
    page.locator = selector => ({
      click: async options => calls.push(['click', selector, options]),
      fill: async (value, options) => calls.push(['fill', selector, value, options]),
    });
    page.keyboard = { press: async key => calls.push(['press', key]) };
    page.screenshot = async options => { calls.push(['screenshot', options]); return Buffer.from('png'); };
    context.emit('page', page);
    return page;
  };
  const browser = {
    closes: 0,
    async newContext(options) { calls.push(['context', options]); return context; },
    async close() { this.closes++; },
  };
  return { browser, context, calls };
}
const authorizeRequest = async url => {
  if (!url.startsWith('https://preview.example.com/')) throw Object.assign(Error('拒绝'), { status: 403 });
  return url;
};
function routeFor(context, url = 'https://preview.example.com/file') {
  const result = {};
  const route = {
    request: () => ({ url: () => url, allHeaders: async () => ({ host: 'ignored', 'accept-encoding': 'gzip' }),
      method: () => 'GET', postDataBuffer: () => null, frame: () => ({ page: () => context.page }) }),
    abort: async reason => { result.abort = reason; },
    fulfill: async value => { result.fulfilled = value; },
  };
  return { route, result };
}
async function harness(transport) {
  const state = fake();
  state.context.on('page', page => { state.context.page ??= page; });
  state.adapter = await attachTaskBrowser(state.browser, { authorizeRequest, transport });
  return state;
}

test('生产启动及独立启动入口都不能凭参数/env 开启执行', async () => {
  await assert.rejects(launchChromiumTask({ networkBoundary: true, chromiumSandbox: false }), { status: 503 });
  const server = createServer({ controlToken: 'a'.repeat(43), actionToken: 'b'.repeat(43) });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${'a'.repeat(43)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: { previewOrigin: 'https://8.8.8.8', expiresAt: Date.now() + 60000 } }),
    });
    assert.equal(response.status, 503);
  } finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
});

test('每任务独立 context、SW/WS 阻断、typed 动作与真实 browser.close', async () => {
  const a = await harness();
  const b = await harness();
  assert.notEqual(a.context, b.context);
  assert.deepEqual(a.calls[0], ['context', { serviceWorkers: 'block', acceptDownloads: false }]);
  let wsClosed = false;
  a.context.ws({ close() { wsClosed = true; } });
  assert.equal(wsClosed, true);
  await a.adapter.perform({ type: 'navigate', url: 'https://preview.example.com/' });
  await a.adapter.perform({ type: 'click', selector: '#go' });
  await a.adapter.perform({ type: 'fill', selector: '#name', value: 'text' });
  await a.adapter.perform({ type: 'press', key: 'Enter' });
  assert.equal((await a.adapter.perform({ type: 'screenshot' })).data, Buffer.from('png').toString('base64'));
  await assert.rejects(a.adapter.perform({ type: 'evaluate', script: '1' }));
  await assert.rejects(a.adapter.perform({ type: 'navigate', url: 'https://evil.com/' }), { status: 403 });
  await assert.rejects(a.adapter.perform({ type: 'screenshot', page: 1 }), { status: 404 });
  await a.context.newPage();
  await a.adapter.perform({ type: 'screenshot', page: 1 });
  await a.adapter.close();
  await a.adapter.close();
  assert.equal(a.browser.closes, 1);
  assert.equal(b.browser.closes, 0);
  await b.adapter.close();
});

test('console/errors/failedRequests 有界记录且读取即消费', async () => {
  const { adapter, context } = await harness();
  for (let i = 0; i < 205; i++) context.page.emit('console', { type: () => 'log', text: () => String(i) });
  context.page.emit('pageerror', new Error('页面失败'));
  context.page.emit('requestfailed', { url: () => 'https://preview.example.com/fail', failure: () => ({ errorText: 'failed' }) });
  const logs = await adapter.perform({ type: 'console' });
  assert.equal(logs.entries.length, 200);
  assert.equal(logs.entries[0].text, '5');
  assert.equal((await adapter.perform({ type: 'console' })).entries.length, 0);
  assert.equal((await adapter.perform({ type: 'errors' })).entries[0].message, '页面失败');
  assert.equal((await adapter.perform({ type: 'failedRequests' })).entries[0].error, 'failed');
  await adapter.close();
});

test('route 逐请求授权、手动重定向、不信任跨 origin 与混合 DNS', async () => {
  let calls = 0;
  const { adapter, context } = await harness(async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.host, undefined);
    return new Response(null, { status: 302, headers: { location: 'https://evil.com/' } });
  });
  const first = routeFor(context);
  await context.routeHandler(first.route);
  assert.equal(first.result.fulfilled.status, 302);
  const denied = routeFor(context, 'https://evil.com/');
  await context.routeHandler(denied.route);
  assert.equal(denied.result.abort, 'blockedbyclient');
  assert.equal(calls, 1);
  await adapter.close();
  const state = fake();
  const p = new Policy({ previewOrigin: 'https://preview.example.com', expiresAt: Date.now() + 60000 },
    async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }]);
  const guarded = await attachTaskBrowser(state.browser, { authorizeRequest: url => p.check(url), transport: async () => { throw Error('不可触达'); } });
  const mixed = routeFor(state.context);
  await state.context.routeHandler(mixed.route);
  assert.equal(mixed.result.abort, 'blockedbyclient');
  await guarded.close();
});

test('附件流完成前计数，超限停止消费并关闭浏览器', async () => {
  let produced = 0;
  let finalized = false;
  const body = (async function* () {
    try { for (let i = 0; i < 60; i++) { produced++; yield Buffer.alloc(1024 * 1024); } }
    finally { finalized = true; }
  })();
  const state = await harness(async () => ({ headers: new Headers({ 'content-disposition': 'attachment' }), body }));
  const request = routeFor(state.context);
  await state.context.routeHandler(request.route);
  assert.equal(produced, 51);
  assert.equal(finalized, true);
  assert.equal(request.result.abort, 'blockedbyclient');
  assert.equal(state.browser.closes, 1);
  await assert.rejects(state.adapter.perform({ type: 'console' }), { status: 413 });
});

test('附件 ID 仅属于当前页面和任务，下载只读一次', async () => {
  const state = await harness(async () => new Response('file', { headers: { 'content-disposition': 'attachment; filename="x"' } }));
  const request = routeFor(state.context);
  await state.context.routeHandler(request.route);
  assert.equal(request.result.fulfilled.status, 204);
  const { downloads } = await state.adapter.perform({ type: 'click', selector: '#download' });
  assert.equal(downloads[0].bytes, 4);
  await state.context.newPage();
  await assert.rejects(state.adapter.perform({ type: 'download', id: downloads[0].id, page: 1 }), { status: 404 });
  const stream = await state.adapter.perform({ type: 'download', id: downloads[0].id });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'file');
  await assert.rejects(state.adapter.perform({ type: 'download', id: downloads[0].id }), { status: 404 });
  await state.adapter.close();
});

test('下载 Content-Length 预检不读取流，原生下载拒绝且关闭', async () => {
  let read = false;
  const state = await harness(async () => ({ headers: new Headers({ 'content-disposition': 'attachment', 'content-length': String(51 * 1024 * 1024) }),
    body: (async function* () { read = true; yield Buffer.from('x'); })() }));
  await state.context.routeHandler(routeFor(state.context).route);
  assert.equal(read, false);
  assert.equal(state.browser.closes, 1);
  const native = await harness();
  let canceled = false;
  native.context.page.emit('download', { cancel: async () => { canceled = true; } });
  await native.adapter.close();
  assert.equal(canceled, true);
  assert.equal(native.browser.closes, 1);
});

test('第三页、超时、初始化失败均关闭真实 Browser 对象', async () => {
  const state = await harness();
  await state.context.newPage();
  await state.context.newPage();
  await assert.rejects(state.adapter.perform({ type: 'console' }), { status: 409 });
  assert.equal(state.browser.closes, 1);
  const slow = await harness();
  slow.context.page.keyboard.press = () => new Promise(() => {});
  await assert.rejects(slow.adapter.perform({ type: 'press', key: 'Enter' }, { timeout: 5 }), { status: 408 });
  assert.equal(slow.browser.closes, 1);
  const broken = fake();
  broken.context.routeWebSocket = undefined;
  await assert.rejects(attachTaskBrowser(broken.browser, { authorizeRequest }));
  assert.equal(broken.browser.closes, 1);
});

test('适配器累计附件 200MiB 在流读取阶段限制', async () => {
  let count = 50;
  const chunk = Buffer.alloc(1024 * 1024);
  const state = await harness(async () => ({
    headers: new Headers({ 'content-disposition': 'attachment' }),
    body: (async function* () { for (let i = 0; i < count; i++) yield chunk; })(),
  }));
  for (let i = 0; i < 4; i++) {
    await state.context.routeHandler(routeFor(state.context).route);
    const { downloads } = await state.adapter.perform({ type: 'console' });
    assert.equal(downloads[0].bytes, 50 * 1024 * 1024);
    const stream = await state.adapter.perform({ type: 'download', id: downloads[0].id });
    for await (const data of stream) assert.ok(data.length <= 65536);
  }
  count = 1;
  await state.context.routeHandler(routeFor(state.context).route);
  await assert.rejects(state.adapter.perform({ type: 'console' }), { status: 413 });
  assert.equal(state.browser.closes, 1);
});

test('取消会中止仍在读取的 HTTP 流', async () => {
  let signal;
  let started;
  const ready = new Promise(done => { started = done; });
  const state = await harness(async (url, options) => {
    signal = options.signal;
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('取消')), { once: true }));
  });
  const pending = state.context.routeHandler(routeFor(state.context).route);
  await ready;
  await state.adapter.close();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(state.browser.closes, 1);
});
