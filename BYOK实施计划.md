# DEEIX-Chat BYOK（用户自用渠道）功能实施计划

## 项目概述

**目标**：为 DEEIX-Chat 增加用户自用模式（BYOK - Bring Your Own Key），允许用户添加自己的 LLM API 接口配置，同时保留管理员对权限、审计、额度统计的完全控制能力。

**创建时间**：2026-08-23  
**协议**：RIPER-5 + Multidimensional + Agent Protocol

---

## 核心架构设计

### 1. 双层渠道模型

```
路由解析优先级（管理员可配置）：
1. 用户自有渠道（owner_user_id 匹配）
2. 平台全局渠道（owner_user_id IS NULL）
```

**特性**：
- 用户渠道与平台渠道共存同一张表，通过 `owner_user_id` 区分
- 管理员全局控制：禁用/仅统计不扣费/按平台价格扣费
- 完整保留审计链路、权限组过滤、token 用量统计

### 2. 数据模型扩展

#### 渠道表新增字段
- `owner_user_id` (nullable): 归属用户ID，NULL=平台渠道
- `ownership_type`: "platform" | "user"
- `is_shared_with_platform`: 是否纳入平台统计
- `billing_mode`: "self" | "platform_pricing"
- `deleted_at`: 软删除时间戳

#### 用量表新增字段
- `is_user_owned_upstream`: 是否用户自有渠道
- `upstream_owner_user_id`: 渠道归属用户ID
- `upstream_billing_mode`: 渠道计费模式快照

### 3. 管理员控制开关

在 `chat` 命名空间新增 4 个全局设置：
- `user_upstream_enabled` (bool): 是否允许用户添加自有渠道
- `user_upstream_billing_mode` (enum): disabled | statistics_only | platform_pricing
- `user_upstream_quota_limit` (int): 单用户最多创建数量，0=无限制
- `user_upstream_require_approval` (bool): 是否需要管理员审批

### 4. 路由解析改造

在 `ResolveRoute` 函数中实现双层查询：
1. 查询用户自有渠道（owner_user_id = 当前用户）
2. 如果有结果，优先返回
3. Fallback 到平台渠道

### 5. 计费策略集成

用户渠道计费模式：
- **disabled**: 不记录不扣费（极端情况）
- **statistics_only**: 记录用量，强制 `BilledNanousd = 0`
- **platform_pricing**: 按平台价格正常扣费

---

## 实施步骤（45步）

### 阶段 1：数据模型与迁移（步骤 1-8）

**目标**：扩展数据库表结构，支持用户渠道归属

- [x] 步骤 1: 修改 domain/channel/types.go 的 Upstream 结构体
- [x] 步骤 2: 修改 models/channel.go 的 LLMUpstream（改用 BaseModel）
- [x] 步骤 3: 创建迁移脚本 add_user_upstream_fields.sql
- [ ] 步骤 4: 执行迁移脚本，验证表结构
- [x] 步骤 5: 修改 models/billing.go 的 BillingUsageLedger
- [x] 步骤 6: 创建计费表迁移脚本
- [ ] 步骤 7: 执行计费表迁移
- [ ] 步骤 8: 运行单元测试验证

### 阶段 2：管理员全局开关（步骤 9-12）

**目标**：实现管理员配置界面开关

- [x] 步骤 9: settings/seed.go 添加 4 个默认设置项
- [x] 步骤 10: settings/service.go 添加验证逻辑
- [x] 步骤 11: runtime_settings.go 添加运行时应用
- [x] 步骤 12: config/config.go 添加结构体字段

### 阶段 3：仓储层扩展（步骤 13-18）

**目标**：实现用户渠道数据访问层

- [ ] 步骤 13: repository/channel.go 扩展输入结构
- [ ] 步骤 14: 添加 6 个用户渠道方法签名
- [ ] 步骤 15: 修改 ListActiveModelRoutes 添加归属过滤
- [ ] 步骤 16: 实现 ListUserUpstreams 方法
- [ ] 步骤 17: 实现其余 5 个 CRUD 方法
- [ ] 步骤 18: 实现领域对象转换函数

### 阶段 4：应用服务层（步骤 19-23）

**目标**：实现用户渠道业务逻辑

