# Agent 增量增强：已确认决策

## 状态

Q1—Q21 已完成逐项确认。本文为最终共识汇总，等待用户确认整体范围后进入具体代码实施。尚未实现或验证任何新增功能。最终明确修订优先于早期推荐。

## 1. 产品与文件模型

普通持久化聊天无需先建项目即可进行文件任务，提供会话专属持久化工作区，可提升为正式项目。正式项目多个会话共享工作区。

第一版覆盖代码、文本、配置文件及 ZIP 项目，不承诺任意 Office/PDF 原格式编辑。上传附件默认只读，原件不可变；用户明确要求编辑后才创建工作副本。ZIP 默认不自动解压，必须明确授权。允许编辑不等于允许执行代码。

任务启动时提供独立权限项：编辑文件、解压指定 ZIP、运行项目代码、浏览当前项目、公网浏览。明确用户指令可以预选，但用户须确认任务授权。在已授权范围内自主执行低风险操作，不逐条确认。授权绑定任务和工作区，不跨任务复用。

项目提升保留同一工作区和历史，不复制文件；提升时不得有运行中的修改任务。第一版不自动合并到已有项目。

单文件修复直接提供文件下载，多文件同时提供 ZIP。交付内容固定为交付时版本，不随后续编辑变化。交付物随所属会话或项目保留并计入存储配额，访问链接过期后可登录重新下载。删除生命周期按第 7 节执行。

临时聊天首版仅保留问答，持久化编辑和执行需先转为普通会话。

## 2. 授权、执行、网络与秘密

任务启动时提供独立权限项：编辑文件、解压指定 ZIP、运行项目代码、浏览当前项目、公网浏览。明确用户指令可以预选，但用户须确认任务授权。在已授权范围内自主执行低风险操作，不逐条确认。授权绑定任务和工作区，不跨任务复用。

项目代码只能在隔离执行环境中运行，禁止直接在 Go 网站宿主机执行。执行容器默认无出站网络，使用管理员预构建镜像及离线依赖；缺失依赖报告验证受阻，不自动联网。首批支持 Node.js/TypeScript 与 Python，Go 后续扩展。

不提供真实秘密。部署、推送代码、访问生产资源、使用秘密默认拒绝。批量删除等高风险操作需额外授权，后端独立校验。Agent 默认不得调用未纳入安全策略的外部 MCP，不因此全局关闭普通聊天 MCP。

普通聊天不创建执行容器。Docker 不可用时允许编辑交付，但必须标记未运行验证，禁止声称测试通过。

## 3. 并发、证据与统一预算

同一工作区一个修改型任务运行，其余排队。人工保存检测版本冲突，不静默覆盖；任务期间工作区版本变化时暂停结果合并。不同工作区受全局和用户配额限制。

修改完成与验证通过分开记录。验证证据绑定文件版本、命令、退出码与日志；文件改变后旧结论失效。不得删除测试、弱化断言或跳过检查冒充修复；确需修改测试需披露原因。浏览器截图或没有控制台错误不单独构成功能正确的证明。

默认限额：

| 范围 | 上限 |
|---|---|
| 每用户运行中的修改任务 | 1 个 |
| 全站执行环境 | 2 个 |
| 单代码执行环境 | 2 CPU、2 GiB 内存、128 PID |
| 单工作区 | 1 GiB，强制磁盘配额 |
| 单次命令 | 120 秒 |
| 单任务 | 30 分钟、32 次模型请求、128 次工具调用 |

管理员可收紧，现有余额和配额继续有效。达到预算保存检查点，确认继续不重置历史消耗；后续增加预算必须是明确授权的增量，不能把恢复当成预算归零。无法落实资源限制时拒绝执行。

## 4. 浏览器与公网授权

首版使用 Playwright + Chromium，默认仅访问当前任务绑定的项目预览。支持浏览网页、点击、填写表单、截图、读取控制台错误、检查失败请求和下载文件。暂不开放任意 JavaScript 执行、原始 CDP 或个人浏览器控制。

公网授权绑定任务、允许域名与有效期，不是互联网通行证。重定向、子资源、WebSocket、弹窗和下载受相同规则控制；授权不能放开宿主机、元数据接口或未授权内网与管理页面。执行容器不因浏览器公网授权而联网。

登录后操作另行授权，绑定站点及具体动作。首版只支持专用测试账户的临时登录会话，不保存密码，不接入个人浏览器，不向模型提供凭据；不得操作生产支付、部署或生产数据。无法安全建立登录态则保持不可用。

浏览器独立默认限额：

| 项目 | 上限 |
|---|---|
| 每任务浏览器实例 | 1 个 |
| 同时打开页面 | 2 个 |
| CPU / 内存 | 1 CPU / 1 GiB |
| 累计活跃运行时间 | 10 分钟 |
| 单次操作 | 30 秒 |
| 单个下载 / 每任务累计下载 | 50 MiB / 200 MiB |

浏览器计入统一 Agent 预算，同时采用独立限额。调度器按浏览器与代码环境合计资源准入；不得将浏览器时间擅自换算成 Token 收费。下载按不可信附件保存，不自动执行、解压或导入工作区。

## 5. 执行恢复与真实取消

