import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../../../', import.meta.url);
const profile = JSON.parse(await readFile(new URL('backend/internal/infra/agentruntime/browser-seccomp.json', root)));
const base = profile.syscalls.slice(0, -4);
const extra = profile.syscalls.slice(-4);

// 静态模拟无 capability 的 Docker seccomp syscall gate，不声称执行过 Linux syscall。
function allowed(rules, name, flags = 0, arch = 'amd64', caps = []) {
  return rules.some(rule => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes(name)
    && (!rule.includes?.caps?.length || rule.includes.caps.some(cap => caps.includes(cap)))
    && (!rule.includes?.arches || rule.includes.arches.includes(arch))
    && !rule.excludes?.arches?.includes(arch)
    && (rule.args || []).every(arg => {
      assert.equal(arg.index, 0);
      if (arg.op === 'SCMP_CMP_MASKED_EQ') return ((flags & arg.value) >>> 0) === (arg.valueTwo || 0);
      if (arg.op === 'SCMP_CMP_EQ') return flags === arg.value;
      if (arg.op === 'SCMP_CMP_NE') return flags !== arg.value;
      assert.fail('未知比较操作');
    }));
}

test('Docker 27.5.1 无 caps 默认 gate 与 Chromium userns 例外，x86/ARM 一致', () => {
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  assert.equal(profile.defaultErrnoRet, 1);
  assert.deepEqual(extra.map(rule => rule.names), [['clone'], ['setns'], ['unshare'], ['clone']]);
  for (const arch of ['amd64', 'x86', 'x32', 'arm', 'arm64']) {
    for (const syscall of ['clone', 'setns', 'unshare']) {
      assert.equal(allowed(base, syscall, 0x10000000, arch), false, `${arch} 默认禁止 ${syscall}`);
      assert.equal(allowed(profile.syscalls, syscall, 0x10000000, arch), true, `${arch} browser 允许 ${syscall}`);
    }
    assert.equal(allowed(profile.syscalls, 'chroot', 0, arch, ['CAP_SYS_CHROOT']), true);
    for (const syscall of ['mount', 'bpf']) assert.equal(allowed(profile.syscalls, syscall, 0, arch, ['CAP_SYS_CHROOT']), false);
    assert.equal(allowed(profile.syscalls, 'clone', 0x20000000, arch), true, 'Chromium 在 userns 内创建 pid namespace');
    assert.equal(allowed(profile.syscalls, 'clone', 17, arch), true, '保留普通 fork');
    assert.equal(allowed(profile.syscalls, 'clone', 0x70000011, arch), true, '保留 Chromium user/pid/net namespace 启动组合');
    assert.equal(allowed(profile.syscalls, 'clone', 0x00084911, arch), true, '保留 fdinfo 辅助进程 clone，chroot 仍须独立拒绝');
    for (const syscall of ['mount', 'bpf', 'clone3', 'chroot']) {
      assert.equal(allowed(profile.syscalls, syscall, 0, arch), false, syscall);
    }
  }
  assert.ok(base.some(rule => rule.names.includes('clone3') && rule.errnoRet === 38));
  assert.equal(allowed(extra, 'clone', 0x10000000, 's390x'), false);
});

test('app 镜像包含唯一可信 seccomp 策略', async () => {
  const dockerfile = await readFile(new URL('Dockerfile', root), 'utf8');
  assert.match(dockerfile, /COPY backend\/internal\/infra\/agentruntime\/browser-seccomp\.json \/opt\/deeix\/browser-seccomp\.json/);
});
