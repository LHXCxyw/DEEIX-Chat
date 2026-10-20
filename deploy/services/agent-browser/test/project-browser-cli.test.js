import test from 'node:test';
import assert from 'node:assert/strict';
import { runProjectBrowserCLI } from '../src/project-browser-cli.js';

test('selftest 保留启动阶段与安全分类，不输出原始秘密或无界错误', async () => {
  const stderr = [];
  const knownError = new Error('browserType.launch: No usable sandbox! token=super-secret https://private.invalid/' + 'x'.repeat(10000));
  const code = await runProjectBrowserCLI({ args: ['--selftest'], launch: async () => { throw knownError; }, stderr: line => stderr.push(line), stdout: () => assert.fail('失败时不应输出成功') });
  assert.equal(code, 1);
  const output = stderr.join('\n');
  assert.match(output, /browser-launch/);
  assert.match(output, /no-usable-sandbox/);
  assert.doesNotMatch(output, /super-secret|private.invalid|xxxxxxxx/);
  assert.ok(output.length < 2048);
});

test('selftest 对已知系统错误分类，未知错误不复制消息', async () => {
  for (const [message, reason] of [
    ['Failed to move to new namespace: Operation not permitted', 'namespace-operation-denied'],
    ['clone(CLONE_NEWUSER): EPERM', 'namespace-clone-denied'],
    ['Failed to move to new namespace: clone: Operation not permitted', 'namespace-clone-denied'],
    ['The SUID sandbox helper binary was found, but is not configured correctly', 'setuid-helper-unavailable'],
    ['chrome_crashpad_handler: --database is required', 'crashpad-directory-unavailable'],
    ['mkdtemp /tmp/private-dir: ENOENT', 'temporary-directory-missing'],
    ['Operation not permitted', 'unclassified-error'],
    ['EROFS: private-path', 'filesystem-read-only'],
    ['ENOSPC: private-path', 'workspace-full'],
    ['pthread_create: Resource temporarily unavailable', 'resource-exhausted'],
    ["Executable doesn't exist at private-path", 'browser-dependency-missing'],
    ['EACCES: private-path', 'permission-denied'],
    ['EADDRNOTAVAIL: private-address', 'loopback-listen-failed'],
    ['Timeout 30000ms exceeded', 'operation-timeout'],
    ['Target page, context or browser has been closed', 'browser-process-exited'],
    ['private-unknown-secret', 'unclassified-error'],
  ]) {
    const stderr = [];
    assert.equal(await runProjectBrowserCLI({ args: ['--selftest'], launch: async () => { throw new Error(message); }, stderr: line => stderr.push(line), stdout: () => assert.fail('失败时不应输出成功') }), 1);
    assert.equal(JSON.parse(stderr.at(-1)).reason, reason);
    assert.doesNotMatch(stderr.join(''), /private-/);
  }
});

test('fdinfo chroot 原始断言优先于后续 ENOENT 和 SIGTRAP，不能推断 syscall errno', async () => {
  const stderr = [];
  const log = '[pid=20][err] Check failed: sys_chroot("/proc/self/fdinfo/") == 0\n'
    + '[pid=10][err] FATAL:zygote_host_impl_linux.cc:221 Check failed: . : No such file or directory (2)\n'
    + 'process did exit: exitCode=null, signal=SIGTRAP token=private-secret';
  const code = await runProjectBrowserCLI({ args: ['--selftest'], launch: async () => { throw new Error(log); }, stderr: line => stderr.push(line), stdout: () => assert.fail('失败时不应输出成功') });
  assert.equal(code, 1);
  const diagnostic = JSON.parse(stderr.at(-1));
  assert.equal(diagnostic.ready, false);
  assert.equal(diagnostic.stage, 'browser-launch');
  assert.equal(diagnostic.reason, 'namespace-filesystem-chroot-failed');
  assert.match(diagnostic.hint, /RAW_CHECK.*errno/);
  assert.doesNotMatch(stderr.join(''), /private-secret|pid=20|SIGTRAP/);
});

test('生产请求失败只返回通用错误，不输出诊断或页面内容', async () => {
  const stderr = [];
  const code = await runProjectBrowserCLI({ args: [], input: (async function* () { yield Buffer.from('secret-page-invalid-json'); })(), stderr: line => stderr.push(line), stdout: () => assert.fail('失败时不应输出成功') });
  assert.equal(code, 1);
  assert.deepEqual(stderr.map(JSON.parse), [{ ready: false, error: '项目浏览器运行失败，禁止降级' }]);
});