持久化操作 ID 和状态。安全操作可重试，文件修改幂等。执行结果不确定的命令禁止盲目重跑；恢复前核对执行记录、容器状态与文件版本。恢复执行不同于恢复进度流。

取消任务必须终止实际执行进程和浏览器，而非仅停止等待或更新界面。保留已持久化修改，未同步内容隔离保留，不直接覆盖工作区。

## 6. 审批生命周期

审批绑定操作 ID、规范化参数、工作区版本及权限范围，最长有效 24 小时。参数或相关文件版本改变即失效。

等待审批时停止命令和浏览器并释放运行配额，保留检查点。等待时间不计活跃执行预算。恢复前重新校验权限、版本与资源；外部账户操作不因重启自动重试。

## 7. 删除与版本清理

删除会话停止其相关任务，清理会话专属工作区，不误删项目共享文件。删除项目先撤销访问并禁止新任务，终止执行环境，再异步清理专属文件、索引及交付物。

文件版本在所属资源存续期间保留；用户显式删除所属项目或会话时允许清理其独占历史版本。这是对旧有“文件版本永不删除”的明确例外。其他有效对象仍引用的内容不得物理删除。

清理须幂等、可重试、可观测，失败可查看与重试。对应内容实际清理完成后才释放存储配额。不以仅软删除替代实际清理要求。

## 8. 领域词汇

- 会话工作区：普通持久化会话专属的可持续编辑文件集合，无需先建项目，可提升为项目工作区。
- 项目工作区：正式项目拥有的可持续编辑文件集合，同一项目多个会话共享当前文件状态。
- 执行环境：为文件任务提供隔离运行与验证能力的临时环境，不是文件唯一持久化载体。
- 交付物：任务交付给用户的固定版本文件或文件集合，与上传原件区分。
- 执行恢复：中断后从已确认状态继续任务，不等同于重新订阅进度流，也不意味着重复执行不确定副作用。

## 9. 实施顺序与验收范围

1. 复核当前代码、工作区与 Run 数据模型，定位迁移和兼容边界；复用现有渠道、计费、认证、文件存储与工具循环，不重建平行系统。
2. 实现会话工作区、附件工作副本、独立任务授权、文件版本冲突与固定版本交付，完成上传—编辑—下载闭环。
3. 实现持久化操作状态、审批与检查点、任务排队及预算；保证幂等、取消和恢复语义。
4. 实现离线隔离命令与进程管理、文件同步和真实验证证据，打通失败—修复—重跑闭环。
5. 实现 Playwright/Chromium 隔离浏览器、项目预览、受控公网及账户授权、下载与证据呈现。
6. 实现删除清理生命周期与资源回收，补齐前端状态、日志、权限交互和错误提示。
7. 分阶段执行真实回归、权限、冲突、重启、取消、配额、网络、清理及端到端验收；报告实际结果和未验证项，不将静态检查或模拟测试当作 Docker/浏览器实测。

上述为范围与顺序，具体文件、接口、迁移及测试命令在最终共识获批后结合代码细化。尚未修改功能代码，未运行新增能力测试。

## 10. 实际实施进展与缺口（2026-10-17）

本节为本批实施事实的增量记录，不修改或替代第 1—9 节的既定决策。上文“尚未实现或验证任何新增功能”“尚未修改功能代码，未运行新增能力测试”保留为实施前的历史状态；当前进展以本节为准。已有基础代码、定向测试通过或构建通过均不代表全部范围已交付或真实环境验收已完成。

### 10.1 本批已接通的聊天能力与授权边界

已接通 `SendMessage` 的 `agent_permissions.edit_files` 显式授权。前端确认默认值为 `false`，授权仅用于一次发送，发送后清除，不沿用到后续发送。

普通持久化会话已接通 workspace 文件 `list`、`read`、`search`、`write`、`patch` 及固定版本 ZIP 交付。这一进展不代表第 1 节全部产品与文件模型均已实现。

Agent 删除及预览执行当前禁用。其余权限 `execute_code`、`browse_project`、`browse_public`、`extract_archives` 在请求值为 `true` 时明确返回 `unsupported`，不得将授权字段存在解释为对应能力可用，也不得绕过限制执行。

### 10.2 已有基础但尚未接通的能力

隔离 Docker 执行器与 operation 持久化基础已有，但尚未接通聊天编排，不能据此声称聊天已具备隔离命令执行、操作恢复或完整任务生命周期能力。

`agent-browser` 当前仅有策略控制基础；真实 browser 请求返回 HTTP `503`，对应能力标记为 `false`。尚无实际 Chromium 执行与网络硬隔离，不能视为可用的隔离浏览器或受控公网浏览能力。

### 10.3 实际验证结果与限制

以下为主 agent 本批实际复跑结果：

| 验证范围 | 实际结果 |
|---|---|
| conversation 应用及 HTTP 包 `go build` | 通过 |
| `domain/agentoperation`、`infra/agentruntime` 的 `go test` | 通过 |
| `apps/web` 的 `pnpm typecheck` | 通过 |
| `agent-browser` 的 `npm test` | 13 项通过 |

此前代理执行的定向 HTTP、权限、普通会话写入、CAS、archive 测试通过；这些是此前定向测试结果，不等同于本批完整包测试通过。完整包测试仍受 CGO 与既有测试桩缺失阻断，不能报告为全部通过。

