param(
    [string]$Image = 'deeix-agent-browser-offline:1.56.1',
    [switch]$Render,
    [string]$Html = '<h1>离线快照</h1>'
)
$ErrorActionPreference = 'Stop'
# 先由可信 Docker daemon 创建隔离容器，再检查实际配置；不接受容器内 env 声明。
$modeArgs = @('--selftest')
if ($Render) { $modeArgs = @() }
$policy = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../backend/internal/infra/agentruntime/browser-seccomp.json'))
$expectedPolicy = (Get-Content -Raw -Encoding UTF8 -LiteralPath $policy | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress)
$id = & docker create --network none --user 65532:65532 --read-only --tmpfs /workspace:rw,nosuid,nodev,noexec,size=256m,mode=1777 --workdir /workspace --env HOME=/workspace --env TMPDIR=/workspace --cap-drop ALL --cap-add SYS_CHROOT --label com.deeix.agent.seccomp=moby-27.5.1-chromium-userns-v2 --security-opt no-new-privileges=true --security-opt "seccomp=$policy" --pids-limit 128 --memory 1g --memory-swap 1g --cpus 2 --ipc none --init --ulimit core=0:0 --log-driver none --no-healthcheck -i --entrypoint /usr/local/bin/node $Image /app/src/offline-cli.js @modeArgs
if ($LASTEXITCODE -ne 0) { throw '离线容器创建失败（请先构建 offline target）' }
$id = $id.Trim()
try {
    $inspection = & docker inspect $id
    if ($LASTEXITCODE -ne 0) { throw 'Docker inspect 失败' }
    $state = ($inspection | ConvertFrom-Json)[0]
    $unsafeMounts = @($state.Mounts | Where-Object { $_.Type -ne 'tmpfs' -or $_.Destination -ne '/workspace' })
    $seccomp = @($state.HostConfig.SecurityOpt | Where-Object { $_.StartsWith('seccomp=') })
    if ($seccomp.Count -ne 1 -or $seccomp[0] -eq 'seccomp=unconfined') { throw '拒绝启动：缺少受控 seccomp' }
    $actualPolicy = ($seccomp[0].Substring(8) | ConvertFrom-Json | ConvertTo-Json -Depth 100 -Compress)
    if ($actualPolicy -cne $expectedPolicy -or @($state.HostConfig.SecurityOpt).Count -ne 2 -or $state.HostConfig.SecurityOpt -notcontains 'no-new-privileges=true' -or $state.HostConfig.CapDrop -notcontains 'ALL' -or @($state.HostConfig.CapAdd).Count -ne 1 -or $state.HostConfig.CapAdd[0] -cne 'SYS_CHROOT' -or $state.Config.Labels.'com.deeix.agent.seccomp' -cne 'moby-27.5.1-chromium-userns-v2' -or -not $state.HostConfig.ReadonlyRootfs) { throw '拒绝启动：seccomp/capability/只读边界不匹配' }
    if ($state.HostConfig.NetworkMode -ne 'none' -or $state.HostConfig.Privileged -or $state.Config.User -ne '65532:65532' -or $unsafeMounts.Count -ne 0 -or $state.HostConfig.PidMode -eq 'host') {
        throw '拒绝启动：Docker 隔离配置不匹配'
    }
    # 此结果仅表示本次受信 daemon 的配置观测，不是可复用或生产解锁的证明。
    Write-Host '已检查本次容器 NetworkMode=none；生产公网能力仍关闭。'
    if ($Render) {
        $oldEncoding = $OutputEncoding
        try {
            $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
            $Html | & docker start -a -i $id
        } finally { $OutputEncoding = $oldEncoding }
    } else {
        & docker start -a $id
    }
    if ($LASTEXITCODE -ne 0) { throw '容器执行失败' }
    $result = & docker inspect --format '{{.State.ExitCode}}' $id
    if ($LASTEXITCODE -ne 0 -or $result -ne '0') { throw 'sandbox/渲染自检失败；禁止降级' }
} finally {
    & docker rm -f $id | Out-Null
}
