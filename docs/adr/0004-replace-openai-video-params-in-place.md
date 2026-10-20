# 4. 就地替换 openai_video_generations 的参数名，不新增协议

Date: 2026-10-15

## Status

Accepted

## Context

`openai_video_generations` 协议原本上送 `extra_images` / `extra_videos` / `extra_audios`（素材）
与 `duration` / `resolution` / `aspect_ratio`（参数），并用一个纯本地的布尔开关 `first_last_frame`
决定是否把前两张参考图映射为首尾帧。

上游兼容协议把字段固定为 `images` / `videos` / `audios` / `first_frame` / `last_frame` /
`seconds` / `size` / `resolution_name` / `ratio` / `mode` / `generate_audio` / `watermark`，
其中 `mode` 取代了 `first_last_frame` 的语义。

## Decision

1. **就地替换** `openai_video_generations` 的字段集，不新增独立协议、不并存新旧字段。
2. 本地 option 的键名直接采用上游字段名，**不引入"本地键 → 上游字段"的映射层**：
   `options` 收敛后的键名即请求体键名。
3. `mode` 取代 `first_last_frame`，取值为 `frames` / `reference`。

## Consequences

- 已配置的、只认旧字段名的上游渠道会立刻失效。这是有意接受的结果（目标上游已按新协议就绪）。
- **必须同步迁移本地历史默认白名单**：`model_option_allowed_paths` 的默认策略是 allowlist，
  若存量装机仍保存着旧的四个放行键，新参数会在应用层被静默过滤、表现为"参数设了不生效"。
  因此 `settings` 的历史默认识别表需要把基线换到旧的视频键集合上。
- 需要同步的面：后端默认放行键、参数收敛白名单、管理端两处白名单示例、
  前端协议控件表与视频参数路径白名单、i18n 标签。
- 收益：单一字段集、无双重语义，本地键与上游字段同名使排障时不需要心智转换。
- 已否决的备选：
  - 新增独立协议（如 `infinite_canvas_video`）——存量渠道零影响，代价是两套视频参数语义长期并存，
    协议表与前端控件表都要维护两份。
  - 同时上送新旧字段作为别名——多数中转站会忽略未知键，可让新旧上游都不炸；代价是请求体冗余，
    且 `first_frame` 在两种语义下形态不同（对象与字符串）无法同名并存。
