# 6. 视频任务的「可生成」与「可重查」口径必须成对

Date: 2026-10-15

## Status

Accepted

## Context

视频生成是异步任务：上游先受理、平台轮询取回结果。因此"能不能生成"与"能不能在失败后回查回收"
是同一件事的两半。但当前这两半由两份独立维护的集合判定，且重查还叠加 run 落库的任务类型：

- 生成期：`IsVideoGenerationAdapter` 接受 `gemini_interactions`、`xai_video`、
  `xai_video_extensions`、`openai_video_generations`。
- 重查期：`requeryableVideoProtocols` 只接受 `xai_video`、`xai_video_extensions`、
  `openai_video_generations`，且要求 run 的任务类型为 `video_generation`；
  底层 `RetrieveVideoTask` 同样只实现了这两族协议。

于是存在"能生成、不能重查"的协议：任务确实跑起来了，失败后点「重新查询」却得到
`media route protocol does not match task`——一个既看不出是协议问题、也看不出是任务类型问题的错误，
而用户此时恰恰是最需要回收结果的时候。

## Decision

视频协议的能力声明必须成对，不再出现单向可用的协议：

1. 凡进入生成期白名单的视频协议，要么同时在 `RetrieveVideoTask` 有实现并列入重查白名单，
   要么在**生成期前置拦截**并给出明确文案；不允许"先让任务跑起来、再在回收环节报不匹配"。
2. 协议不匹配类错误必须自证身份：携带 runID、任务类型、协议名
   （见 ADR 0005 的 `details.context`）。
3. 已确定：`gemini_interactions` 虽有视频生成能力，但上游没有"按任务 ID 回查"的接口，
   归入"生成期前置拦截"一侧。

## Consequences

- 收益：任务生命周期内协议口径一致，不再有"跑得起来收不回来"的任务；重查失败可自解释。
- 已有数据：历史上由 `gemini_interactions` 产生的失败视频任务将无法再重查，只能重新生成；
  这是有意接受的代价。
- 结论回补（同日）：线上复现的那条 `openai_video_generations` 运行，**协议检查是通过的**——
  实际命中的是「运行已被记为 success、却仍需要回收产物」这条分支，对外报的是
  `media.video_input_invalid`，与协议白名单无关。协议口径仍按本 ADR 第 1 条统一；
  success 与产物落盘的解耦另见 ADR 0007。
- 已知的口径不一致本身仍然成立：`gemini_interactions` 能生成视频、不在重查白名单，
  该形态按第 2 条在生成期前置拦截。
- 已否决的备选：
  - 两份白名单各管各地继续维护——不一致会随新增视频协议持续复现。
  - 重查期放宽为"无实现也返回 pending"——把不匹配伪装成"上游还在跑"，是更坏的错误：
    用户会一直等一个永远不会回来的结果。
  - 只在前端隐藏「重新查询」按钮——后端仍会受理并报错，只是把问题藏起来。
