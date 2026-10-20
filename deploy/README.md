# Deployment

## 唯一部署入口

在仓库根目录执行以下两条命令（也可用 `&&` 连接，构建成功后才启动）：

```bash
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
```

不需要复制配置、运行宿主脚本、Compose overlay、手填 digest、宿主 `docker save` 或私有镜像仓库 token。默认启用 **command + project-browser**，并启动前后端应用、PostgreSQL/pgvector 和 Redis。

`deploy/one-click.sh` 只是镜像内的可信入口，不再作为宿主部署脚本；`compose.agent.yml` 已退役为空映射。请勿使用旧 overlay、`.env` 或 `credentials.json` 部署方式。

### 容器数量

`up -d` 完成后，**运行中常驻容器只有 `app`、`postgres`、`redis` 三个**：

| 服务 | 类型 | 说明 |
| --- | --- | --- |
| `app` | 常驻 | 根 `Dockerfile` 的 `runtime-agent` 目标，执行应用与容器内入口 |
| `postgres` | 常驻 | 官方 `pgvector/pgvector:pg16` |
| `redis` | 常驻 | 官方 `redis:7-bookworm` |
| `config-init` | 一次性 | 使用 `deeix-chat:local` 执行 `one-click.sh config`，生成/保留配置与密码 |
| `agent-command` | build-only | 构建 `deeix-agent-command:local`，`/bin/true` 启动即退出 |
| `agent-browser` | build-only | 构建 `deeix-agent-browser:local`（`project-browser` 目标），`/bin/true` 启动即退出 |

`config-init` 与两个 agent 服务退出 0 后，`app` 才会启动。不存在 runner、DinD、内部 registry、seed、`agent-init` 或 `runner-socket-init`。

### 构建与启动链路

`build` 用根 `Dockerfile` 构建 `app`，并分别构建两个 agent 镜像。`agent-command` 的 `deploy/services/agent-command/Dockerfile` 默认使用公开 Python 基础镜像，管理员仍可通过 `--build-arg BASE_IMAGE=<审核过的镜像>` 覆盖；`agent-browser` 使用 `deploy/services/agent-browser/Dockerfile` 的 `project-browser` 目标。

两个 agent 镜像满足后端 readiness 校验：`linux`、`User 65532:65532`、固定 Entrypoint、`io.deeix.agent.runner` / `io.deeix.agent.runner-version` / `io.deeix.agent.protocol` 标签、Healthcheck，且不声明 `Volumes`。

`up -d` 依次完成：`config-init` 生成/检查根 `config.yaml` 与 `data/agent-deploy` 密码文件；PostgreSQL、Redis 启动并通过健康检查；两个 agent build-only 容器退出 0；最后 `app` 启动。

`app` 入口在容器内校验 `/run/deeix-config/config.yaml`，对 `deeix-agent-command:local` 与 `deeix-agent-browser:local` 执行 `docker image inspect`，读取 `.Id`（必须为 `sha256:<64hex>`）并校验 `io.deeix.agent.runner` 标签分别为 `deeix-agent-command`、`deeix-agent-project-browser`。随后注入 `AGENT_COMMAND_ENABLED`、`AGENT_COMMAND_IMAGE`、`AGENT_COMMAND_ALLOWED_IMAGES` 及对应的 `AGENT_PROJECT_BROWSER_*` 变量，复制配置到 `/app/config.yaml` 并设置 `CONFIG_FILE`，最后 `exec /app/deeix-chat`。入口不读取 `runtime.env`，不使用 `eval`/`source`，也不接受用户传入的镜像名。

### 前提与兼容边界

需要原生 Linux Docker Engine、Compose **2.20 或更新版本**（支持依赖完成/健康条件及依赖更新重启）、BuildKit 和 Linux amd64/arm64。Windows/macOS Docker Desktop 不属于已支持的执行宿主。

构建阶段需要网络拉取公开基础镜像及 apt/npm/pnpm/Go 依赖。`postgres` 与 `redis` 使用官方镜像并设置 `pull_policy: missing`，首次 `up` 仍可能拉取；其余本地构建服务设置 `pull_policy: never`。严格供应链场景需审核构建输入；本方案不声称生产就绪。

## 执行模式

### 同机执行（默认）

`app` 默认把宿主 `/var/run/docker.sock` 挂载到容器内同名路径，后端使用容器内 Docker CLI 在同机 daemon 上启动受限任务容器。`AGENT_DOCKER_HOST` 留空即可。

```bash
docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
```

**风险：同机 `docker.sock` 等同于宿主高权限。** 能访问该 socket 的进程可以创建特权容器、挂载宿主文件系统并读取宿主秘密。`app` 属于可信管理面，不应接入不可信插件或把该 socket 暴露给其他容器。

### 独立 Docker 节点（远程）

管理员可把任务执行放到另一台 Docker 节点，此时不挂载本机 Docker socket：

```bash
export AGENT_DOCKER_HOST=tcp://docker-node.example:2376
export AGENT_DOCKER_TLS_VERIFY=true
export AGENT_DOCKER_CERT_PATH=/run/deeix-config/tls
export DEEIX_DOCKER_SOCKET=/dev/null

docker compose -f docker-compose.yml build
docker compose -f docker-compose.yml up -d
```

