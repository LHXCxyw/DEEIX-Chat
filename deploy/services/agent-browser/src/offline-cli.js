import { probeEngine } from './browser.js';
import { readHtml, renderOffline } from './offline.js';

try {
  if (process.argv[2] === '--selftest') {
    const health = await probeEngine();
    if (!health.engine.ready) throw new Error('sandbox 渲染自检不可用；不允许降级');
    const screenshot = await renderOffline('<h1>离线渲染自检</h1><img src="https://example.com/blocked"><script>throw Error("禁止执行")</script>');
    const png = Buffer.from(screenshot.data, 'base64');
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('截图格式无效');
    console.log(JSON.stringify({ ...health, offlineRender: { ready: true, bytes: png.length }, networkBoundary: { ready: false, status: 'requires-host-docker-inspect', publicNetwork: false } }));
  } else if (process.argv.length === 2) {
    console.log(JSON.stringify(await renderOffline(await readHtml(process.stdin))));
  } else {
    throw new Error('仅支持 stdin HTML 或 --selftest');
  }
} catch (error) {
  console.error(JSON.stringify({ ready: false, error: error.message }));
  process.exitCode = 1;
}