尚未进行真实 Postgres 迁移验证、Docker 端到端验证或浏览器端到端验证。上述构建、类型检查及单元／定向测试不替代这些真实环境验收，也不证明隔离、网络、取消、恢复或清理语义已在真实环境成立。

### 10.4 剩余实施与验收缺口

任务调度、检查点与恢复、真实命令工具、Playwright 硬隔离及删除清理仍待实现。隔离 Docker 执行器和 operation 持久化基础仍需接入聊天编排；浏览器仍需实现真实 Chromium 执行及网络硬隔离，完成相应真实环境验收后才能开放能力。

第 9 节实施顺序与验收要求继续有效。本节未列为已接通或已验证的既定要求，不因本批进展而自动视为完成；当前不得宣称完整 Agent 执行、浏览器、任务恢复或删除生命周期已交付。

## 11. 后续批次实施进展与验证边界（2026-10-17）

本节仅追加本批事实，保留前文历史记录。第 10 节关于命令尚未接入、`execute_code` 不支持、浏览器仅有策略基础及测试数量的描述属于此前批次状态；这些项目的当前状态以本节为准。既定设计要求不因局部接通或模拟测试通过而自动视为完成。

### 11.1 命令执行与独立授权已接入

`workspace_run_command` 后端及 app 注入已接入，管理员配置 `AGENT_COMMAND_ENABLED`、`AGENT_COMMAND_IMAGE`、`AGENT_COMMAND_ALLOWED_IMAGES` 已接入，命令能力默认关闭。前端 `execute_code` 为本轮独立勾选授权，不要求同时授予 `edit_files`；允许执行不等于允许编辑。

命令输入使用 JSON 工作区文本快照，交给离线 `runner.py` 固定入口；设计与实现边界为不在宿主运行代码、不提供网络或秘密，容器内变更不回写工作区。这些实现约束尚未经过真实 Docker/Linux 环境隔离验收，不能据此声称真实隔离已验证。

操作使用稳定操作 ID 及持久化状态；已有 `running`、`uncertain` 或终态的操作不重跑。这一防重复执行行为不等于完整执行恢复：重启 worker、任务调度排队及清理仍未实现。

### 11.2 Playwright adapter 已实现，生产能力仍关闭

独立 Playwright adapter 已实现 typed 动作、流式下载（stream download）与 close，并具有 fake 测试。生产浏览器请求仍返回 HTTP `503`，能力标记仍为 `browserExecution: false`、`networkBoundary: false`。

adapter 的模拟测试不代表真实 Chromium 已运行，也不证明网络边界或硬隔离成立。真实浏览器与硬隔离均未验证，浏览器能力不得据此开放或宣称验收完成。

### 11.3 主 agent 本批实际验证结果

| 验证范围 | 实际结果 |
|---|---|
| conversation application、HTTP、agentruntime、config 的 `go build` | 通过 |
| `domain/agentoperation`、`infra/agentruntime` 的 `go test` | 通过 |
| `pnpm typecheck` | 通过 |
| `agent-browser` 的 `npm test` | 23 项全部通过；不等同于真实浏览器或隔离验证 |

当前无可用 Docker CLI 或 Linux 环境，runner 的 Linux 测试已跳过，不能记为通过。全量 Go 验证受 CGO／sqlite-vec 阻断，不能报告为全部通过。已有 config Windows 权限测试失败为既有问题，非本批新增。

### 11.4 未完成与未验证项

本批没有进行真实数据库迁移、Docker 或端到端（E2E）验证。重启 worker、调度排队和清理尚未实现；真实浏览器、网络硬边界与容器隔离仍需真实环境验证。构建、类型检查及 fake／单元测试的结果只覆盖各自范围，不替代真实数据库、Docker、浏览器或完整任务生命周期验收。

## 12. Lease 核对、受控回收与固定槽准入进展（2026-10-17）

本节仅追加本批实际结果，保留第 1—11 节的既定决策与历史记录。此前关于核对、准入和清理尚未实现的描述，涉及本节已完成的局部能力时以本节为准；不据此将整体任务调度、执行恢复或清理生命周期视为完成。

### 12.1 过期操作核对与应用关闭等待

已完成对数据库中 lease 过期的 `running` 操作进行 CAS 状态转换，将其标记为 `uncertain`，并接入每分钟核对及 app 关闭时等待。该转换仅记录执行结果不确定，不自动重跑命令，也不代表 checkpoint 续跑或整体恢复流程已实现。

### 12.2 本实例 Docker 清理失败记录与回收边界

Docker 本实例清理失败记录已纳入受控 labels 核对，并按容器 ID 回收。回收范围仅限本实例记录，不跨重启扫描；不得据此声称遗留容器已全部回收。该局部回收机制不等同于会话／项目删除清理生命周期完成。

### 12.3 数据库固定槽准入与占用保留

新增数据库固定 2 槽的全局准入，每个 owner 最多占用 1 槽；准入时按顺序锁定全部槽。达到限制时返回 `busy`，不自动排队，因此不代表第 3 节要求的整体任务队列已实现。