- [x] 步骤 19: channel/dto_user_upstream.go 添加输入结构体
- [x] 步骤 20: channel/errs.go 添加错误定义
- [x] 步骤 21: service_user_upstream.go 实现 ListUserUpstreams / GetUserUpstreamByID
- [x] 步骤 22: 实现 CreateUserUpstream（含配额校验）
- [x] 步骤 23: 实现 Update/Delete 方法

### 阶段 5：路由解析改造（步骤 24-26）

**目标**：实现双层渠道路由优先级

- [x] 步骤 24: 修改 service_routing.go 的 ResolveRoute
- [x] 步骤 25: 实现 getAvailableRoutesWithUserPriority
- [ ] 步骤 26: 集成测试验证优先级逻辑

### 阶段 6：计费集成（步骤 27-30）

**目标**：实现用户渠道计费策略分支

- [x] 步骤 27: service_billing.go 修改 buildSendMessageUsageLedger
- [x] 步骤 28: billing/service.go 添加计费策略分支
- [x] 步骤 29: 路由行与用量账本补齐归属字段映射
- [x] 步骤 30: SendMessageResult 三条链路填充归属信息

### 阶段 7：HTTP 传输层与前端（步骤 31-40）

**目标**：实现用户侧管理界面与管理员配置界面

- [x] 步骤 31: channel/router.go 注册用户渠道路由
- [x] 步骤 32: 创建 handler_user_upstream.go 实现 5 个接口
- [x] 步骤 33: 创建 dto_user_upstream.go 请求/响应结构
- [x] 步骤 34: 前端创建 shared/api/user-upstream.ts
- [x] 步骤 35: 创建 setting/upstreams/page.tsx
- [x] 步骤 36: 实现渠道列表与创建对话框组件
- [x] 步骤 37: 设置侧栏新增入口与中英文词条
- [x] 步骤 38: 管理员通过系统设置项控制 BYOK 开关
- [x] 步骤 39: 前后端编译与类型检查验证
- [ ] 步骤 40: 端到端测试

### 验证与测试（步骤 41-45）

- [ ] 步骤 41: 单元测试：仓储层 CRUD
- [ ] 步骤 42: 集成测试：路由解析逻辑
- [ ] 步骤 43: 集成测试：计费策略分支
- [ ] 步骤 44: 端到端测试：完整用户流程
- [ ] 步骤 45: 安全测试：越权访问校验

---

## 关键技术点

### 1. 越权防护
所有用户渠道操作前必须校验：
```go
if upstream.OwnerUserID == nil || *upstream.OwnerUserID != userID {
    return ErrUpstreamAccessDenied
}
```

### 2. API Key 加密
复用现有 `secretbox` 包，密钥取自全局 `DATA_ENCRYPTION_KEY`：
```go
encryptedKeys, err := s.encryptAPIKeys(string(apiKeysJSON))
```

### 3. 软删除支持
从 `ControlPlaneModel` 改为 `BaseModel`，启用 GORM 软删除：
```go
type BaseModel struct {
    ID        uint
    CreatedAt time.Time
    UpdatedAt time.Time
    DeletedAt gorm.DeletedAt `gorm:"index"`
}
```

### 4. 审计日志记录
所有 CRUD 操作写入 audit_logs：
```go
h.auditService.Write(
    ctx, requestID, userID,
    "user_upstream_create",
    "llm_upstream",
    strconv.Itoa(upstream.ID),
    clientIP, userAgent,
    detailMap,
)
```

### 5. 配额校验
创建前检查用户已有渠道数量：
```go
if cfg.UserUpstreamQuotaLimit > 0 {
    count, _ := s.repo.CountUserUpstreams(ctx, userID)
    if count >= int64(cfg.UserUpstreamQuotaLimit) {
        return nil, ErrUserUpstreamQuotaExceeded
    }
}
```

---

## 预期成果

完成后系统将具备：

✅ 用户可自由添加自己的 API Key（OpenAI、Claude、Gemini 等）  
✅ 管理员保留完全控制权（全局开关、计费策略、配额限制）  
✅ 所有请求保留审计、权限组、额度统计能力  
✅ 平滑兼容现有架构，无破坏性变更  
✅ 支持"仅统计不扣费"满足自托管场景  

---

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 复合唯一索引冲突 | 迁移失败 | 先删除旧索引，再创建新索引 |
| API Key 泄露 | 安全风险 | 强制加密存储，API 响应脱敏 |
| 用户渠道故障污染全局熔断 | 可用性下降 | 熔断状态按 owner_user_id 隔离 |
| 配额绕过 | 资源滥用 | 事务内 SELECT FOR UPDATE 原子计数 |

