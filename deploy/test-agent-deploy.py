"""不启动 Docker 的部署层静态回归测试。"""
import importlib.util
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare', Path(__file__).with_name('prepare-agent-config.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / 'docker-compose.yml'
ENTRY = ROOT / 'deploy/one-click.sh'


def service_blocks(text):
    """只解析顶层 services，返回每个服务名到其缩进块的映射。"""
    lines = text.splitlines()
    start = lines.index('services:')
    blocks = {}
    current = None
    for line in lines[start + 1:]:
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if not line.startswith(' '):
            break
        match = re.fullmatch(r'  ([a-z0-9][a-z0-9-]*):\s*', line)
        if match:
            current = match.group(1)
            blocks[current] = []
        elif current is not None:
            blocks[current].append(line)
    return {name: '\n'.join(body) for name, body in blocks.items()}


class DeploymentLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compose = COMPOSE.read_text(encoding='utf-8')
        cls.services = service_blocks(cls.compose)
        cls.entry = ENTRY.read_text(encoding='utf-8')

    def test_runtime_containers_are_only_app_postgres_redis(self):
        self.assertEqual(set(self.services),
                         {'config-init', 'app', 'postgres', 'redis', 'agent-command', 'agent-browser'})
        build_only = {name for name, body in self.services.items() if '/bin/true' in body}
        self.assertEqual(build_only, {'agent-command', 'agent-browser'})
        running = set(self.services) - {'config-init'} - build_only
        self.assertEqual(running, {'app', 'postgres', 'redis'})
        for forbidden in ('runner', 'runner-registry', 'runner-socket-init', 'agent-init', 'dind', 'registry', 'seed'):
            self.assertNotIn(forbidden, self.compose)

    def test_app_uses_runtime_agent_and_default_host_socket(self):
        app = self.services['app']
        for expected in ('target: runtime-agent', 'image: deeix-chat:local', '/var/run/docker.sock',
                         'AGENT_DOCKER_HOST', 'AGENT_DOCKER_TLS_VERIFY',
                         'AGENT_DOCKER_CERT_PATH', 'AGENT_DOCKER_ALLOW_INSECURE_TCP',
                         '3700:8080', './data/storage:/app/storage', './data/app:/app/data',
                         './data/agent-deploy:/run/deeix-config:ro',
                         'condition: service_completed_successfully', 'condition: service_healthy'):
            self.assertIn(expected, app)
        init = self.services['config-init']
        for expected in ('image: deeix-chat:local', 'command: ["config"]', '.:/repository', 'network_mode: none'):
            self.assertIn(expected, init)

    def test_supporting_services_use_official_images_and_build_only_agents(self):
        self.assertIn('image: pgvector/pgvector:pg16', self.services['postgres'])
        self.assertIn('image: redis:7-bookworm', self.services['redis'])
        self.assertIn('pull_policy: missing', self.services['postgres'])
        self.assertIn('pull_policy: missing', self.services['redis'])
        for name in ('app', 'config-init', 'agent-command', 'agent-browser'):
            self.assertIn('pull_policy: never', self.services[name])
        command = self.services['agent-command']
        self.assertIn('context: deploy/services/agent-command', command)
        self.assertIn('image: deeix-agent-command:local', command)
        browser = self.services['agent-browser']
        self.assertIn('context: deploy/services/agent-browser', browser)
        self.assertIn('target: project-browser', browser)
        self.assertIn('image: deeix-agent-browser:local', browser)

    def test_one_click_has_only_config_and_app_modes(self):
        modes = set(re.findall(r'^  ([a-z][a-z-]*)\)\s*$', self.entry, re.MULTILINE))
        self.assertEqual(modes, {'config', 'app'})
        for forbidden in ('browser-diagnostic', 'runtime.env', 'runner-registry', 'docker push',
                          'docker pull', 'docker load', 'dockerd', 'dind', 'seed', 'eval ', 'source '):
            self.assertNotIn(forbidden, self.entry)
        self.assertIn('python3 -B /opt/deeix/prepare-agent-config.py /repository', self.entry)

    def test_one_click_injects_local_image_ids_and_labels(self):
        for expected in ('deeix-agent-command:local deeix-agent-command',
                         'deeix-agent-browser:local deeix-agent-project-browser',
                         'image inspect',
                         '{{.Id}}|{{index .Config.Labels "io.deeix.agent.runner"}}',
                         'sha256:[a-f0-9]{64}',
                         'AGENT_COMMAND_IMAGE="$command_image"',
                         'AGENT_COMMAND_ALLOWED_IMAGES="$command_image"',
                         'AGENT_PROJECT_BROWSER_IMAGE="$browser_image"',
                         'AGENT_PROJECT_BROWSER_ALLOWED_IMAGES="$browser_image"',
                         'CONFIG_FILE=/app/config.yaml',
                         'exec /app/deeix-chat'):
            self.assertIn(expected, self.entry)

    def test_agent_images_meet_readiness_metadata(self):
        command = (ROOT / 'deploy/services/agent-command/Dockerfile').read_text(encoding='utf-8')
        for expected in ('ARG BASE_IMAGE=python:3.12-slim-bookworm', 'FROM ${BASE_IMAGE}',
                         'USER 65532:65532', 'io.deeix.agent.runner="deeix-agent-command"',
                         'io.deeix.agent.runner-version="1.0.0"', 'io.deeix.agent.protocol="1"',
                         'ENTRYPOINT ["/usr/local/bin/python3", "-I", "/opt/deeix/runner.py"]',
                         'HEALTHCHECK'):
            self.assertIn(expected, command)
        self.assertNotIn('VOLUME', command)
        browser = (ROOT / 'deploy/services/agent-browser/Dockerfile').read_text(encoding='utf-8')
        for expected in ('FROM runtime AS project-browser', 'USER 65532:65532',
                         'io.deeix.agent.runner="deeix-agent-project-browser"',
                         'io.deeix.agent.sandbox-policy="moby-27.5.1-chromium-userns-v2"',
                         'io.deeix.agent.runner-version="1.0.0"', 'io.deeix.agent.protocol="1"',
                         'ENTRYPOINT ["/usr/local/bin/node", "/app/src/project-browser-cli.js"]',
                         'HEALTHCHECK'):
            self.assertIn(expected, browser)
        self.assertNotIn('VOLUME', browser)

    def test_runtime_agent_image_contains_config_assets(self):
        dockerfile = (ROOT / 'Dockerfile').read_text(encoding='utf-8')
        for expected in ('FROM runtime AS runtime-agent', 'python3',
                         'COPY deploy/prepare-agent-config.py deploy/config.example.yaml /opt/deeix/',
                         'COPY deploy/one-click.sh /opt/deeix/one-click.sh',
                         'COPY backend/internal/infra/agentruntime/browser-seccomp.json /opt/deeix/browser-seccomp.json',
                         'ENTRYPOINT ["/bin/bash", "/opt/deeix/one-click.sh"]',
                         'FROM runtime AS default'):
            self.assertIn(expected, dockerfile)
        self.assertNotIn('/run/deeix-runner/docker.sock', dockerfile)
        self.assertFalse((ROOT / 'deploy/Dockerfile.agent').exists())
        self.assertFalse((ROOT / 'deploy/Dockerfile.agent.dockerignore').exists())

    def test_dockerignore_keeps_only_new_deploy_assets(self):
        rules = (ROOT / '.dockerignore').read_text(encoding='utf-8')
        for allowed in ('!deploy/prepare-agent-config.py', '!deploy/one-click.sh',
                        '!deploy/config.example.yaml', 'deploy/*'):
            self.assertIn(allowed, rules)
        self.assertNotIn('Dockerfile.agent', rules)
        self.assertNotIn('!deploy/services', rules)
        lines = rules.splitlines()
        for excluded in ('config.yaml', 'config.yml', '.env', 'data'):
            self.assertIn(excluded, lines)

    def test_bash_syntax(self):
        candidates = [r'C:\Program Files\Git\bin\bash.exe', shutil.which('bash')]
        bash = next((item for item in candidates if item and Path(item).exists()), None)
        if not bash:
            self.skipTest('没有 Bash，无法检查入口语法')
        result = subprocess.run([bash, '-n', str(ENTRY)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


class ConfigurationTests(unittest.TestCase):
    def test_initialize_and_reenter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('app', 'storage', 'postgres', 'redis'):
                (root / 'data' / name).mkdir(parents=True)
            prepare.prepare(root)
            before = (root / 'config.yaml').read_bytes()
            pg, redis = prepare.credentials(before.decode())
            self.assertEqual(len(pg), 64)
            self.assertNotEqual(pg, redis)
            self.assertNotIn(b'change-me-dev-', before)
            prepare.prepare(root)
            self.assertEqual(before, (root / 'config.yaml').read_bytes())
            self.assertEqual(before, (root / 'data/agent-deploy/config.yaml').read_bytes())
            self.assertEqual(pg, (root / 'data/agent-deploy/postgres-password').read_text())

    def test_missing_old_config_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'data/postgres').mkdir(parents=True)
            (root / 'data/postgres/PG_VERSION').write_text('16')
            with self.assertRaises(ValueError):
                prepare.prepare(root)
            self.assertFalse((root / 'config.yaml').exists())

    def test_existing_secrets_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            text = Path(__file__).with_name('config.example.yaml').read_text(encoding='utf-8')
            text = text.replace('deeix_chat_change_me', 'old$secret;not-shell')
            (root / 'config.yaml').write_text(text, encoding='utf-8')
            prepare.prepare(root)
            self.assertEqual(text, (root / 'config.yaml').read_text(encoding='utf-8'))
            self.assertEqual('old$secret;not-shell',
                             (root / 'data/agent-deploy/redis-password').read_text())

    def test_invalid_config_does_not_write_credentials(self):
        for broken in ('', 'app: {}', 'directory'):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if broken == 'directory':
                    (root / 'config.yaml').mkdir()
                else:
                    (root / 'config.yaml').write_text(broken)
                with self.assertRaises((ValueError, KeyError)):
                    prepare.prepare(root)
                self.assertFalse((root / 'data/agent-deploy/postgres-password').exists())


if __name__ == '__main__':
    unittest.main()
