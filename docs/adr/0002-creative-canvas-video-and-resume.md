# 0002 - 图像画布升级为创作画布，运行恢复采用三层兜底

日期：2026-09-06
状态：已接受

## 背景

画布原仅支持图像生成节点；视频生成模型（`video_gen`）在聊天端可用但被画布模型选择器排除。同时画布刷新后进行中的任务一律标记"生成任务已中断"，而后端 run 恢复基础设施（断点续传流、批量状态查询、消息附件留痕）已齐备且聊天端在用。

## 决策

1. **统一画布而非新建视频画布**：在现有 generate/output 节点上加 `mediaType: "image" | "video"` 判别字段，端口按媒体类型配对，不新造节点类型。更名"创作画布 / Creative Canvas"，路由 `/canvas` 不变。
2. **视频只走 media 路由**：画布视频任务调用与聊天端相同的 `streamVideoGeneration`（`POST /conversations/:id/media/videos/generations/stream`），参考图以 fileIDs 传入（≤7 张），不做对话协议回退，不做模型能力的本地校验（上游裁决）。视频续写不进画布。
3. **参数配置与图像侧同构**：协议基础控件（前端内置）∪ 管理端 capabilities 下发的 optionControls（`mediaTasks.video_generation`），后端选项策略照常过滤。
4. **刷新恢复三层兜底**：任务节点持久化 `conversationID + clientRunID`；加载时对 pending/streaming 节点依次尝试——① `resumeMessageGenerationStream` 断点续传（图像带 afterSeq 收增量，视频收 status/progress）；② 挂流不可得时查任务会话 assistant 消息附件捞回结果文件；③ 均失败才标 error。恢复成功后照常写回 output 节点并软删除任务会话。
5. **产物只存 fileID**：视频/图像文件一律落内部文件对象（用户文件空间），画布 JSON（localStorage 与云端设置）只存 fileID，不长期依赖上游临时 URL。

## 备选方案

- **新建独立视频画布页**：隔离清晰，但复制整套图引擎、持久化、移动端适配，双画布共享资产困难（否决）。
- **引入 react-flow/zustand 重写**：为视频节点重构图引擎风险大、收益存疑，现有自研引擎已覆盖触控/小地图/undo（否决）。
- **刷新后仅轮询状态不挂流**：实现简单但图像增量流会丢中间预览，且无法感知完成时序（否决，改用挂流 + 查消息兜底）。

## 后果

- 视频输出节点预览依赖内部文件接口（`/api/v1/files/{id}/content`），与上游临时 URL 解耦。
- 画布恢复语义与聊天端对齐：刷新不丢任务，但事件缓存过期后的图像中间预览不可还原（只还原最终产物）。
- `mediaTasks` capabilities 结构扩展 video_generation 条目，管理端模型配置 UI 相应增加控件。
