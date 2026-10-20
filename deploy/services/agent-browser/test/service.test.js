import test from 'node:test';
import assert from 'node:assert/strict';
import { Policy, publicIP } from '../src/policy.js';
import { Sessions, validateAction } from '../src/sessions.js';
import { configuration, createServer } from '../src/server.js';
import { createBrowserContext } from '../src/browser.js';

const now = () => 1000;
const resolve = async () => [{ address: '93.184.216.34' }];
const policy = (extra = {}) => ({ previewOrigin: 'https://preview.example.com', expiresAt: 601000, ...extra });
function harness(perform = async () => ({ ok: true })) {
  const contexts = [];
  const factory = async options => {
    const context = { options, closed: false, perform, async close() { this.closed = true; } };
    contexts.push(context);
    return context;
  };
  return { contexts, sessions: new Sessions(factory, { resolve, now }) };
}

test('精确 origin、受控精确公网域名与有效期', async () => {
  const p = new Policy(policy({ publicDomains: ['approved.example.com'] }), resolve, undefined, now);
  await p.check('https://preview.example.com/path');
  await p.check('https://approved.example.com/file');
  for (const url of ['https://preview.example.com:444', 'https://preview.example.com.evil.com',
    'http://approved.example.com', 'https://sub.approved.example.com', 'file:///etc/passwd',
    'https://user:password@preview.example.com']) await assert.rejects(p.check(url));
  for (const change of [{ expiresAt: 1000 }, { expiresAt: 601001 }, { publicDomains: ['*.example.com'] },
    { previewOrigin: 'https://preview.example.com/' }, { publicDomains: ['127.0.0.1'] },
    { allowLoopbackPreview: 'true' }]) assert.throws(() => new Policy(policy(change), resolve, undefined, now));
  let time = 1000;
  const expiring = new Policy(policy(), resolve, undefined, () => time);
  time = 601000;
  await assert.rejects(expiring.check('https://preview.example.com'));
});

test('私网、元数据、IPv6、混合 DNS、重绑定保守拒绝', async () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '127.1.2.3', '169.254.169.254', '100.100.100.200',
    '172.16.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:8.8.8.8']) assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP('8.8.8.8'), true);
  const mixed = new Policy(policy(), async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }], undefined, now);
  await assert.rejects(mixed.check('https://preview.example.com'));
  let ip = '8.8.8.8';
  const rebinding = new Policy(policy(), async () => [{ address: ip }], undefined, now);
  await rebinding.check('https://preview.example.com');
  ip = '169.254.169.254';
  await assert.rejects(rebinding.check('https://preview.example.com'));
});

test('本地 preview 需明确授权、精确回环 DNS 和实际可达验证', async () => {
  let probes = 0;
  const local = policy({ previewOrigin: 'http://localhost:5173', allowLoopbackPreview: true });
  const p = new Policy(local, async () => [{ address: '127.0.0.1' }], async (ip, port) => {
    assert.equal(ip, '127.0.0.1'); assert.equal(port, 5173); probes++;
  }, now);
  await p.check(local.previewOrigin, { initial: true });
  assert.equal(probes, 1);
  await assert.rejects(p.check('http://localhost:5174'));
  await assert.rejects(new Policy({ ...local, allowLoopbackPreview: false }, async () => [{ address: '127.0.0.1' }], undefined, now).check(local.previewOrigin));
  await assert.rejects(new Policy(local, async () => [{ address: '192.168.1.1' }], undefined, now).check(local.previewOrigin));
  await assert.rejects(new Policy(local, async () => [{ address: '127.0.0.1' }], async () => { throw Error(); }, now).check(local.previewOrigin, { initial: true }));
});

test('typed 动作禁止 evaluate、CDP、策略字段和超过两页', () => {
  for (const type of ['screenshot', 'console', 'errors', 'failedRequests']) validateAction({ type });
  for (const value of [{ type: 'evaluate', script: '1' }, { type: 'cdp' }, { type: 'toString' },
    { type: 'navigate', url: 'https://x', policy: {} }, { type: 'click', selector: 'a', page: 2 },
    { type: 'fill', selector: 'a', value: 1 }]) assert.throws(() => validateAction(value));
});

