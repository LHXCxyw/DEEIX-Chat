import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderOffline } from '../src/offline.js';

test('离线结果协议绑定确切 UTF-8 快照且始终关闭浏览器', async () => {
  const html = '<h1>固定快照</h1>\n';
  let closed = false;
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const context = {
    setDefaultTimeout() {}, async routeWebSocket() {}, async route() {},
    async newPage() { return { async setContent() {}, async screenshot() { return png; } }; },
  };
  const result = await renderOffline(html, async () => ({ async newContext() { return context; }, async close() { closed = true; } }));
  assert.equal(result.protocol, 1);
  assert.equal(result.snapshot_hash, createHash('sha256').update(html).digest('hex'));
  assert.equal(result.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(result.data, 'base64'), png);
  assert.equal(closed, true);
});
