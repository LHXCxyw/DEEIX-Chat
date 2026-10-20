import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Sessions } from './sessions.js';
import { ServiceError } from './policy.js';
import { capabilities, createBrowserContext, health, probeEngine } from './browser.js';

const MAX_BODY = 16 * 1024;
export function configuration(env) {
  const controlToken = env.AGENT_BROWSER_CONTROL_TOKEN;
  const actionToken = env.AGENT_BROWSER_ACTION_TOKEN;
  if (![controlToken, actionToken].every(token => typeof token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(token))
    || controlToken === actionToken) {
    throw new Error('必须配置独立的控制端与动作端随机令牌（至少 256 位随机性，base64url 编码）');
  }
  const port = Number(env.PORT ?? 8010);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  return { controlToken, actionToken, port };
}
function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(req) {
  if (req.headers['content-encoding'] || req.headers['content-type'] !== 'application/json') {
    throw new ServiceError('仅支持未压缩 application/json', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ServiceError('请求过大', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError('JSON 无效'); }
}
export function createServer(config, sessions = new Sessions(createBrowserContext)) {
  // 入口令牌校验同时用于嵌入调用，不能绕过启动配置要求。
  configuration({ AGENT_BROWSER_CONTROL_TOKEN: config.controlToken, AGENT_BROWSER_ACTION_TOKEN: config.actionToken });
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Connection', 'close');
    const send = (status, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    let ownedId;
    const cancel = () => { if (ownedId) void sessions.close(ownedId).catch(() => {}); };
    res.once('close', () => { if (!res.writableEnded) cancel(); });
    try {
      const path = req.url;
      const control = path === '/v1/tasks' && req.method === 'POST';
      const token = control ? config.controlToken : config.actionToken;
      if (!authorized(req.headers.authorization, token)) throw new ServiceError('未授权', 401);
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new ServiceError('请求过大', 413);
      if (req.method === 'GET' && path === '/v1/health') return send(200, health());
      if (req.method === 'GET' && path === '/v1/capabilities') return send(200, capabilities);
      if (control) {
        const result = await sessions.create(await body(req));
        ownedId = result.id;
        if (res.destroyed) { cancel(); return; }
        return send(201, result);
      }
      const match = /^\/v1\/tasks\/([a-f0-9-]{36})(\/actions)?$/.exec(path ?? '');
      if (!match) throw new ServiceError('接口不存在', 404);
      if (req.method === 'DELETE' && !match[2]) {
        await sessions.close(match[1]);
        return send(200, { closed: true });
      }
      if (req.method === 'POST' && match[2]) {
        ownedId = match[1];
        return send(200, await sessions.action(ownedId, await body(req)));
      }
      throw new ServiceError('接口不存在', 404);
    } catch (error) {
      send(error instanceof ServiceError ? error.status : 500,
        { error: error instanceof ServiceError ? error.message : '服务内部错误' });
    }
  });
  server.maxRequestsPerSocket = 1;
  server.keepAliveTimeout = 1000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration(process.env);
  await probeEngine();
  const sessions = new Sessions(createBrowserContext);
  const server = createServer(config, sessions);
  // 仅绑定回环；远程部署须由可信 TLS 入口转发，禁止浏览器页面读取令牌。
  server.listen(config.port, '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
      if (sessions.current) void sessions.close(sessions.current.id).catch(() => { process.exitCode = 1; });
    });
  }
}
