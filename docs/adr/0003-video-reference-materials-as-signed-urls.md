# 3. 视频生成参考素材一律以签名 URL 交付上游

Date: 2026-10-15

## Status

Accepted

## Context

`openai_video_generations` 协议此前把参考图片、参考视频、参考音频一律读成字节、base64 编码为 `data:` URL 后内联进请求体。

上游兼容协议改为统一以 URL 传递素材：参考素材必须是上游可访问的 HTTP(S) 地址，`data:` 不再被接受。

平台侧唯一能产出"上游可回源拉取"地址的机制是既有的签名内容链接
（`filelink` + 公开路由 `/api/v1/files/:id/signed-content`），它要求部署方同时配置
`PUBLIC_API_BASE_URL` 与 `JWT_SECRET`。`upload.Service.BuildSignedFileContentURL`
已实现该能力，但此前没有任何调用方。

## Decision

视频生成的参考素材不再内联字节：

1. 由 `upload.Service.BuildSignedFileContentURL(userID, fileID)` 为每个素材签发限时公开 URL；
2. 通过 `llm.ContentPart.URL` 把地址交给适配器，适配器直接上送该地址；
3. **签发失败（未配置公网 API 地址或签名密钥）时直接报错**，不回退内联字节、不伪造 URL。

## Consequences

- 视频参考图片不再经过 `normalizeMediaImageEditInput`，失去三项保障：统一转 8-bit RGBA PNG
  （消除上游对编码、色彩模式、容器元数据的不一致支持）、可解码性校验、64MP 总像素上限。
  上游收到的是用户上传的原始文件。
- 视频参考素材链路依赖 `PUBLIC_API_BASE_URL` 与 `JWT_SECRET` 均已配置；未配置时该功能直接不可用，
  本地回环部署也在其列（回环地址上游不可达）。
- 签名 URL 无登录态即可读取、有效期约 1 小时，等于把用户素材临时公开给所配置的上游渠道。
- 收益：请求体不再随素材体积膨胀，平台不再为参考素材占用一遍完整的内存读取。
- 有意保留的边界：`readMediaImageEditFile` 仍被图片编辑链路使用，不随之改动，
  图片编辑的归一化行为保持不变。
- 已否决的备选：
  - 继续内联 `data:` URL——违背上游协议，且请求体随素材体积线性膨胀。
  - 仍读字节做校验但只上送 URL——体积上限与类型分类在上传、素材分类阶段已存在，属冗余；
    而真正的损失（PNG 统一、像素上限）元数据级校验补不回来（`file_objects` 表没有宽高字段），
    收益为零、成本非零。
  - 归一化后另存为新文件再签新文件 URL——能完整保留三项保障，代价是多一次对象存储写入与后续清理；
    留作上游对图片格式挑剔或大图报错真正出现时的逃生口。