把 `ca.pem`、`cert.pem`、`key.pem` 放在 `data/agent-deploy/tls`，该目录已只读挂载到容器内 `/run/deeix-config`，因此容器内证书路径为 `/run/deeix-config/tls`。`DEEIX_DOCKER_SOCKET=/dev/null` 使 `app` 不再挂载宿主 Docker socket；也可以显式覆盖为其他非 socket 路径。

`AGENT_DOCKER_HOST` 只支持 `unix:///绝对路径` 或 `tcp://host:port`。TCP 默认必须启用 `AGENT_DOCKER_TLS_VERIFY=true`；仅在明确接受明文风险时设置 `AGENT_DOCKER_ALLOW_INSECURE_TCP=true`。远程节点上必须已存在 `deeix-agent-command:local` 与 `deeix-agent-browser:local`，可由管理员在远程节点构建或离线加载；本机 `build` 不会自动推送镜像到远程节点。

**远程节点更安全：** `app` 不持有宿主 socket，只能通过受 TLS 保护的远程端点操作执行节点。但该端点仍具备创建容器的管理权限，必须限制网络访问并保护客户端证书。

## 配置、旧数据与更新

首次缺少根 `config.yaml` 且无旧业务数据时，`config-init` 从模板生成配置，随机生成数据库/缓存密码、JWT secret、数据加密密钥。默认 `http://localhost:3700` 是本地 HTTP，因此新配置明确使用 `app.env: dev`；不能冒称生产模式或绕过后端生产 HTTPS 校验。公网部署前必须配置域名、HTTPS、CORS、反向代理和 `app.env: prod`，并配置上游模型/账号；本方案不自动签发证书。

已有根 `config.yaml` **不修改、不覆盖、不重置任何 secret**。仅支持模板结构的内置 postgres/redis，提取原密码供对应容器使用。旧数据存在却缺失配置、目录冒充配置、外部数据库或复杂不支持的 YAML 均报错；请从备份恢复，不自动迁移或猜测密码。Compose 自动创建的空目录不作为旧数据。密码文件与配置快照置于 `data/agent-deploy`，目录 0700、文件 0600；不要分享该目录。`config-init` 挂载仓库根目录到 `/repository`，仅用于读写根配置和该状态目录。

原路径保持：`data/storage` → `/app/storage`、`data/app` → `/app/data`、`data/postgres` → PostgreSQL 原路径、`data/redis` → `/data`。`app` 把根配置快照复制到 `/app/config.yaml`，维持旧相对路径语义；改动根配置后重新执行两条入口命令。

升级前备份根 `config.yaml` 与整个 `data`，更新源码后仍执行同样的 `build`、`up -d`。`config-init` 与两个 build-only agent 服务在镜像或配置变化时由 Compose 重新创建；需要强制重跑时可执行 `docker compose -f docker-compose.yml up -d --force-recreate config-init agent-command agent-browser`。`app` 配置了依赖更新重启。迁移或升级**无需 `down -v`，禁止用删卷解决问题**。更新失败不执行 down/prune，不清空数据；已经运行的旧 app 可能仍在运行，不能把旧 app healthy 误当作本次升级成功，必须核对一次性服务本次退出状态和日志。

## 状态、健康和日志

```bash
docker compose -f docker-compose.yml ps -a
docker compose -f docker-compose.yml logs --tail=100 config-init agent-command agent-browser app
docker compose -f docker-compose.yml logs -f app
curl --fail http://localhost:3700/healthz
curl --fail http://localhost:3700/readyz
```

成功必须同时满足 `config-init`、`agent-command`、`agent-browser` 本次退出 0，`postgres`/`redis`/`app` 健康，并且 app 内的镜像 ID 与标签校验通过。`up -d` 返回本身不等于最终 app healthy。app 健康检查使用 `/readyz`。首次管理员密码从 app 启动日志的 `bootstrap superadmin created` 读取，首次登录必须修改。Swagger 在默认本地 dev 模式开放，公网使用前必须切换 prod。

```bash
# 停止保留数据；不要加 -v
docker compose -f docker-compose.yml down
```

不要删除 `data` 或为排错重新生成加密密钥。

## 安全边界

同机模式下挂载宿主 `docker.sock` 等于把宿主高权限交给 `app`；这种方式只适合单租户、受信管理员环境。独立节点模式不在 `app` 内挂载 Docker socket，风险面更小，但远程 Docker 端点仍是高权限接口，必须启用 TLS、限制来源并保护证书与私钥。

`app` 以 root 运行以便读取配置、复制快照并访问 Docker socket；它属于可信管理面。用户任务容器由后端按固定非 root 用户、只读根文件系统、无网络和资源限额启动，但本方案不把同机 Docker socket 当作强多租户安全边界。

## Optional services

文档解析/OCR 服务独立构建并连接 `deeix-chat-network`。桌面客户端部署见 [`windows/README.md`](windows/README.md)。

当前提交只完成静态检查，**仍欠 Linux Docker 上完整 build/up、同机与远程节点执行、重入升级、故障恢复及 Chromium sandbox 验收**，不承诺任意 Linux 开箱即用。
