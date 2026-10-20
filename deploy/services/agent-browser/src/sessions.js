import { randomUUID } from 'node:crypto';
import { Policy, ServiceError, exactKeys } from './policy.js';

const ACTION_MS = 30_000;
const TOTAL_MS = 600_000;
const SINGLE_DOWNLOAD = 50 * 1024 * 1024;
const TOTAL_DOWNLOAD = 200 * 1024 * 1024;
const schemas = {
  navigate: ['url'], click: ['selector'], fill: ['selector', 'value'], press: ['key'],
  screenshot: [], console: [], errors: [], failedRequests: [], download: ['id'],
};
export function validateAction(value) {
  if (!value || !Object.hasOwn(schemas, value.type)) throw new ServiceError('不支持的动作');
  exactKeys(value, ['type', ...schemas[value.type]], ['page']);
  if (value.page !== undefined && ![0, 1].includes(value.page)) throw new ServiceError('page 仅允许 0 或 1');
  for (const key of schemas[value.type]) {
    if (typeof value[key] !== 'string' || value[key].length > (key === 'value' ? 8192 : 4096)
      || (key !== 'value' && !value[key].length)) throw new ServiceError('动作参数无效');
  }
  return structuredClone(value);
}

// 驱动契约仅用于依赖注入与单元测试，不提供 HTTP 注入或动态模块配置入口。
// 未来真实驱动必须限制弹窗、阻断 SW/WS，并在独立出站隔离中处理重定向及所有子资源。
export class Sessions {
  constructor(factory, { resolve, probe, now = Date.now } = {}) {
    this.factory = factory;
    this.options = { resolve, probe, now };
    this.current = null;
  }
  async create(input) {
    exactKeys(input, ['policy']);
    if (this.current) throw new ServiceError('实例最多一个任务', 409);
    const policy = new Policy(input.policy, this.options.resolve, this.options.probe, this.options.now);
    const session = { id: randomUUID(), policy, context: null, busy: false, closed: false,
      downloads: 0, deadline: Math.min(policy.expiresAt, this.options.now() + TOTAL_MS) };
    this.current = session;
    session.timer = setTimeout(() => { void this.close(session.id).catch(() => {}); }, Math.max(1, session.deadline - this.options.now()));
    session.timer.unref?.();
    try {
      const context = await this.withDeadline(session, async () => {
        await policy.check(policy.origin, { initial: true });
        if (session.closed) throw new ServiceError('任务已取消', 410);
        const created = await this.factory({ chromiumSandbox: true, serviceWorkers: 'block',
          maxPages: 2, authorizeRequest: url => policy.check(url) });
        if (session.closed) { await created.close(); throw new ServiceError('任务已取消', 410); }
        session.context = created;
        return created;
      });
      if (session.closed) { await context.close(); throw new ServiceError('任务已取消', 410); }
      return { id: session.id, expiresAt: session.deadline };
    } catch (error) { await this.close(session.id); throw error; }
  }
  get(id) {
    const session = this.current;
    if (!session || session.id !== id || session.closed) throw new ServiceError('任务不存在', 404);
    if (this.options.now() >= session.deadline) {
      void this.close(id).catch(() => {});
      throw new ServiceError('任务已过期', 410);
    }
    return session;
  }
  async withDeadline(session, operation) {
    const duration = Math.min(ACTION_MS, session.deadline - this.options.now());
    if (duration <= 0) throw new ServiceError('任务已过期', 410);
    let timer;
    const canceled = new Promise((_, reject) => { session.abort = () => reject(new ServiceError('任务已取消', 410)); });
    try {
      return await Promise.race([Promise.resolve().then(operation), canceled, new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new ServiceError('动作超时', 408));
          void this.close(session.id).catch(() => {});
        }, duration);
      })]);
    } finally { clearTimeout(timer); session.abort = null; }
  }
  async action(id, raw) {
    const action = validateAction(raw);
    const session = this.get(id);
    if (session.busy || !session.context) throw new ServiceError('任务正在执行', 409);
    session.busy = true;
    try {
      return await this.withDeadline(session, async () => {
        if (action.type === 'navigate') await session.policy.check(action.url);
        if (session.closed) throw new ServiceError('任务已取消', 410);
        // 驱动只接受结构化动作，不能执行 JS、CDP 或调用任意方法。
        const result = await session.context.perform(action, { timeout: ACTION_MS });
        if (action.type !== 'download') return result;
        const chunks = [];
        let size = 0;
        for await (const chunk of result) {
          if (session.closed) throw new ServiceError('任务已取消', 410);
          const data = Buffer.from(chunk);
          size += data.length;
          session.downloads += data.length;
          if (size > SINGLE_DOWNLOAD || session.downloads > TOTAL_DOWNLOAD) {
            throw new ServiceError('下载配额超限', 413);
          }
          chunks.push(data);
        }
        return { data: Buffer.concat(chunks).toString('base64'), bytes: size };
      });
    } catch (error) {
      if (error.status !== 403) await this.close(id);
      throw error;
    } finally { session.busy = false; }
  }
  async close(id) {
    const session = this.current;
    if (!session || session.id !== id || session.closed) return;
    session.closed = true;
    clearTimeout(session.timer);
    session.abort?.();
    // 清理失败时保留占用位，禁止在旧上下文尚存时新建任务。
    await session.context?.close();
    if (this.current === session) this.current = null;
  }
}
