# 5. 对外错误携带脱敏后的上游原始响应

Date: 2026-10-15

## Status

Accepted

## Context

上游请求失败时，平台对外只返回一个固定契约：HTTP 502 + 错误码 `upstream.unavailable` +
文案 `upstream service unavailable`。上游真实返回的状态码与正文其实已被读到并脱敏留档
（`llm.UpstreamError.Body` 与 `UpstreamDebugSnapshot`），但既不出现在 HTTP 错误响应里，
也没有写入错误日志（访问日志只记录 `UpstreamError.Error()` 的 status + message，
且 `UpstreamError` 未实现 `DiagnosticDetail()`）。

结果是用户在画布输出节点上只能看到 `upstream service unavailable` 与
`errorCode: upstream.unavailable`，无法区分究竟是上游拒绝、模型不存在、配额耗尽还是参数非法，
只能求助平台方翻日志。会话流（SSE/NDJSON）的终态错误事件已额外带 `debug` 快照，
但非流式的 HTTP 错误路径完全不带，两条路径口径不一致。

## Decision

1. 上游类失败（错误链上存在 `llm.UpstreamError`）时，错误响应与流式终态事件统一携带
   `details.upstream = { statusCode, message, body }`；`body` 复用既有的脱敏 + 截断快照，
   不新开读取路径、不放松脱敏规则、不提高截断上限。
2. 本地校验类失败（例如协议不匹配）不携带任何上游正文——它本就没有上游响应——
   改为携带定位上下文 `details.context = { runID, taskType, protocol }`，
   回答"走到哪一步被谁拦下"。
3. 前端画布不再把后端英文 canonical 文案当主文案：主文案按 `errorCode` 本地化，
   上游响应与定位上下文收进节点「原始响应」折叠区，并提供复制。
4. 对外错误码契约（`errorCode` 与本地化映射）保持不变，`details` 是增量、可选字段。

## Consequences

- 收益：上游失败可自助定位，不必再由平台方翻日志；错误码契约零破坏。
- 风险：上游正文可能含敏感信息（密钥片段、内部主机名、提示词回显）。缓解：只走既有脱敏快照、
  固定截断上限、且仅在上游类失败时携带。
- 需要在传输层新增一个「带 details 的错误描述写出」入口，并让 HTTP 路径与流式路径共用同一份
  details 组装函数，避免两条路径再次漂移。
- 已否决的备选：
  - 只改前端展示——非流式的 HTTP 错误路径上根本没有上游正文可取，改了也无内容可显示。
  - 把上游正文写进错误日志——日志体积不可控，且排障仍需平台方介入，没有解决自助诉求。
  - 新增「调试模式」开关决定是否透出正文——多一个配置面与两套行为，收益与直接透出脱敏正文相同。
  - 直接透出未脱敏正文——上游正文会回显提示词与密钥片段，等同把用户数据与渠道凭证写进响应体。

## 补充：错误必须区分「上游失败」与「平台自己放弃等待」（同日）

线上反复出现的投诉是「等很久然后报上游服务不可用，但上游其实还在跑或已经成功」。根因是
多种性质完全不同的失败被压成同一个出口：

- 视频轮询的**总等待预算耗尽**（`openAIVideoMaxPollDuration` 10 分钟）返回的是裸的
  `context.DeadlineExceeded`，上游任务通常仍在正常执行；
- 上游**真的**返回了错误（`llm.UpstreamError`，有状态码与正文）；
- 上游在超时时间内**没有回话**（读超时）。

三者对外都变成 `upstream.unavailable` + `upstream service unavailable`，用户无从判断，
也看不到"任务其实还在上游跑"这条最有用的信息。

据此确立：

1. 平台侧等待预算耗尽使用独立错误 `media.video_poll_timeout`，**不计入渠道失败**
   （不触发 `MarkRouteFailure`，避免把我们自己的等待上限算成渠道故障），
   并携带运行上下文，让用户能拿到上游任务号自行核对。
2. 上游请求超时使用独立错误码 `upstream.timeout`，与「上游返回错误」区分。
3. 定位上下文 `details.context` 扩展为
   `{ runID, taskType, protocol, upstreamID, upstreamTaskID, status }`；
   `upstreamID` 与 `upstreamTaskID` 刻意不带 `omitempty`——值为 0 / 空正是关键线索。
4. 结构化 `details` 必须同时送达**流式**错误路径：后端本就在终态错误事件里带了 `details`，
   但客户端把流事件转成错误对象时只传了脱敏快照，导致 `details` 在画布上不可见
   （用户看到「原始响应」与 HTTP 路径不一致）。流式与非流式必须渲染同一份 details。