清理失败或发生 panic 时不释放占用，槽位过期不自动复用。未确认清理的占用必须保留，需后续管理恢复处理，不自动释放；lease 过期转为 `uncertain` 不构成释放或复用槽位的依据。

### 12.4 主 agent 本批实际验证结果与边界

以下仅记录主 agent 已实际执行的结果，本次文档更新未重跑任何命令。

| 验证范围 | 实际结果 |
|---|---|
| `domain/admission` 的 `go test` | 命令通过，包内无测试；不视为已有测试覆盖 |
| `domain/agentoperation` 的 `go test` | 通过 |
| `infra/agentruntime` 的 `go test` | 通过 |
| `application/conversation`、`transport/http/conversation` 的 `go build` | 通过 |

数据库及全应用测试因 CGO／sqlite 依赖阻断，尚未验证。本批未进行 Docker 构建或真实容器运行；上述定向测试与构建通过不证明数据库并发准入、真实容器清理或隔离已完成真实环境验收。

### 12.5 仍未完成的范围

整体任务队列、checkpoint 续跑、删除清理及浏览器硬隔离仍未完成。未确认清理的槽位占用仍需后续管理恢复，不得以自动过期释放代替。既定决策及真实数据库、Docker、浏览器和完整任务生命周期验收要求继续有效。

## 13. 管理端槽位恢复与容器身份绑定进展（2026-10-17）

本节仅追加本批真实进展，保留第 1—12 节历史。第 12 节所述需后续管理恢复的槽位，本批已有后端管理接口与受控恢复实现；这不代表前端恢复管理页面、完整任务恢复或清理生命周期已交付。

### 13.1 管理接口与认证边界

已接入 `GET /api/v1/admin/agent-command-slots` 与 `POST /api/v1/admin/agent-command-slots/:slot/recover`，两者均受 JWT 认证与 `AdminOnly` 管理员校验保护。槽位列表不返回 token。

### 13.2 不可变容器身份与受控恢复条件

runtime 在 create 取得不可变容器 ID 后，先通过回调将该 ID 绑定到数据库，绑定成功后才 start 容器。管理恢复仅针对 lease 已过期且状态为 `uncertain` 的操作，并要求存在可信的数据库容器身份绑定及精确匹配的受控 labels；运行中的容器拒绝回收。

恢复流程在 rm 后还须通过权威 inspect 确认容器不存在，随后才以数据库 token、revision 与 identity 的 CAS 条件释放槽位。Docker CLI 错误不能一概解释为容器不存在。缺少可信绑定、lease 尚新鲜、操作仍为 `running` 或清理失败时，均不释放占用；不能以过期或一次删除调用成功代替完整核对。

### 13.3 主 agent 本批实际验证结果

以下仅记录主 agent 已实际执行的结果；本次文档更新未重跑测试或构建。

| 验证范围 | 实际结果 |
|---|---|
| `application/admin` 的 `go test` | 通过 |
| `transport/http/admin` 的 `go test` | 通过 |
| `infra/agentruntime` 的 `go test` | 通过 |
| `domain/agentoperation` 的 `go test` | 通过 |
| `application/conversation`、`transport/http/conversation` 的 `go build` | 通过 |

本批没有真实 Docker 或数据库集成验证。仓储与 conversation 测试仍受 CGO／sqlite 依赖阻断，不能报告为通过。新增模型字段的数据库迁移尚未进行真实验证；定向单元测试及构建通过不证明真实迁移、数据库 CAS 并发行为或 Docker 回收流程已验收。

### 13.4 当前未完成范围

当前没有前端恢复管理页面，完整任务排队、checkpoint 续跑、删除清理及浏览器硬隔离仍未完成。后端槽位受控恢复不等同于任务续跑，不解除既定的真实数据库、Docker、浏览器及完整任务生命周期验收要求。

## 14. 槽位恢复页面与会话删除停止屏障进展（2026-10-17）

本节仅追加本批事实，保留第 1—13 节历史。第 13 节关于前端恢复管理页面尚未实现的描述，以及此前删除生命周期尚未实现的描述，涉及本节局部进展时以本节为准；整体任务与最终删除清理目标仍未完成。

### 14.1 管理端槽位监控与恢复交互

管理员 `/admin/tools` 已接入槽位监控与恢复页面、hook 及 API。恢复前通过确认 dialog 明确告知：槽位恢复不是重跑任务。发生冲突或返回 `blocked` 时重新获取槽位状态，不乐观释放占用。后端 recover 返回 nil 成功结果时的 HTTP `200` 响应问题已修复并完成回归。

### 14.2 会话删除的撤权、取消与写入屏障

删除流程引入 `deleting` 墓碑，先撤销访问权限并发起取消，跟踪实际执行退出及跨实例 cancel。未确认实际停止时返回 HTTP `409`、错误码 `conversation.deletion_pending`，不将仅发出取消请求视为停止完成。归属复核与数据库 active barrier 用于阻止删除期间继续写入；不删除项目共享文件。

当前对同一 user 占用 slot 采用保守 pending 策略，包含与待删除会话无关的命令占用；因此无关命令也可能阻塞该用户的会话删除。这是现有限制，不代表已具备精确到会话的停止判定。

