import { randomUUID } from 'node:crypto';
import { ServiceError } from './policy.js';
import { validateAction } from './sessions.js';
import { createBrowserContext, launchSandboxedBrowser } from './browser.js';

const SINGLE = 50 * 1024 * 1024;
const TOTAL = 200 * 1024 * 1024;
const TIMEOUT = 30_000;
const MAX_EVENTS = 200;

// 当前没有可信隔离证明的签发/验证器；此入口不可由 env 或调用参数解锁。
export async function launchChromiumTask(options) {
  await createBrowserContext();
  const browser = await launchSandboxedBrowser();
  return attachTaskBrowser(browser, options);
}

// 底层组合接缝：只接收未来可信启动器新建的任务专属 Browser，不连接端口或个人浏览器。
// 本函数不是隔离证明，生产入口不得直接调用。route 和 fetch 均依赖同一可信硬出站边界。
export async function attachTaskBrowser(browser, { authorizeRequest, transport = fetch }) {
  let closed = false;
  let closing;
  let fatal;
  let total = 0;
  const pages = [];
  const records = new Map();
  const files = new Map();
  const controllers = new Set();
  const close = () => {
    if (!closing) {
      closed = true;
      for (const controller of controllers) controller.abort();
      files.clear();
      closing = Promise.resolve().then(() => browser.close());
    }
    return closing;
  };
  const fail = error => {
    fatal ??= error;
    void close().catch(() => {});
  };
  try {
    if (typeof authorizeRequest !== 'function') throw new ServiceError('缺少任务授权策略', 503);
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    // 必须在创建任何页面前完成；旧版本不支持时失败，不降级。
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      try {
        if (closed) return await route.abort('blockedbyclient');
        const request = route.request();
        const url = await authorizeRequest(request.url());
        const headers = { ...await request.allHeaders() };
        for (const key of ['host', 'connection', 'content-length', 'accept-encoding']) delete headers[key];
        const response = await transport(url, {
          method: request.method(), headers, body: request.postDataBuffer() ?? undefined,
          redirect: 'manual', signal: controller.signal,
        });
        // 重定向只交回浏览器，下一跳重新经过策略；从不由 transport 自动跟随。
        const attachment = /\battachment\b/i.test(response.headers.get('content-disposition') ?? '');
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > SINGLE
          || (attachment && total + Number(length) > TOTAL))) {
          throw new ServiceError('响应或下载配额超限', 413);
        }
        const chunks = [];
        let size = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            if (closed) throw new ServiceError('任务已取消', 410);
            const data = Buffer.from(chunk);
            size += data.length;
            if (attachment) total += data.length;
            if (size > SINGLE || (attachment && total > TOTAL)) throw new ServiceError('响应或下载配额超限', 413);
            chunks.push(data);
          }
        }
        const body = Buffer.concat(chunks);
        if (attachment) {
          const page = request.frame().page();
          const id = randomUUID();
          files.set(id, { body, page });
          records.get(page)?.downloads.push({ id, bytes: size });
          await route.fulfill({ status: 204, body: '' });
        } else {
          const outputHeaders = Object.fromEntries(response.headers);
          // fetch 提供的是解压后的响应体，不可保留原始编码/长度。
          delete outputHeaders['content-encoding'];
          delete outputHeaders['content-length'];
          if (response.headers.getSetCookie) {
            const cookies = response.headers.getSetCookie();
            if (cookies.length) outputHeaders['set-cookie'] = cookies.join('\n');
          }
          await route.fulfill({ status: response.status, headers: outputHeaders, body });
        }
      } catch (error) {
        controller.abort();
        try { await route.abort('blockedbyclient'); } catch {}
        if (error.status !== 403) fail(error);
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    });
    context.on('page', page => {
      if (closed || pages.length >= 2) {
        fail(new ServiceError('页面上限为两页', 409));
        return;
      }
      pages.push(page);
      const record = { console: [], errors: [], failedRequests: [], downloads: [] };
      records.set(page, record);
      const append = (key, value) => {
        record[key].push(value);
        if (record[key].length > MAX_EVENTS) record[key].shift();
      };
      page.on('console', message => append('console', { type: message.type(), text: message.text().slice(0, 8192) }));
      page.on('pageerror', error => append('errors', { message: String(error.message).slice(0, 8192) }));
      page.on('requestfailed', request => append('failedRequests', {
        url: request.url().slice(0, 4096), error: String(request.failure()?.errorText ?? '').slice(0, 8192),
      }));
      // blob/data 或非附件下载不走可信响应流，绝不回退至完成后读文件。
      page.on('download', download => {
        void download.cancel().catch(() => {});
        fail(new ServiceError('禁止未经过受控响应流的原生下载', 403));
      });
    });
    await context.newPage();
    return Object.freeze({
      close,
      async perform(raw, { timeout = TIMEOUT } = {}) {
        const action = validateAction(raw);
        if (fatal) throw fatal;
        if (closed) throw new ServiceError('任务已取消', 410);
        const page = pages[action.page ?? 0];
        if (!page || page.isClosed()) throw new ServiceError('页面不存在', 404);
        const duration = Math.min(TIMEOUT, timeout);
        if (!Number.isFinite(duration) || duration <= 0) throw new ServiceError('动作超时无效');
        let timer;
        try {
          return await Promise.race([(async () => {
            const record = records.get(page);
            switch (action.type) {
              case 'navigate': {
                const url = await authorizeRequest(action.url);
                await page.goto(url, { timeout: duration, waitUntil: 'domcontentloaded' });
                if (fatal) throw fatal;
                return { url: page.url(), downloads: record.downloads.splice(0) };
              }
              case 'click':
                await page.locator(action.selector).click({ timeout: duration });
                return { downloads: record.downloads.splice(0) };
              case 'fill':
                await page.locator(action.selector).fill(action.value, { timeout: duration });
                return { ok: true };
              case 'press':
                await page.keyboard.press(action.key);
                return { downloads: record.downloads.splice(0) };
              case 'screenshot':
                return { data: (await page.screenshot({ type: 'png', timeout: duration })).toString('base64'), mimeType: 'image/png' };
              case 'console':
                return { entries: record.console.splice(0), downloads: record.downloads.splice(0) };
              case 'errors': case 'failedRequests':
                return { entries: record[action.type].splice(0) };
              case 'download': {
                const file = files.get(action.id);
                if (!file || file.page !== page) throw new ServiceError('下载不存在', 404);
                files.delete(action.id);
                return (async function* () {
                  for (let offset = 0; offset < file.body.length; offset += 65536) {
                    if (closed) throw new ServiceError('任务已取消', 410);
                    yield file.body.subarray(offset, offset + 65536);
                  }
                })();
              }
            }
          })(), new Promise((_, reject) => {
            timer = setTimeout(() => {
              const error = new ServiceError('动作超时', 408);
              fail(error);
              reject(error);
            }, duration);
          })]);
        } finally { clearTimeout(timer); }
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}
