"""DEEIX runner v1：stdin 单个 JSON；stdout 单个 JSON，不导出文件。

镜像必须提供 /usr/local/bin/python3 与本入口，且不得含秘密、VOLUME 或
后台服务。管理员以离线 digest 白名单启用；普通 Python 镜像不满足契约。
argv 在容器 /workspace 内执行，不经过宿主 shell。只传入显式文本快照，
默认无网络；所有生成文件在容器回收时销毁，不会合并回项目。
"""
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import PurePosixPath


RUNNER_NAME = "deeix-agent-command"
RUNNER_VERSION = "1.0.0"
PROTOCOL_VERSION = 1
MAX_INPUT = 8 << 20
MAX_OUTPUT = 96 << 10


def run(request):
    if request.get("protocol") != 1:
        raise ValueError("不支持的 runner 协议")
    files = request["files"]
    if len(files) > 256:
        raise ValueError("快照文件数超限")
    seen = set()
    total = 0
    for item in files:
        name = item["path"]
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or str(path) != name
                or any(p in (".", "..") for p in path.parts)
                or "\\" in name or ":" in name or "\x00" in name or name in seen):
            raise ValueError("无效快照路径")
        seen.add(name)
        data = item["content"].encode("utf-8")
        total += len(data)
        if len(data) > 1 << 20 or total > 2 << 20:
            raise ValueError("快照大小超限")
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("快照 hash 不匹配")
        parent = os.path.dirname(name)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(name, "xb") as stream:
            stream.write(data)
    argv = request["argv"]
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 64
            or not all(isinstance(a, str) and "\x00" not in a for a in argv)
            or not argv[0]):
        raise ValueError("无效 argv")
    timeout = min(max(float(request["timeout_seconds"]), 1), 30)
    stdout, stderr = bytearray(), bytearray()
    timed_out = False
    try:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, start_new_session=True,
                                 env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/workspace",
                                      "TMPDIR": "/workspace", "LANG": "C.UTF-8"})
    except OSError as exc:
        return {"protocol": 1, "exit_code": 127, "stdout": "", "stderr": str(exc),
                "timeout": False, "snapshot_hash": request["snapshot_hash"],
                "persistent_changes": False}
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, stdout)
    selector.register(child.stderr, selectors.EVENT_READ, stderr)
    limited = False
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                break
            for key, _ in selector.select(min(0.1, max(0, deadline-time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                remaining = MAX_OUTPUT - len(stdout) - len(stderr)
                key.data.extend(data[:remaining])
                if len(data) > remaining:
                    limited = True
                    break
            if limited:
                break
        if not timed_out and not limited:
            try:
                child.wait(timeout=max(0.001, deadline-time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
    finally:
        # 即使命令主进程已退出，也清理同进程组后代；外层 Docker stop/rm 是最终边界。
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        selector.close()
        child.stdout.close()
        child.stderr.close()
    if limited:
        stderr.extend("\n输出超限，命令已终止".encode())
    return {"protocol": 1, "exit_code": child.returncode, "output_limit": limited,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
            "timeout": timed_out, "snapshot_hash": request["snapshot_hash"],
            "persistent_changes": False}


def main():
    if sys.argv[1:] == ["--healthcheck"]:
        sys.stdout.write(json.dumps({"runner": RUNNER_NAME, "version": RUNNER_VERSION,
                                     "protocol": PROTOCOL_VERSION, "status": "ok"},
                                    ensure_ascii=True))
        return
    if sys.argv[1:]:
        raise ValueError("不支持的 runner 参数")
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError("输入大小超限")
    request = json.loads(data)
    os.chdir("/workspace")
    result = run(request)
    sys.stdout.write(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