删除成功时 `cleanupStatus` 为 `retained`，不表示内容已物理清理。物理 purge 与清理 worker 尚未实现，仍与第 7 节要求的专属内容实际清理、幂等重试与资源回收目标存在差距，不能将本批停止与写入屏障视为完整删除生命周期交付。

### 14.3 主 agent 本批实际验证结果与边界

以下仅记录主 agent 已实际复跑的结果；本次文档更新未重跑测试或构建。

| 验证范围 | 实际结果 |
|---|---|
| `application/admin` 的 `go test` | 通过 |
| `transport/http/admin` 的 `go test` | 通过 |
| `transport/http/conversation` 的 `go test` | 通过 |
| `infra/agentruntime` 的 `go test` | 通过 |
| `application/conversation` 的 `go build` | 通过 |
| 前端 `pnpm typecheck` | 通过 |

新增应用层及数据库删除测试受 CGO／sqlite 依赖阻断，未能通过执行，不能据此宣称新增删除测试或全面测试已通过。本批未进行 Docker、Postgres、端到端（E2E）验证或镜像构建；上述定向测试、构建与类型检查不替代真实环境验收。

### 14.4 保留的整体未完任务

整体任务排队、检查点续跑、浏览器硬隔离及物理清理继续保留为未完成任务。槽位恢复页面、取消跟踪与删除写入屏障均为局部进展，不代表任务恢复、跨实例停止或完整清理已完成真实环境验收。

## 15. 执行架构收敛与真实服务器验收（2026-10-20）

本节追加本次 Agent 架构改造的最终状态，保留第 1—14 节的设计决策与历史记录。凡前文关于嵌套 DinD、seed、内部 registry、`runtime.env` 或浏览器不可用的描述，以本节为准。

### 15.1 部署与执行架构

- 部署收敛为根目录单文件 Compose，唯一入口仍是 `docker compose -f docker-compose.yml build` 与 `up -d`。
- 常驻容器只有 `app`、`postgres`、`redis`；`config-init` 与两个 agent 镜像构建服务为一次性退出容器。
- 移除嵌套 Docker-in-Docker、内部镜像 registry、seed 导入与 `runtime.env`。任务容器改由宿主 Docker 直接创建，只保留一层容器隔离。
- 同机模式默认挂载宿主 `/var/run/docker.sock`，等同于把宿主高权限交给 `app`；远程模式通过 `AGENT_DOCKER_HOST`（TCP 需 TLS）与 `DEEIX_DOCKER_SOCKET=/dev/null` 连接独立执行节点，不挂宿主 socket。
- `app` 启动时读取本地 `deeix-agent-command:local`、`deeix-agent-browser:local` 的镜像 ID，并校验 runner 标签后注入白名单。

### 15.2 命令与浏览器执行

- `workspace_run_command` 使用离线 Python runner，输入为工作区文本快照，容器断网、非 root、只读根、`cap-drop=ALL`、资源限额；快照 hash、协议版本与持久化变更均由后端复核。
- `project_browser_run` 使用 Playwright + Chromium，支持多文件快照、typed 点击/填写/按键/等待/DOM 摘要/截图，截图作为当前回复附件交付。
- 浏览器 seccomp 策略升级为 `moby-27.5.1-chromium-userns-v2`：在基线之上放行 Chromium 创建用户及嵌套命名空间所需的 `clone`、`setns`、`unshare`，并保留 `chroot` 的 `CAP_SYS_CHROOT` 条件；未开启 `--no-sandbox`、`SYS_ADMIN` 或 seccomp unconfined。
- 浏览器任务使用 `--ipc=private` 提供独立共享内存；sandbox 验证改为实际渲染空白页、执行脚本并截图，不再依赖 headless shell 不提供的 `chrome://sandbox` 页面。
- 真实故障修复记录：`/opt/deeix` 目录权限导致 runner 无法读取；能力检查 2 秒超时内启动 Chromium 导致误报不可用；zygote 因 namespace clone 被拒绝而无法 fork。三者均已按上述方案修复。

### 15.3 权限与文件来源

- 前端只发送 `mode` 时，后端按 `manual`、`auto`、`full` 归一化为允许文件编辑与代码执行，三种模式只区别于审批方式，修复了工具未注册的问题。
- 文件库新增 `source=generated|uploaded` 筛选，`generated` 匹配 `purpose` 为 `generated_image`、`generated_video`、`generated_archive` 的 AI 产出，支持筛选后批量清理而不误删用户上传。
- 生成图片/视频的文件名改用模型短名，不再把 `personal:<providerID>/<model>` 前缀写入文件名；历史文件在前端展示时去除该前缀。

### 15.4 真实服务器验收结果

以下为本次在 Linux Docker 服务器上的实际结果：

| 验证范围 | 实际结果 |
|---|---|
| 单文件 Compose 构建与启动 | 通过；常驻 `app`、`postgres`、`redis` |
| `workspace_run_command` 执行 `python3 -c "print(1)"` | 通过，返回真实退出码与输出 |
| `project_browser_run` 打开项目 HTML 并截图 | 通过，截图成功返回 |
| 浏览器受限自检 | 通过；sandbox 策略为 `moby-27.5.1-chromium-userns-v2` |

### 15.5 仍未完成

