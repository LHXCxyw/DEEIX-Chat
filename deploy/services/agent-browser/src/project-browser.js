import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { launchSandboxedBrowser } from './browser.js';

const TYPES = Object.freeze({ html: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2' });
const fail = () => { throw new Error('项目浏览器协议无效'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function validPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.')) && Object.hasOwn(TYPES, value.split('.').at(-1));
}
export function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length > 24) fail();
  for (const a of actions) {
    if (!a || typeof a !== 'object') fail();
    const keys = { click: ['type', 'selector'], fill: ['type', 'selector', 'value'], press: ['type', 'selector', 'key'], wait: ['type', 'selector'], screenshot: ['type'], dom: ['type'] }[a.type];
    if (!keys || !exact(a, keys)) fail();
    if (keys.includes('selector') && (typeof a.selector !== 'string' || !a.selector || a.selector.length > 256 || a.selector.includes('\0') || /^(?:javascript|file|https?):/i.test(a.selector))) fail();
    if (a.type === 'fill' && (typeof a.value !== 'string' || Buffer.byteLength(a.value) > 4096)) fail();
    if (a.type === 'press' && !['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', 'Delete', 'Home', 'End'].includes(a.key)) fail();
  }
  if (actions.filter(a => a.type === 'screenshot').length > 1 || actions.filter(a => a.type === 'dom').length > 1) fail();
}
export function validateRequest(request) {
  if (!exact(request, ['protocol', 'entry', 'files', 'actions', 'snapshot_hash']) || request.protocol !== 1 || !validPath(request.entry) || !request.entry.endsWith('.html') || !Array.isArray(request.files) || !request.files.length || request.files.length > 64) fail();
  validateActions(request.actions);
  let total = 0;
  const files = new Map();
  const manifest = [];
  let previous = '';
  for (const f of request.files) {
    if (!exact(f, ['path', 'data', 'sha256']) || !validPath(f.path) || f.path <= previous || typeof f.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.data)) fail();
    previous = f.path;
    const data = Buffer.from(f.data, 'base64');
    total += data.length;
    if (data.length > 1048576 || total > 4194304 || createHash('sha256').update(data).digest('hex') !== f.sha256) fail();
    files.set(f.path, data);
    manifest.push(`${f.path}\0${f.sha256}\n`);
  }
  if (!files.has(request.entry) || createHash('sha256').update(manifest.join('')).digest('hex') !== request.snapshot_hash) fail();
  return files;
}

export async function serveManifest(files) {
  let origin;
  const server = createServer((req, res) => {
    const reject = () => { res.writeHead(403); res.end(); };
    if (req.method !== 'GET' || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return reject();
    const raw = req.url;
    if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[%\\?#\u0000-\u0020]/.test(raw)) return reject();
    const name = raw.slice(1);
    if (!validPath(name) || !files.has(name)) return reject();
    res.writeHead(200, {
      'Content-Type': `${TYPES[name.split('.').at(-1)]}${/\.(html|css|js|mjs|json)$/.test(name) ? '; charset=utf-8' : ''}`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(files.get(name));
  });
  server.maxConnections = 32;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

export async function runProjectBrowser(request, launch = launchSandboxedBrowser, onStage = () => {}) {
  onStage('request-validation');
  const files = validateRequest(request);
  onStage('manifest-server');
  const server = await serveManifest(files);
  let browser;
  let failed = false;
  try {
    onStage('browser-launch');
    browser = await launch({ onStage });
    onStage('project-context');
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(3000);
    context.setDefaultNavigationTimeout(10000);
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      const allowed = url.origin === server.origin && !url.search && !url.hash && validPath(url.pathname.slice(1)) && files.has(url.pathname.slice(1)) && route.request().method() === 'GET';
      return allowed ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const consoleErrors = [];
    const record = text => { if (consoleErrors.length < 20) consoleErrors.push(String(text).slice(0, 1024)); };
    page.on('console', message => { if (message.type() === 'error') record(message.text()); });
    page.on('pageerror', error => record(error.message));
    page.on('popup', popup => popup.close());
    onStage('navigation');
    await page.goto(`${server.origin}/${request.entry}`, { waitUntil: 'load', timeout: 10000 });
    let screenshot = null;
    let dom = [];
    for (const action of request.actions) {
      onStage(`action-${action.type}`);
      if (new URL(page.url()).origin !== server.origin) fail();
      if (['click', 'fill', 'press', 'wait'].includes(action.type)) {
        const target = page.locator(`css=${action.selector}`);
        if (action.type === 'click') await target.click();
        if (action.type === 'fill') await target.fill(action.value);
        if (action.type === 'press') await target.press(action.key);
        if (action.type === 'wait') await target.waitFor({ state: 'visible' });
      } else if (action.type === 'screenshot') {
        const png = await page.screenshot({ type: 'png', timeout: 5000 });
        if (png.length > 4194304) fail();
        screenshot = { protocol: 1, snapshot_hash: request.snapshot_hash, mimeType: 'image/png', data: png.toString('base64') };
      } else {
        // 固定只读函数在页面内截断后才传回，不接受模型提供的脚本。
        dom = await page.locator('body, body h1, body h2, body h3, body p, body a, body button, body input, body textarea, body label, body [role]').evaluateAll(nodes => nodes.slice(0, 80).map(node => ({ text: (node.textContent || '').slice(0, 256) })));
      }
    }
    if (new URL(page.url()).origin !== server.origin) fail();
    return { protocol: 1, snapshot_hash: request.snapshot_hash, completed_actions: request.actions.length, dom, console_errors: consoleErrors, screenshot };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (!failed) onStage('cleanup');
    try {
      try { if (browser) await browser.close(); } finally { await server.close(); }
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

export async function readRequest(input) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > 6 * 1048576) fail();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
