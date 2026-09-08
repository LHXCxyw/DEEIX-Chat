# CONTEXT

本文件是项目领域术语表（glossary），只记录术语含义，不记录实现细节。

## 术语

- **创作画布（Creative Canvas）**：原"图像画布"升级后的统一媒体画布，支持图像与视频两类生成节点，路由仍为 `/canvas`。
- **媒体类型（mediaType）**：画布 generate/output 节点的判别字段，`image` 或 `video`，决定端口配对、参数控件与结果渲染。
- **任务会话（Task Conversation）**：画布为每次生成任务创建的一次性会话，完成后软删除，文件保留；画布图结构不绑定会话。
- **三层恢复兜底**：画布刷新后对进行中节点的恢复顺序——① 按 runID 挂断点续传流；② 查任务会话消息附件捞回结果文件；③ 均不可得才标记 error。
- **渠道（Channel）**：管理员配置的一个上游 AI 服务接入点，含 Base URL、密钥与该渠道支持的模型列表。
- **协议（Protocol）**：渠道内某类模型与上游通信所用的方言，如 `openai_video_generations`。一个模型种类（kind）可对应多个候选协议。
- **模型种类（Model Kind）**：模型的功能分类，如 `video_gen`（视频生成）、`video_extension`（视频续写）。
- **适配器（Adapter）**：协议在代码中的具体实现。协议被声明但适配器未实现时，运行期报 "unsupported llm adapter"。
- **视频生成模式**：
  - **T2V（文生视频）**：仅凭 prompt 生成视频。
  - **I2V（图生视频）**：单张输入图 + 可选 prompt。
  - **R2V（参考图生视频）**：多张参考图（上限 7 张）+ 必填 prompt。
- **视频生命周期状态**：上游任务的状态机 `queued → in_progress → completed / failed`。
- **占位（Placeholder）**：已注册到模型目录、可通过配置校验、但运行期不可用的协议。
- **时长计价（PricingModeDuration）**：视频类模型按生成视频的秒数计费的计费模式。
- **Run**：一次消息/媒体生成任务在系统内的执行记录，带任务类型与状态。