公网浏览器仍未开放；持久任务队列、检查点续跑、跨重启预算、物理清理与删除清理 worker 仍未实现。同机 Docker socket 模式仍属高权限部署，生产环境应优先使用独立执行节点。上述真实验收覆盖命令、项目浏览器与部署链路，不覆盖未完成项。

## 16. Web 后端同步确认决策与 D1 后端进展（2026-10-20）

### 16.1 已确认决策与授权边界

本次确认 D1-A、D2-B、D3-A、D4-A、D5-B、D6-A，M1—M5 均认可。D5-B 允许未来启动时自动去重、删除重复行并重建索引；本轮不访问实际数据库，也不实施或验证该数据库操作。D6-A 明确桌面端不动。

仅第一组 D1 获得执行授权，后续组必须审阅后另行批准；已认可决策不等于已授权全部实现。本轮子任务仅实施 D1 的后端轨迹摘要与详情接口，不据此宣称第一组或整体同步完成。

保持 `sync/web-backend-v0.4.5` 分支，实施起点 HEAD 为 `e6eb32ad`；既定同步目标为 `700f88a2`，本轮仅参考本地 `43acb166..v0.4.5` 对应文件选择性移植，不切分支、不合并全仓。同步范围仅 Web、后端及必要共享代码；本次子任务不修改 Web 或桌面端，不引入 ultra、PDF、重试、压缩等其他功能，不修改生成的 Swagger／types 文件及版本。不提交、不推送、不部署、不操作线上。

### 16.2 D1 后端实际实现范围

消息列表仅在显式 `trace=summary` 时，为成功助手消息生成响应副本摘要；默认请求以及运行中、失败、中断消息保持原行为。新增 `detailOmitted` 标记、完整轨迹响应及文档包装、认证路由 `GET /messages/{id}/trace`。详情复用按当前用户读取消息的归属约束与现有轨迹装配；未知或他人消息返回 404，blocked、非助手及无轨迹返回 `processTrace: null`，详情不进行摘要截断。

与上游过滤全部非 think／tool 事件不同，本地摘要保留 text 事件身份、轮次、顺序和时间；思考与中间正文按 rune 保留前 80 字符。工具摘要删除完整输入输出等展开大字段，保留预览、身份、状态和耗时；不可解析的历史工具载荷保持原样。原始轨迹、持久化正文以及现有详情脱敏逻辑不变。当前领域轨迹结构未发现独立 ThinkBlocks 字段，不为此新增平行结构。

新增测试覆盖中文截断、text 多轮及身份／时间保留、原数据不变、非成功消息不摘要、工具瘦身、详情原文、用户归属、blocked、功能关闭及错误边界；这些测试的实际执行情况分别记录如下，不将编写完成视为执行通过。

### 16.3 本轮实际后端验证与限制

在 `backend` 目录执行以下命令，未启动服务、未访问真实数据库，未使用生产桩绕过依赖：

| 命令 | 实际结果 |
|---|---|
| `go test ./internal/application/conversation -run 'Test(SummarizeMessageProcessTraces|SlimToolTracePayload|GetMessageProcessTrace)' -count=1` | setup failed，退出码 1；当前 `CGO_ENABLED=0`，既有测试导入 persistence／sqlitevec，`sqlite-vec-go-bindings/cgo` 被 build constraints 排除；新增应用层测试尚未执行 |
| `go test ./internal/transport/http/conversation -run 'Test(GetMessageProcessTraceHTTPBoundaries|MessageProcessTraceSummaryResponseContract)' -count=1` | 通过，退出码 0；仅内存仓储替身与 httptest 请求，不启动监听服务 |
| `go build ./internal/application/conversation ./internal/transport/http/conversation ./internal/domain/conversation` | 通过，退出码 0 |

以上仅为 D1 后端局部实现与定向验证，不代表全部应用层测试、第一组 D1、后续分组或全仓同步完成。真实数据库、真实服务及端到端验收未执行；应用层测试仍需具备原有 CGO／sqlite-vec 依赖的环境复跑。

## 17. D2-B 重试菜单调整（2026-10-21）

用户已批准 D2-B。本次仅移除助手回复重试时选择其他 reasoning effort 的菜单与单次请求 override；普通 reasoning 配置、消息上的 reasoning 元数据归一化及 composer 控件保持不变。点击重试使用当前 composer model/options，不再从消息重试入口传递 reasoning effort 参数。持久化与临时聊天调用保持单消息参数兼容；临时聊天重试也继续基于当前 runtime 配置。

实现涉及 `apps/web/features/chat/components/message/message-meta.tsx`、`apps/web/features/chat/components/message/message-bot.tsx`、`apps/web/features/chat/components/sections/chat-area.tsx`、`apps/web/features/chat/components/app-chat-area.tsx`、`apps/web/features/chat/hooks/use-chat-message-actions.ts` 与 `apps/web/features/chat/model/chat-reasoning-effort.ts`。`chat-reasoning-effort.ts` 保留 `normalizeMessageReasoningEffort`，移除仅供该菜单使用的类型与 override helper。现有 D1 改动保留，本次未涉及后端、桌面、依赖、版本或生成文件。

