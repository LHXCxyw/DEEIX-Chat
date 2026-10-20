import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { Policy } from '../src/policy.js';
import { Sessions } from '../src/sessions.js';

const policy = { previewOrigin: 'https://preview.example.com', expiresAt: 601000 };
const resolve = async () => [{ address: '8.8.8.8' }];

test('真实 TCP 验证仅使用已批准的回环目标', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const value = { previewOrigin: origin, expiresAt: Date.now() + 60000, allowLoopbackPreview: true };
  const p = new Policy(value);
  await p.check(origin, { initial: true });
  await new Promise(done => server.close(done));
  await assert.rejects(p.check(origin, { initial: true }), { status: 403 });
});

test('30 秒动作超时关闭上下文', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = false;
  const sessions = new Sessions(async () => ({
    perform: async () => new Promise(() => {}), close: async () => { closed = true; },
  }), { resolve, now: () => 1000 });
  const task = await sessions.create({ policy });
  const result = sessions.action(task.id, { type: 'screenshot' });
  const rejected = assert.rejects(result, { status: 408 });
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(closed, true);
  assert.equal(sessions.current, null);
});

test('累计十分钟自动清理，禁止超期动作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let time = 1000;
  let closed = false;
  const sessions = new Sessions(async () => ({
    perform: async () => ({}), close: async () => { closed = true; },
  }), { resolve, now: () => time });
  const task = await sessions.create({ policy });
  time += 600_000;
  t.mock.timers.tick(600_000);
  await Promise.resolve();
  assert.equal(closed, true);
  await assert.rejects(sessions.action(task.id, { type: 'console' }));
});

test('清理失败保持实例占用，不产生第二个上下文', async () => {
  const sessions = new Sessions(async () => ({
    perform: async () => ({}), close: async () => { throw Error('关闭失败'); },
  }), { resolve, now: () => 1000 });
  const task = await sessions.create({ policy });
  await assert.rejects(sessions.close(task.id));
  await assert.rejects(sessions.create({ policy }), { status: 409 });
});