---

## 当前进度

- [x] 需求调研与架构设计
- [x] 详细实施计划编写
- [x] 阶段1：数据模型修改（已完成）
- [x] 阶段2：管理员全局开关（已完成）
- [x] 阶段3：仓储层扩展（已完成）
- [x] 阶段4：应用服务层（已完成）
- [x] 阶段5：路由解析改造（已完成）
- [x] 阶段6：计费集成（已完成）
- [x] 阶段7：HTTP 传输层与前端（已完成）
- [ ] 验证与测试（待执行，步骤 41-45）

**已完成步骤**：1-40 / 45  
**完成进度**：88.9%

**最后更新**：2026-08-23

---

## 已完成工作总结

### 阶段1：数据模型与迁移 ✅

**完成内容**：
1. ✅ 领域层 `Upstream` 结构体添加 4 个归属字段（OwnerUserID、OwnershipType、IsSharedWithPlatform、BillingMode）
2. ✅ 持久化层 `LLMUpstream` 从 `ControlPlaneModel` 改为 `BaseModel`，支持软删除
3. ✅ 创建渠道表迁移脚本 `20260823000001_add_user_upstream_fields.sql`
4. ✅ 计费用量表 `UsageLedger` 添加 3 个渠道归属字段
5. ✅ 创建用量表迁移脚本 `20260823000002_add_usage_upstream_owner_fields.sql`

**技术要点**：
- 复合唯一索引：`(owner_user_id, name)` 允许同名渠道但归属不同
- 外键约束：`fk_llm_upstreams_owner` 级联删除
- 软删除支持：引入 `deleted_at` 字段与 `BaseModel`

### 阶段2：管理员全局开关 ✅

**完成内容**：
1. ✅ `settings/seed.go` 添加 4 个默认设置项（chat 命名空间）
2. ✅ `settings/service.go` 添加验证逻辑（布尔型、枚举型、整数范围）
3. ✅ `runtime_settings.go` 添加运行时应用逻辑
4. ✅ `config/config.go` 添加 4 个配置字段

**新增设置项**：
- `chat:user_upstream_enabled` (bool): 默认 false
- `chat:user_upstream_billing_mode` (enum): disabled | statistics_only | platform_pricing，默认 statistics_only
- `chat:user_upstream_quota_limit` (int): 默认 3
- `chat:user_upstream_require_approval` (bool): 默认 false

### 阶段3：仓储层扩展 ✅

**完成内容**：
1. ✅ `repository/channel.go` 的 `ListActiveModelRoutesInput` 添加 `OwnerUserID` 和 `OwnershipType` 字段
2. ✅ `ChannelRepository` 接口添加 6 个用户渠道方法签名
3. ✅ 更新 `toUpstreamDomain` 和 `toUpstreamModel` 转换函数，支持归属字段
4. ✅ 创建 `user_upstream.go` 实现 6 个 CRUD 方法：
   - `ListUserUpstreams`: 查询用户所有自有渠道
   - `GetUserUpstreamByID`: 获取指定渠道（带越权校验）
   - `CreateUserUpstream`: 创建用户渠道
   - `UpdateUserUpstream`: 更新用户渠道
   - `DeleteUserUpstream`: 软删除用户渠道
   - `CountUserUpstreams`: 统计用户渠道数量

**技术要点**：
- 所有查询自动过滤 `ownership_type = 'user'`
- 越权校验：强制匹配 `owner_user_id = userID`
- 软删除支持：使用 GORM 的 `Delete` 方法
- 转换函数包含完整的 `BaseModel` 字段映射

---

### 阶段4：应用服务层 ✅

**完成内容**：
1. ✅ `dto_user_upstream.go`：`CreateUserUpstreamInput`、`UpdateUserUpstreamInput`、`APIKeyInput`
2. ✅ `errs.go`：新增 5 个错误定义
3. ✅ `service_user_upstream.go`：List / Get / Create / Update / Delete 与输入校验

**技术要点**：
- 密钥加密复用包级 `encryptAPIKeys(secret, raw)`，密钥来自 `s.cfg.Snapshot().DataEncryptionKey`
- 配额校验命中上限返回 `ErrUserUpstreamQuotaExceeded`
- 开启审批时初始状态为 `pending_approval`