本轮 `git diff --check` 通过；在 `apps/web` 搜索 `RegenerateMenuButton`、`ChatRegenerateReasoningOptions`、`regenerateReasoning`、`onRetryWithReasoning` 与 `withChatReasoningEffortOverride` 均无残留。临时 runtime 的重试函数仍仅接收消息，提交使用闭包中的当前 model/options。本机 root 与 `apps/web` 均无 `node_modules`，因此未运行前端 typecheck；未安装依赖，也未启动服务。

同时删除 `chat.reasoningEffort` 下仅供该菜单使用的 `regenerate`、`regenerateWith`、`usedByReply` 三个中英文文案键，避免留下不可达文案；其余 reasoning 文案与 composer 控件未改动。

## 18. D3—D6 实施记录（2026-10-21）

用户要求先完成 D3—D6，前端与端到端体验统一留到后续验证。以下只记录本轮实际完成与未验证边界，不宣称同步完成。

### 18.1 D3-A：保留本地附件策略，接入失败 PDF 原生回退

保留本地「按协议编码能力决定原生附件、不按模型声明或中转地址预过滤」的策略。新增 `nativeInputPolicy.readsWithoutExtraction`：仅当路由支持原生 PDF、文件有存储路径、单文件大小与页数在上限内时，本轮提取失败的 PDF 不再阻断发送，而是进入原生候选；合计预算超出时仍按「无法读取」说明提供。提取失败的音频/视频仍被排除。

`hydrateAttachmentsForSend` 增加原生策略入参，发送入口按当前路由解析策略后传入。新增 `native_input_failed_pdf_test.go` 覆盖策略判定、失败 PDF 候选、失败音频排除及发送前放行/拒绝边界。相关包 `go build` 通过；应用层测试仍受 CGO／sqlite-vec 构建约束阻断，未执行。

### 18.2 D4-A：生成图片独立上限与配额预检

`UploadFileInput` 新增可选 `MaxBytes`：非零时替代管理员上传上限与按类型上限，仅用于平台生成制品。生成图片保存、图片编辑输入读取及上游图片下载统一使用 `maxGeneratedImageBytes`（复用历史图片读取上限 50 MiB）；base64 返回的图片同样受该上限约束。媒体图片与视频请求在计费会话开始前调用 `EnsureGeneratedMediaStorage`，存储已满时提前拒绝，避免上游已计费却必然保存失败。管理员上传限额、缩略图、产物补存/重试逻辑未改动。

`application/upload` 与 `application/settings` 定向测试通过，相关包构建通过。未做真实大图、并发配额竞争或存储已满的端到端验证；配额预检只拒绝「已满」，不预留本次产物空间。

### 18.3 D5-B：重复设置确定性读取与启动修复

新增 `settings/duplicates.go`：同一 namespace+key 优先保留「被修改过」的行，其次更新时间较新，最后取较小 ID；所有配置读取路径改为经由该消解逻辑。`Seed` 先按全表已有键过滤默认值，避免唯一索引失效时重复插入，并在检测到重复行时删除其余行、在事务内重建 `system_settings` 索引；修复失败不阻断启动，只记录警告。设置服务新增日志注入并在 `app.go` 装配。

`repository.SettingsRepository` 增加 `RemoveDuplicates`，Postgres 仓储按 `namespace, key, id` 稳定排序并实现删除与 `REINDEX`；测试替身同步补齐。`application/settings` 包测试通过（含新增重复行选择、种子不重复插入、修复失败继续启动、运行时读取一致性）。**该逻辑会使以后启动在检测到重复行时自动删行并重建索引；本轮未连接任何真实数据库，重复数据是否存在、选行是否符合预期及索引维护耗时均未验证。**

### 18.4 D6-A：版本同步与契约生成不触碰桌面端

`scripts/sync-version.mjs` 新增 `web-backend` 模式（workspace、web、backend），`packages/api-contract/scripts/generate.mjs` 改为使用该模式，契约生成不再改写桌面 `package.json`、Tauri 与 Cargo 版本。桌面原生代码与发行流程未修改，`all` 模式保留给桌面发行流程自行使用。

`node --check` 与 `node scripts/sync-version.mjs --check web-backend`、`--check desktop` 均通过。本轮未提升 `VERSION`，未重新生成 Swagger 与 API 类型文件。

### 18.5 本轮统一未验证项

- 前端 `pnpm typecheck`、构建与页面体验：`node_modules` 缺失；`--frozen-lockfile` 因既有 overrides 与锁文件不一致失败，改用不写锁文件安装时依赖包持续解压失败，已停止且未改动 `pnpm-lock.yaml`。
- 后端 `go build ./...` 与涉及 persistence 的测试：受既有 CGO／sqlite-vec 构建约束阻断；`infra/persistence/postgres/settings` 亦因 `dberror` 依赖 sqlite3 CGO 无法单独构建。
- 未进行 Docker、Postgres、真实模型调用、大文件上传、存储已满或端到端验证；上述定向测试与构建不代表真实环境验收。

## 19. M1—M5 实施记录（2026-10-21）

用户批准继续实施 M1—M5。本轮仍只在 `sync/web-backend-v0.4.5` 分支修改，未提交、未推送、未操作线上。

### 19.1 M1：ultra 档位与推理参数归属

