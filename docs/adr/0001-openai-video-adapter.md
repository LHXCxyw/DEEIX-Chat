# 0001 - OpenAI 兼容视频生成采用 Sora 风格 /v1/videos 透传适配器

日期：2026-09-06
状态：已接受

## 背景

渠道模型目录将 OpenAI 兼容渠道的 `video_gen` 模型默认路由到 `openai_video_generations` 协议，但该协议长期只是占位：配置可保存、运行期报 "unsupported llm adapter"。上游参照 grok2 接口文档（Sora 兼容约定）实现：`POST /v1/videos` 提交任务，`GET /v1/videos/{id}` 轮询，`completed` 后经 `video_url` 临时直链或 `GET /v1/videos/{id}/content` 下载，支持文生视频 / 单图 / 多参考图三种模式。

## 决策

1. **新建独立适配器**（`infra/llm/openai_videos.go`），不复用 xAI 视频适配器：xAI 的提交端点是 `/v1/videos/generations`、请求 ID 字段为 `request_id`、状态词汇为 `pending/done`，与 Sora 风格的 `/v1/videos`、`id`、`queued/in_progress/completed` 均不兼容；强行合并会让两个协议都背上对方的兼容分支。
2. **模型名与多图冲突原样透传**：不做模型名校验/映射，多图 + `sora-2` 之类上游约束交给上游裁决报错，避免本地词汇表追赶上游演进。
3. **图片以内联 data URL（base64）统一放 `image` 字段**：内部附件在应用层已读为字节，无法提供上游可访问的公网 URL；上游文档对 `image` 接受对象/数组，按数量自动归位 T2V/I2V/R2V 模式。
4. **进度经 `GenerateInput.OnProgress` 回调上报**：轮询发生在传输层适配器内部，而流事件由应用层发出；回调是两者之间最小的桥，只在百分比变化时触发，由应用层转成 `media_status` 事件（status `progress`），前端按未知 status 原样展示 message，无需前端改动。
5. **下载顺序为轮询结果的 `video_url` 优先、`/content` 回退**：回退通过 `GeneratedVideo.FallbackURL` 字段承载，下载仍在应用层 `readGeneratedVideo` 统一执行（大小限额、MIME 校验、同源才附 Bearer 的安全策略不变）。

## 备选方案

- **复用 xAI 适配器加分支**：代码最少，但 URL、字段名、状态机三处分歧会累积成条件泥潭（否决）。
- **适配器内直接下载视频返回 base64**：可省去 FallbackURL 字段，但绕开应用层的下载限额与媒体安全策略（否决）。
- **轮询循环上移到应用层**：进度上报更直接，但每个异步协议都要在应用层重复实现轮询/退避/取消，破坏"协议方言收敛在传输层"的分层（否决）。

## 后果

- 后续新增 Sora 兼容上游（如 new-api 中转）只需配置 OpenAI 兼容渠道 + `video_gen` 模型，无需新代码。
- openai 协议下 `video_extension`（续写）仍不可用；如需支持要走类似流程另立适配器。
- 进度事件依赖上游返回 `progress` 字段；上游不返回时前端只看到既有的状态文案。
