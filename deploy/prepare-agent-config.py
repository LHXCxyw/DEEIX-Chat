#!/usr/bin/env python3
"""可信部署配置生成与校验；不执行配置中的代码。"""
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile
from urllib.parse import unquote, urlsplit


def scalar(text):
    text = text.strip()
    if text.startswith('"'):
        return json.loads(text)
    if text.startswith("'") and text.endswith("'"):
        return text[1:-1].replace("''", "'")
    if not re.fullmatch(r"[A-Za-z0-9_:/?=&.@+-]+", text):
        raise ValueError("已有 YAML 值过于复杂，请使用内置模板的引号格式；不会修改配置")
    return text


def credentials(text):
    sections = {}
    path = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'( *)([a-z_]+):(?:\s+(.*))?', line)
        if not match:
            continue
        indent, key, value = match.groups()
        depth = len(indent) // 2
        path = path[:depth] + [key]
        if value is not None:
            sections['.'.join(path)] = value
    dsn = urlsplit(scalar(sections['database.postgres.dsn']))
    if (scalar(sections['database.driver']) != 'postgres'
            or scalar(sections['cache.driver']) != 'redis'
            or dsn.scheme != 'postgres' or dsn.hostname != 'postgres'
            or dsn.port != 5432 or dsn.username != 'deeix_chat'
            or dsn.path != '/deeix_chat'
            or scalar(sections['database.redis.addr']) != 'redis:6379'
            or scalar(sections.get('database.redis.username', '""')) != ''):
        raise ValueError('仅支持内置 postgres/redis；外部数据库请人工部署，已有配置保持不变')
    pg = unquote(dsn.password or '')
    redis = scalar(sections['database.redis.password'])
    if not pg or not redis or any(c in pg + redis for c in '\n\r\x00'):
        raise ValueError('数据库密码为空或包含不支持的字符')
    return pg, redis


def atomic(path, text):
    pending = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.pending-', delete=False) as stream:
            pending = Path(stream.name)
            stream.write(text)
        os.chmod(pending, 0o600)
        os.replace(pending, path)
    finally:
        if pending is not None and pending.exists():
            pending.unlink()


def prepare(root):
    state = root / 'data' / 'agent-deploy'
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(state, 0o700)
    config = root / 'config.yaml'
    if config.is_symlink() or (config.exists() and not config.is_file()):
        raise ValueError('config.yaml 必须是普通文件，不允许目录或符号链接')
    if not config.exists():
        if any(p.exists() and any(p.iterdir()) for p in
               (root / 'data' / item for item in ('postgres', 'redis', 'app', 'storage'))):
            raise ValueError('发现旧数据但缺少 config.yaml；请从备份恢复配置，绝不重置密码或加密密钥')
        pg, redis = secrets.token_hex(32), secrets.token_hex(32)
        text = (Path(__file__).parent / 'config.example.yaml').read_text(encoding='utf-8')
        text = text.replace('deeix_chat:deeix_chat_change_me@postgres', f'deeix_chat:{pg}@postgres')
        text = text.replace('password: "deeix_chat_change_me"', f'password: "{redis}"')
        text = text.replace('change-me-dev-jwt-secret', secrets.token_hex(32))
        text = text.replace('change-me-dev-data-encryption-key-32-bytes-min', secrets.token_hex(32))
        # 默认本机 HTTP 使用 dev；生产 HTTPS 由管理员配置，不绕过后端校验。
        text = text.replace('frontend_dist_dir: "./apps/web/out"', 'frontend_dist_dir: "/app/frontend/out"')
        text = text.replace('http://localhost:3000', 'http://localhost:3700')
        text = text.replace('http://127.0.0.1:8080', 'http://localhost:3700')
        with config.open('x', encoding='utf-8') as stream:
            stream.write(text)
    text = config.read_text(encoding='utf-8')
    pg, redis = credentials(text)
    atomic(state / 'config.yaml', text)
    atomic(state / 'postgres-password', pg)
    atomic(state / 'redis-password', redis)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if len(sys.argv) != 2:
            raise ValueError('用法：prepare-agent-config.py <仓库根目录>')
        prepare(Path(sys.argv[1]))
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'配置或初始化检查失败：{error}')
