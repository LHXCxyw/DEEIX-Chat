import { lookup } from 'node:dns/promises';
import { isIP, connect } from 'node:net';

export class ServiceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !(key in value))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new ServiceError('请求字段不匹配');
  }
}
function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) throw new ServiceError('URL 无效');
  let url;
  try { url = new URL(raw); } catch { throw new ServiceError('URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ServiceError('只允许不带凭据的 HTTP URL');
  }
  return url;
}
function hostname(url) { return url.hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
function loopback(ip) { return ip === '127.0.0.1' || ip === '::1'; }
// 保守拒绝所有 IPv6 与 IPv4 特殊用途网段，避免映射地址与元数据端点绕过。
export function publicIP(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}
export async function probeLoopback(address, port) {
  await new Promise((resolve, reject) => {
    const socket = connect({ host: address, port });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => socket.destroy(new Error('preview 不可达')));
    socket.once('error', reject);
  });
}
export class Policy {
  constructor(value, resolve = lookup, probe = probeLoopback, now = Date.now) {
    exactKeys(value, ['previewOrigin', 'expiresAt'], ['publicDomains', 'allowLoopbackPreview']);
    const preview = parseUrl(value.previewOrigin);
    if (preview.origin !== value.previewOrigin || preview.pathname !== '/' || preview.search || preview.hash) {
      throw new ServiceError('preview 必须为精确 origin');
    }
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now()
      || value.expiresAt > now() + 600_000) throw new ServiceError('策略有效期最多十分钟');
    if (value.allowLoopbackPreview !== undefined && typeof value.allowLoopbackPreview !== 'boolean') {
      throw new ServiceError('本地授权必须为布尔值');
    }
    const domains = value.publicDomains ?? [];
    if (!Array.isArray(domains) || domains.length > 20 || domains.some(domain =>
      typeof domain !== 'string' || domain.length > 253 || isIP(domain)
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
      || domain.endsWith('.localhost') || domain.endsWith('.local')
      || domain.endsWith('.internal') || domain.endsWith('.test'))) {
      throw new ServiceError('公网授权必须为精确 DNS 域名，禁止通配符');
    }
    this.origin = preview.origin;
    this.expiresAt = value.expiresAt;
    this.domains = Object.freeze([...domains]);
    this.local = value.allowLoopbackPreview === true;
    this.resolve = resolve;
    this.probe = probe;
    this.now = now;
    Object.freeze(this);
  }
  async check(raw, { initial = false } = {}) {
    if (this.now() >= this.expiresAt) throw new ServiceError('策略已过期', 410);
    const url = parseUrl(raw);
    const host = hostname(url);
    const preview = url.origin === this.origin;
    if (!preview && !(url.protocol === 'https:' && (!url.port || url.port === '443') && this.domains.includes(host))) {
      throw new ServiceError('目标不在任务策略内', 403);
    }
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host }] : await this.resolve(host, { all: true, verbatim: true });
    } catch { throw new ServiceError('DNS 解析失败', 403); }
    if (!addresses.length || addresses.length > 32) throw new ServiceError('DNS 结果无效', 403);
    const local = preview && this.local && addresses.every(item => loopback(item.address));
    if (!local && !addresses.every(item => publicIP(item.address))) throw new ServiceError('禁止私网、宿主和元数据地址', 403);
    if (initial && local) {
      try {
        await Promise.all(addresses.map(item => this.probe(item.address, Number(url.port || (url.protocol === 'https:' ? 443 : 80)))));
      } catch { throw new ServiceError('本地 preview 可达性验证失败', 403); }
    }
    if (this.now() >= this.expiresAt) throw new ServiceError('策略已过期', 410);
    return url.href;
  }
}