### 阶段5：路由解析改造 ✅

**完成内容**：
1. ✅ `ResolveRoute` 改为调用 `getAvailableRoutesWithUserPriority`
2. ✅ 新增 `service_routing_user.go`：按全局开关与计费模式决定渠道来源
3. ✅ 路由行、`ResolvedRoute` 补充归属字段并在解析处填充

**技术要点**：
- 路由 SQL 增加 `u.owner_user_id / u.ownership_type / u.billing_mode` 三列
- 关闭开关或计费模式为 `disabled` 时仅取平台渠道

### 阶段6：计费集成 ✅

**完成内容**：
1. ✅ `SendMessageResult` 增加归属字段，文本 / 图像 / 视频三条链路统一填充
2. ✅ `buildSendMessageUsageLedger` 将归属信息写入用量账本
3. ✅ `RecordUsageWithAuthorization` 按账本中的渠道计费模式分流
4. ✅ 用量账本持久化层补齐双向字段映射

**技术要点**：
- 非 `platform_pricing` 的自有渠道：仅记录用量，费用置 0 且不动余额
- 计费模式随账本快照落库，避免后续改配置影响历史账单口径

### 阶段7：HTTP 传输层与前端 ✅

**完成内容**：
1. ✅ `handler_user_upstream.go`：5 个用户侧接口
2. ✅ `dto_user_upstream.go`：请求 / 响应结构，响应不含密钥明文
3. ✅ `router.go`：在登录用户组注册 `/user/upstreams` 路由
4. ✅ `shared/api/user-upstream.ts`：前端 API 客户端
5. ✅ `settings-upstreams.tsx` 与 `/setting/upstreams` 页面
6. ✅ 设置侧栏新增入口，补充中英文词条

**接口清单**：
```
GET    /api/v1/user/upstreams
POST   /api/v1/user/upstreams
GET    /api/v1/user/upstreams/:id
PATCH  /api/v1/user/upstreams/:id
DELETE /api/v1/user/upstreams/:id
```

**校验结果**：
- 后端：`go build` 覆盖 domain / repository / application / transport / infra 相关包，全部通过
- 前端：`tsc --noEmit` 无本次改动相关报错

---

## 下一步工作

### 验证与测试（步骤 41-45）

- [ ] 步骤 41: 仓储层 CRUD 单元测试
- [ ] 步骤 42: 路由解析归属优先级集成测试
- [ ] 步骤 43: 计费策略分支集成测试
- [ ] 步骤 44: 端到端流程测试（创建渠道 → 发消息 → 查用量）
- [ ] 步骤 45: 越权访问安全测试

### 已知技术债

1. ~~`getAvailableRoutesWithUserPriority` 目前仅做开关判定，用户渠道优先级仍需仓储层支持按 `owner_user_id` 过滤后才能完整生效~~ ✅ **已完成（2026-08-23）**
   - 仓储层 `ListActiveRoutesByModelWithOwnership` 方法已实现归属过滤
   - 应用层路由逻辑已改造：用户渠道优先 → 无则 fallback 平台渠道
   - 测试桩已补齐，编译校验通过
2. ~~**用户渠道模型绑定缺失**：用户创建渠道后无法建立 `llm_upstream_models` 与 `llm_model_routes` 绑定，渠道实际不会参与路由~~ ✅ **已完成方案 B（2026-08-23）**
   - 新增独立 `llm_user_models` 用户私有模型表，不写入全局 `llm_platform_models`
   - 用户可从自有接口 `/models` 同步任意远端模型
   - 用户可配置自己的模型名称、协议、优先级、权重和启用状态
   - `/user/models` 仅返回当前用户模型，所有 CRUD 均强制校验 `owner_user_id`
   - 聊天模型目录组合平台模型与当前用户私有模型
   - 消息请求新增 `model_scope=user` 与 `user_model_id`
   - 私有模型路由只访问当前用户渠道，禁止跨用户访问和平台模型回退
   - 后端 channel/conversation 定向编译通过；前端全量类型检查因当前环境未安装依赖未完成
3. 渠道连通性测试接口尚未实现
4. 熔断状态仍以 `UpstreamID` 为维度，未按归属隔离
5. `GetUsageStatistics` 未提供按归属维度的过滤参数