后端新增 `ultra` 规范档位（仅 `openai` 格式可声明）与 `ReasoningOwnedOptionPaths`；`ResolveModelControls` 隐藏被思考强度翻译接管的原生参数。二改保留的协议参数补缺（temperature / top_p / top_k 等）继续生效，测试按「接管路径隐藏、本地补缺保留」调整。前端同步 `ultra` 到模型推理档位列表、管理员档位列表、`reasoning.effort` / `reasoning_effort` 候选值及中英文档位文案；通道与对话 DTO 的 `enums` 注释同步。

`go test ./internal/domain/channel` 通过，channel/conversation 相关包构建通过。

### 19.2 M2：个人渠道批量导入

`@deeix/core` 的导入链接解析支持 v2 多条目（单条仍输出 v1），新增条目数上限与重复条目校验；`/import` 页面新增批量确认界面与逐条导入 hook，链接生成对话框支持增删服务条目。中英文 `settings.json` 补充批量导入文案。

使用 Node 类型剥离直接验证：v1 解析 1 条、v2 解析 2 条、重复条目返回 `duplicate_entry`、v2 链接往返解析仍为 2 条。

### 19.3 M3：编辑快捷键与输入法保护

新增共享 `isImeComposingKeyEvent`，输入框与消息编辑共用；消息编辑在配置的发送快捷键下保存，并跳过输入法组合中的 Enter。`sendShortcut` 从 `AppChatArea` 经 `ChatArea` 传到 `ChatMessageBot`，并纳入 memo 比较。设置页快捷键说明同步更新。

### 19.4 M4：附件失败提示与 Markdown/UI 渲染

附件状态原因改为锚定整卡的 Tooltip；后台处理失败会逐条弹出带原因的提示，上传失败优先展示服务端原因。Markdown 美元公式解析按 Pandoc 规则重写（避免把价格误判为公式），闭合的不支持内联 HTML 按标记处理；新增图片 UI block 与图片画廊，并更新 stat/card/table/quiz 等块的图片支持。工作区 HTML/SVG 沙箱与可执行预览的隔离边界未改变。

Docker 前端构建曾报 `isFileProcessingFailed` 未从 `@/entities/file` 导出；已在 `entities/file/index.ts` 补齐该导出。该错误由构建发现，修复后尚未重新执行 Docker 构建。

### 19.5 M5：契约与文档适配

`packages/api-contract/src/types.generated.ts` 的推理档位联合类型手工补充 `ultra`。`pnpm api:generate` 因缺少 `swagger-typescript-api`（`node_modules` 未安装）在生成阶段失败，未改动任何生成文件；Swagger `docs.go/json/yaml` 尚未重新生成，待依赖可用后统一执行。README 的 fork 说明改为「Web 与后端同步 v0.4.5，桌面端仍为 v0.4.4，另行升级」。

### 19.6 本轮实际验证与未验证项

| 检查 | 实际结果 |
|---|---|
| `go test ./internal/domain/channel` | 通过 |
| `go test ./internal/transport/http/conversation` | 通过 |
| `go test ./internal/application/settings` | 通过 |
| `go test ./internal/application/upload` | 通过 |
| channel / conversation / upload / settings / repository 相关包构建 | 通过 |
| 导入链接 v1/v2/重复/往返（Node 直接执行） | 通过 |
| 中英文 i18n JSON 解析、`git diff --check` | 通过 |
| 前端 typecheck / 构建 / 页面体验 | 未执行，`node_modules` 仍缺失 |
| Swagger 与 API 类型重新生成 | 未执行，生成器依赖缺失；仅手工同步了枚举类型 |
| Docker / Postgres / 真实模型 / 端到端 | 未执行 |

## 20. 允许指定来源 iframe 嵌套（2026-10-21）

New API 的「聊天链接」会在其页面内用 iframe 打开目标站点，而本系统原先对所有响应发送 `X-Frame-Options: DENY`，导致导入链接与聊天界面都无法在 iframe 中加载。

新增配置 `security.frame_ancestors`（环境变量 `SECURITY_FRAME_ANCESTORS`），取值为 CSP `frame-ancestors` 语法：

- 留空、`none` 或含换行/分号等非法内容：保持 `X-Frame-Options: DENY`，行为与之前一致。
- 配置为 `'self'`：发送 `Content-Security-Policy: frame-ancestors 'self'` 与 `X-Frame-Options: SAMEORIGIN`。
- 配置为来源白名单（如 `'self' https://newapi.example.com`）：只发送 CSP，不再发送 `X-Frame-Options`，因为该头无法表达跨子域白名单。

只有同站来源（同一注册域下的不同子域）才能在 iframe 内保持 `SameSite=Lax` 登录 Cookie 可用；跨站来源即使放开嵌套，仍可能受第三方 Cookie 限制。公开文件内容响应继续使用自身的 `frame-ancestors 'none'`，不随该配置放开。

验证：新增中间件测试覆盖默认拒绝、白名单、`'self'` 与非法值；`go test ./internal/transport/http/middleware` 通过，`internal/transport/http` 的静态/版本相关测试通过。`internal/infra/config` 的本地模式密钥权限测试在 Windows 上仍因文件权限表现失败，属既有环境问题。
