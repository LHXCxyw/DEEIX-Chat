# 文件媒体加载慢与缓存失效修复计划

日期：2026-09-14
状态：代码已实施（阶段 0 的 CDN 控制台配置待运维执行；前端 typecheck 待依赖齐备后验证）
关联决策：[ADR-0003 签名链接直连 + CDN 边缘缓存](../adr/0003-signed-media-distribution.md)

## 问题回顾

生产环境（storage=local，出口带宽 19.3Mbps ≈ 2.4MB/s）下，文件媒体统一走"Authorization fetch → blob"全量回源，列表页并发原图导致单图排队分钟级；CDN（CNMCDN）对鉴权内容零缓存，边缘回源超时切断 H2 流，浏览器批量报 `net::ERR_HTTP2_PROTOCOL_ERROR`。浏览器缓存仅 60s 且被 `Vary: Authorization` + token 轮换打穿；无 ETag/304/Range。

已确认的关键事实：

- 签名基建已存在：`filelink.Sign/Verify`，HMAC 绑定 userID+fileID+expires，TTL 1 小时；签名端点路由 `/api/v1/files/:file_id/signed-content` 已注册（public 组）。
- `FileObject.SHA256` 字段已存在，可直接作强 ETag。
- 文件内容永不原地修改（上传与生成均如此），可按不可变内容对待。
- access token TTL 默认 24h（`TokenTTLHours`）。
- CNMCDN 支持：目录/后缀范围规则 + TTL、"忽略 URL 参数"、"分片回源"（1M 分片）；回源超时可调（≥300s）。"强制 CDN 缓存"与"忽略 Vary"**禁止使用**（会把鉴权私有内容缓存后吐给任意请求者）。

## 阶段 0：止血（当天上线，纯配置 + 前端小改）

**CDN 控制台（CNMCDN）：**

1. 新增缓存规则：范围"目录" `/api/v1/files/`，有效期 30 天，**开启**"忽略 URL 参数"与"分片回源"；**不开启**"强制 CDN 缓存"、"忽略 Vary"。鉴权接口靠源站 `private` 头自然不缓存；签名/缩略图接口靠源站 `public, immutable` 头进入边缘缓存。
2. 回源超时调至 ≥300s。
3. 上线后验证：请求 `signed-content` 与缩略图路径应出现边缘命中（`X-Cache: HIT` 类响应头）。

**前端：**

4. `file-thumbnail.tsx` 的 `loadThumbnailURL` 加全局并发队列（并发 3~4），列表页不再瞬间打满带宽。

## 阶段 1：缓存协议升级（后端，~1 天）

改动集中在 `backend/internal/transport/http/filecontent/writer.go` 与 `conversation/handler_file_signed.go`：

1. **ETag/304**：`filecontent.Write` 接收 ETag（取 `FileObject.SHA256`，格式 `"\"<sha256>\""`）；写入前比对请求 `If-None-Match`，命中返回 304（不 open store、不 touch last_accessed）。历史文件 SHA256 为空时回退现场计算并回写 DB。
2. **缓存头调整**：
   - 上传原件（鉴权路径）：`private, max-age=86400`（与 token TTL 对齐）+ `ETag` + 保留 `Vary: Authorization`；替换现在的 `max-age=60`。
   - 生成产物（`generated_image`/`generated_video`）：维持 `immutable, max-age=31536000`，补 `ETag`。
   - 签名端点 `GetSignedFileContent`：`Write(c, result, true)` 改为 `public=true`，输出 `public, immutable`。
3. **Touch 异步化**：`TouchFileObjectLastAccessedAt` 移出请求关键路径（goroutine + 单飞去重），304 命中路径完全不写库。
4. **Range/206**：`filecontent` 写出层改为基于 `http.ServeContent`（local 存储的 reader 断言为 `*os.File`/`io.ReadSeeker`；`LocalStore.Open` 返回可 seek 的文件句柄），统一获得 Range/If-Range/206/Content-Range；安全头（CSP sandbox、CORP、nosniff、Content-Disposition）在 ServeContent 之前手工设置。S3 适配器本次不强制（透传 Range 头作为 TODO 注释）。

验收：同一浏览器二次加载同一图片为 304 或 disk cache；`curl -H "Range: bytes=0-1023"` 返回 206。

## 阶段 2：签名链接媒体分发（~1.5 天）

