import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readRequest, runProjectBrowser } from './project-browser.js';

function diagnosticReason(error) {
  const message = typeof error?.message === 'string' ? error.message.slice(0, 32768) : '';
  // 只返回固定分类，绝不复制 Playwright 调用日志、页面内容、路径或凭据。
  if (/Check failed:\s*sys_chroot\("\/proc\/self\/fdinfo\/"\)\s*==\s*0/i.test(message)) return 'namespace-filesystem-chroot-failed';
  if (/clone[^\n]*(?:Operation not permitted|EPERM|denied)/i.test(message)) return 'namespace-clone-denied';
  if (/Failed to (?:move to new namespace|unshare)|(?:user|pid|network) namespace.*(?:Operation not permitted|EPERM)/i.test(message)) return 'namespace-operation-denied';
  if (/setuid sandbox|SUID sandbox|chrome-sandbox.*(?:configured|permission)/i.test(message)) return 'setuid-helper-unavailable';
  if (/crashpad.*(?:database|required|mkdir|directory)/i.test(message)) return 'crashpad-directory-unavailable';
  if (/(?:\/tmp|temporary directory|mkdtemp).*(?:No such file|ENOENT)/i.test(message)) return 'temporary-directory-missing';
  if (/No usable sandbox/i.test(message)) return 'no-usable-sandbox';
  if (/有效 capability/.test(message)) return 'effective-capability-unavailable';
  if (/sandbox 启动要求/.test(message)) return 'sandbox-identity-invalid';
  if (/未确认 namespace 与 seccomp sandbox/i.test(message)) return 'sandbox-verification-failed';
  if (/Read-only file system|EROFS/i.test(message)) return 'filesystem-read-only';
  if (/No space left on device|ENOSPC/i.test(message)) return 'workspace-full';
  if (/Resource temporarily unavailable|pthread_create|Cannot allocate memory|ENOMEM/i.test(message)) return 'resource-exhausted';
  if (/Executable doesn't exist|Cannot find package|error while loading shared libraries/i.test(message)) return 'browser-dependency-missing';
  if (/EACCES|Permission denied/i.test(message)) return 'permission-denied';
  if (/EADDRNOTAVAIL|EADDRINUSE/i.test(message)) return 'loopback-listen-failed';
  if (error?.name === 'TimeoutError' || /Timeout.*exceeded/i.test(message)) return 'operation-timeout';
  if (/Target.*closed|browser.*closed|SIGTRAP|SIGABRT|SIGSEGV/i.test(message)) return 'browser-process-exited';
  if (message === '交互自检失败') return 'interaction-selftest-failed';
  return 'unclassified-error';
}

const sandboxPolicy = 'moby-27.5.1-chromium-userns-v2';
const diagnosticHints = Object.freeze({
  'namespace-filesystem-chroot-failed': 'Chromium namespace sandbox 使用 chroot(/proc/self/fdinfo/) 收紧文件系统，并非 setuid 回退证据。RAW_CHECK 不携带 syscall errno，后续 zygote ENOENT 不能证明路径缺失。v2 仅允许 SYS_CHROOT：核对 inspect CapAdd、非 root 进程 CapEff/CapPrm/CapBnd 是否仅含 SYS_CHROOT，并检查宿主及外层 AppArmor/SELinux/seccomp 拒绝日志。cap-add 不证明非 root 有效权限；自检失败必须拒绝 ready，禁止切 root、放宽 userns、增加其他 capability 或禁用 sandbox。',
  'namespace-operation-denied': '只读检查宿主 sysctl kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns；检查宿主与外层 dind 的 AppArmor/SELinux/seccomp 拒绝日志。不要关闭 sandbox 或增加 capability。',
  'namespace-clone-denied': '核对任务 inspect SecurityOpt 中为受控 browser seccomp JSON；检查外层 dind/宿主 userns 与 LSM 拒绝记录。',
  'no-usable-sandbox': '核对 browser seccomp 策略及宿主 userns 配额；使用相同受限参数执行一次 --selftest，保留阶段及固定分类，不能据此断言宿主根因。',
  'setuid-helper-unavailable': '当前 no-new-privileges 不允许 setuid 提权；应修复 user namespace sandbox 而非放开 setuid。',
  'crashpad-directory-unavailable': '检查 HOME/TMPDIR=/workspace 与 tmpfs 配额；不要给根文件系统开放写入。',
  'temporary-directory-missing': '检查 /workspace tmpfs 与 TMPDIR，确认目录存在且非 root 用户可写。',
});

export async function runProjectBrowserCLI({ args = process.argv.slice(2), input = process.stdin, launch, stdout = line => console.log(line), stderr = line => console.error(line) } = {}) {
  const selftest = args.length === 1 && args[0] === '--selftest';
  let stage = 'selftest-start';
  const onStage = value => {
    stage = value;
    if (selftest) stderr(JSON.stringify({ selftest: true, stage }));
  };
  const watchdog = setTimeout(() => {
    if (selftest) stderr(JSON.stringify({ ready: false, stage, reason: 'watchdog-timeout' }));
    process.exit(1);
  }, 55000);
  try {
    if (args.length === 0) {
      stdout(JSON.stringify(await runProjectBrowser(await readRequest(input), launch)));
    } else if (selftest) {
      const html = Buffer.from('<button onclick="this.textContent=\'ok\'">test</button>');
      const hash = createHash('sha256').update(html).digest('hex');
      const result = await runProjectBrowser({ protocol: 1, entry: 'index.html', files: [{ path: 'index.html', data: html.toString('base64'), sha256: hash }], actions: [{ type: 'click', selector: 'button' }, { type: 'dom' }, { type: 'screenshot' }], snapshot_hash: createHash('sha256').update(`index.html\0${hash}\n`).digest('hex') }, launch, onStage);
      onStage('selftest-assertion');
      if (!result.dom.some(node => node.text === 'ok') || !result.screenshot) throw new Error('交互自检失败');
      stdout(JSON.stringify({ protocol: 1, mode: 'project-browser', version: '1.0.0', sandboxPolicy, ready: true }));
    } else throw new Error('参数无效');
    return 0;
  } catch (error) {
    const reason = diagnosticReason(error);
    stderr(JSON.stringify({ ready: false, error: '项目浏览器运行失败，禁止降级', ...(selftest ? { stage, reason, sandboxPolicy, ...(diagnosticHints[reason] ? { hint: diagnosticHints[reason] } : {}) } : {}) }));
    return 1;
  } finally {
    clearTimeout(watchdog);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runProjectBrowserCLI();
}
