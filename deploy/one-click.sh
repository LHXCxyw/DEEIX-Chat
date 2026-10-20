#!/usr/bin/env bash
# 仅作为镜像内可信入口；宿主唯一入口是根 docker-compose.yml。
set -Eeuo pipefail
umask 077
fail() { printf '初始化失败：%s\n' "$*" >&2; exit 1; }

docker_global=()

# 与后端 CLI 保持一致：空端点走本地 Unix socket，远程端点只由管理员环境决定。
prepare_docker_global() {
  local host=${AGENT_DOCKER_HOST:-}
  local tls=${AGENT_DOCKER_TLS_VERIFY:-false}
  local insecure=${AGENT_DOCKER_ALLOW_INSECURE_TCP:-false}
  local cert
  case "$tls" in true|false|"") ;; *) fail 'AGENT_DOCKER_TLS_VERIFY 必须为 true 或 false' ;; esac
  case "$insecure" in true|false|"") ;; *) fail 'AGENT_DOCKER_ALLOW_INSECURE_TCP 必须为 true 或 false' ;; esac
  if [[ -z "$host" ]]; then
    [[ "$tls" != true ]] || fail 'AGENT_DOCKER_TLS_VERIFY=true 时必须设置 AGENT_DOCKER_HOST'
    return 0
  fi
  [[ ! "$host" =~ [[:space:]] ]] || fail 'AGENT_DOCKER_HOST 含非法空白'
  case "$host" in
    unix:///*)
      [[ "$tls" != true ]] || fail 'unix socket 不需要 TLS'
      docker_global=(-H "$host")
      ;;
    tcp://*)
      [[ "$host" =~ ^tcp://[^/]+:[0-9]{1,5}$ ]] || fail 'AGENT_DOCKER_HOST 的 tcp 地址必须为 tcp://host:port'
      docker_global=(-H "$host")
      if [[ "$tls" == true ]]; then
        cert=${AGENT_DOCKER_CERT_PATH:-}
        [[ -n "$cert" && -d "$cert" && -f "$cert/ca.pem" && -f "$cert/cert.pem" && -f "$cert/key.pem" ]] \
          || fail 'AGENT_DOCKER_TLS_VERIFY=true 时证书目录必须包含 ca.pem、cert.pem、key.pem'
        docker_global+=(--tlsverify --tlscacert "$cert/ca.pem" --tlscert "$cert/cert.pem" --tlskey "$cert/key.pem")
      elif [[ "$insecure" != true ]]; then
        fail '拒绝未加密的 tcp Docker 端点；请启用 TLS 或显式设置 AGENT_DOCKER_ALLOW_INSECURE_TCP=true'
      fi
      ;;
    *)
      fail 'AGENT_DOCKER_HOST 必须是 unix:///path 或 tcp://host:port'
      ;;
  esac
}

# 只接受构建产物固定标签，镜像名不可由用户输入。
image_id() {
  local image=$1 expected=$2 output id label
  output=$(env -u DOCKER_HOST -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_CONTEXT \
    docker "${docker_global[@]}" image inspect \
    --format '{{.Id}}|{{index .Config.Labels "io.deeix.agent.runner"}}' "$image") \
    || fail "无法读取镜像：$image"
  IFS='|' read -r id label <<< "$output"
  [[ "$id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail "镜像 ID 格式错误：$image"
  [[ "$label" == "$expected" ]] || fail "镜像标签不匹配：$image"
  printf '%s\n' "$id"
}

case "${1:-}" in
  config)
    python3 -B /opt/deeix/prepare-agent-config.py /repository
    ;;
  app)
    config=/run/deeix-config/config.yaml
    [[ -f "$config" && -s "$config" && ! -L "$config" ]] || fail '缺少可信配置 /run/deeix-config/config.yaml'
    prepare_docker_global
    command_image=$(image_id deeix-agent-command:local deeix-agent-command)
    browser_image=$(image_id deeix-agent-browser:local deeix-agent-project-browser)
    export AGENT_COMMAND_ENABLED=true
    export AGENT_COMMAND_IMAGE="$command_image"
    export AGENT_COMMAND_ALLOWED_IMAGES="$command_image"
    export AGENT_PROJECT_BROWSER_ENABLED=true
    export AGENT_PROJECT_BROWSER_IMAGE="$browser_image"
    export AGENT_PROJECT_BROWSER_ALLOWED_IMAGES="$browser_image"
    # 快照复制到应用工作目录，保留旧相对路径语义；持久配置卷保持只读。
    cp "$config" /app/config.yaml
    chmod 0600 /app/config.yaml
    export CONFIG_FILE=/app/config.yaml
    exec /app/deeix-chat
    ;;
  *)
    fail '此文件为内部容器入口，请执行 docker compose -f docker-compose.yml build 及 up -d'
    ;;
esac
