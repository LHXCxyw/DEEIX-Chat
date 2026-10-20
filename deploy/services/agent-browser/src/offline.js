import { createHash } from 'node:crypto';
import { launchSandboxedBrowser } from './browser.js';
import { ServiceError } from './policy.js';

const MAX_HTML = 1024 * 1024;

// 仅供 network=none 的专用容器入口；拦截不是硬网络边界或证明。
export async function renderOffline(html, launch = launchSandboxedBrowser) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_HTML) throw new ServiceError('HTML 上限为 1MiB', 413);
  const browser = await launch();
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      offline: true, viewport: { width: 1280, height: 720 },
    });
    context.setDefaultTimeout(10_000);
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', route => route.abort('blockedbyclient'));
    const page = await context.newPage();
    // CSP 位于所有输入前；禁脚本、框架、跳转、表单及外部资源，保留内联样式和 data 图片。
    const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
    await page.setContent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${html}`, { timeout: 10_000, waitUntil: 'load' });
    const png = await page.screenshot({ type: 'png', timeout: 10_000 });
    return { protocol: 1, snapshot_hash: createHash('sha256').update(html, 'utf8').digest('hex'), mimeType: 'image/png', data: png.toString('base64') };
  } finally {
    await browser.close();
  }
}

export async function readHtml(input) {
  let size = 0;
  const chunks = [];
  for await (const chunk of input) {
    size += chunk.length;
    if (size > MAX_HTML) throw new ServiceError('HTML 上限为 1MiB', 413);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