1. **签名 URL 稳定化**：`filelink.BuildContentURL` 的 `expires` 取整到小时边界（`ceil(now/1h)`），同一小时内同一文件签出逐字节相同的 URL → 浏览器缓存跨页面导航命中，CDN 缓存键（忽略 URL 参数后）天然稳定。
2. **DTO 内嵌签名链接**：以下响应组装处内嵌 `contentURL`（生成媒体）/ `thumbnailURL`（图片附件，阶段 3 后填充）：
   - 消息 hydration（`conversation/service_message_hydration.go`）的附件 DTO；
   - 文件列表 `ListFiles`、画布节点恢复（canvas-store 拉取的文件对象）；
   - 分享详情（`shared-conversations`）与临时会话（`temporary-chat`）的附件 DTO——Q5 决策：一并统一改造。
3. **前端切换加载方式**：
   - 消息气泡/画布节点的**生成图片与视频**改 `<img src={contentURL}>` / `<video src={contentURL}>` 直连，删除对应 fetch→blob 路径（`message-bot.tsx`、`canvas-workspace.tsx`、`preview-dialog.tsx` 的生成媒体分支）；
   - 过期兜底：媒体 `onerror` 时触发所在消息/列表刷新，取新签名 URL 后重试一次。
4. **分享与临时会话**：分享页媒体同样内嵌签名 URL（或复用其 public content 端点 + `public, immutable` 头），删除分享页的全量 fetch 路径。

验收：聊天中生成图片请求 URL 形如 `/api/v1/files/{id}/signed-content?...`，二次进入会话时该请求来自缓存（CDN 或 disk），Network 面板无 blob 全量传输。

## 阶段 3：缩略图变体管线（~1.5 天）

1. **生成实现**（纯 Go，无 cgo）：`golang.org/x/image/draw` 缩放 + `image/jpeg` 输出（q80）；输入支持 JPEG/PNG/WebP（`x/image/webp` 解码）/GIF（取首帧静态）；SVG 与视频不做变体（视频依赖 Range + poster 图标）。
2. **存储布局**（local 与 S3 同一 key 约定）：`variants/thumb/{fileID}.jpg`（≤400px 长边）、`variants/preview/{fileID}.jpg`（≤1280px 长边）。变体存在性按 key 探测（local 读盘廉价），不加 DB 列。
3. **异步管线**：挂靠现有 processing worker——上传/生成完成且 `fileCategory=image` 时投递变体生成任务，失败重试不阻塞原文件可用性。
4. **端点**（两条路由共用一个 handler）：
   - 鉴权版：`authRequired.GET /files/:file_id/thumbnail?variant=thumb|preview`
   - 签名版：`public.GET /files/:file_id/signed-thumbnail?variant=...&user_id=&expires=&signature=`（filelink.Verify，签名材料含 variant）
   - 变体缺失时同步补生成（惰性兜底，覆盖全部存量文件，无需回填任务）；响应 `public/private, immutable` + ETag。
5. **前端**：
   - `FileThumbnail` 用 `thumbnailURL`（签名 thumb 档）`<img>` 直连，删除 fetch 全图路径；
   - 聊天气泡内图片附件显示 preview 档（签名直连），点开预览对话框先 preview 档、下载原图按钮才走原件鉴权 fetch；
   - 阶段 0 的并发队列保留，兜住首屏签名 URL 的边缘未命中场景。

验收：文件列表页与聊天流中不存在任何 >200KB 的图片请求；19.3Mbps 带宽下 20 张图列表首屏 < 3s；存量老文件首次滚入视口可自动补出缩略图。

## 阶段 4：清理与回归（~0.5 天）

1. 移除前端死代码：旧 blob 缓存 Map、生成媒体 fetch 分支。
2. 回归清单：
   - 多账号切换同浏览器：B 账号无法命中 A 账号的原件缓存（Vary 生效）；
   - 无签名/过期签名访问缩略图与生成媒体 → 401；
   - 分享页匿名可看缩略图与生成媒体，不能访问他人原件；
   - 上传非图片（PDF/文本）预览与下载不回归（仍走鉴权 fetch + 304）；
   - 知识库 3 处 `filecontent.Write` 调用点（`knowledgebase/handler.go`）自动继承新缓存头，抽查 304 行为。
3. 灰度与回滚：签名 URL 字段为 DTO 新增字段，前端按字段存在与否回退旧 fetch 路径（一个发布周期后删除）。

## 已知风险

- 签名链接 1 小时内"持有即可读"（仅缩略图与生成媒体），已显式接受（ADR-0003）。
- CDN"忽略 URL 参数"规则若误配为全站，分页/搜索等 query 接口会被吞参数——规则必须圈定在 `/api/v1/files/` 目录。
- CNMCDN 边缘缓存命中率取决于节点行为，上线后需实测 `X-Cache` 头确认；若边缘不尊重源站 `immutable`，用"后缀/目录规则 TTL 30 天"兜底（已配置）。