test('独立上下文、实例上限、sandbox 契约和取消清理', async () => {
  const { sessions, contexts } = harness();
  const first = await sessions.create({ policy: policy() });
  await assert.rejects(sessions.create({ policy: policy() }), { status: 409 });
  assert.equal(contexts[0].options.chromiumSandbox, true);
  assert.equal(contexts[0].options.serviceWorkers, 'block');
  assert.equal(contexts[0].options.maxPages, 2);
  await assert.rejects(contexts[0].options.authorizeRequest('https://evil.com/'));
  await sessions.action(first.id, { type: 'navigate', url: 'https://preview.example.com' });
  await sessions.close(first.id);
  assert.equal(contexts[0].closed, true);
  const second = await sessions.create({ policy: policy() });
  assert.notEqual(second.id, first.id);
  assert.notEqual(contexts[0], contexts[1]);
  await assert.rejects(sessions.action(first.id, { type: 'screenshot' }));
  await sessions.close(second.id);
});

test('动作串行、取消在途动作并关闭 context', async () => {
  const { sessions, contexts } = harness(async () => new Promise(() => {}));
  const task = await sessions.create({ policy: policy() });
  const pending = sessions.action(task.id, { type: 'screenshot' });
  const canceled = assert.rejects(pending, { status: 410 });
  await assert.rejects(sessions.action(task.id, { type: 'console' }), { status: 409 });
  await sessions.close(task.id);
  await canceled;
  assert.equal(contexts[0].closed, true);
});

test('单下载 50MiB / 累计 200MiB，超限关闭上下文', async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  let count = 50;
  const { sessions, contexts } = harness(async () => (async function* () {
    for (let i = 0; i < count; i++) yield chunk;
  })());
  const task = await sessions.create({ policy: policy() });
  for (let i = 0; i < 4; i++) {
    const result = await sessions.action(task.id, { type: 'download', id: 'file' });
    assert.equal(result.bytes, 50 * 1024 * 1024);
  }
  count = 1;
  await assert.rejects(sessions.action(task.id, { type: 'download', id: 'file' }), { status: 413 });
  assert.equal(contexts[0].closed, true);
  const next = await sessions.create({ policy: policy() });
  count = 51;
  await assert.rejects(sessions.action(next.id, { type: 'download', id: 'file' }), { status: 413 });
  assert.equal(contexts[1].closed, true);
});

test('无认证拒绝启动且真实浏览器始终 fail closed', async () => {
  assert.throws(() => configuration({}));
  assert.throws(() => configuration({ AGENT_BROWSER_CONTROL_TOKEN: 'x'.repeat(43), AGENT_BROWSER_ACTION_TOKEN: 'x'.repeat(43) }));
  await assert.rejects(createBrowserContext(), { status: 503 });
});

test('HTTP 双认证、请求限制、控制面不可由动作令牌扩大策略', async t => {
  const config = { controlToken: 'a'.repeat(43), actionToken: 'b'.repeat(43) };
  const { sessions } = harness();
  const server = createServer(config, sessions);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (sessions.current) await sessions.close(sessions.current.id);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token, value) => fetch(base + path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  assert.equal((await fetch(base + '/v1/capabilities')).status, 401);
  const caps = await fetch(base + '/v1/capabilities', { headers: { Authorization: `Bearer ${config.actionToken}` } });
  assert.equal((await caps.json()).browserExecution, false);
  assert.equal((await request('/v1/tasks', config.actionToken, { policy: policy() })).status, 401);
  assert.equal((await request('/v1/tasks', config.controlToken, { data: 'x'.repeat(17000) })).status, 413);
  const created = await request('/v1/tasks', config.controlToken, { policy: policy() });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await request(`/v1/tasks/${id}/actions`, config.actionToken, { type: 'screenshot', policy: policy() })).status, 400);
  assert.equal((await request(`/v1/tasks/${id}/actions`, config.controlToken, { type: 'screenshot' })).status, 401);
  assert.equal((await request(`/v1/tasks/${id}/actions`, config.actionToken, { type: 'screenshot' })).status, 200);
  assert.equal((await fetch(`${base}/v1/tasks/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${config.actionToken}` } })).status, 200);
  assert.equal(sessions.current, null);
});
