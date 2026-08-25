-- 迁移脚本：添加用户自有渠道支持（BYOK）
-- 创建时间：2026-08-23
-- 说明：为 llm_upstreams 表添加用户归属字段，支持用户自带 API Key

-- 步骤 1：添加新字段
ALTER TABLE llm_upstreams 
  ADD COLUMN owner_user_id INT UNSIGNED NULL COMMENT '归属用户ID，NULL为平台渠道',
  ADD COLUMN ownership_type VARCHAR(16) NOT NULL DEFAULT 'platform' COMMENT '归属类型: platform/user',
  ADD COLUMN is_shared_with_platform BOOLEAN NOT NULL DEFAULT FALSE COMMENT '用户是否同意纳入平台统计',
  ADD COLUMN billing_mode VARCHAR(16) NOT NULL DEFAULT 'self' COMMENT '计费模式: self/platform_pricing',
  ADD COLUMN deleted_at TIMESTAMP NULL COMMENT '软删除时间';

-- 步骤 2：添加索引
CREATE INDEX idx_llm_upstreams_owner ON llm_upstreams(owner_user_id);
CREATE INDEX idx_llm_upstreams_ownership ON llm_upstreams(ownership_type, status);
CREATE INDEX idx_llm_upstreams_deleted ON llm_upstreams(deleted_at);

-- 步骤 3：修改唯一索引（允许同名渠道但归属不同）
-- 注意：先检查是否存在旧索引再删除
DROP INDEX IF EXISTS idx_llm_upstreams_name ON llm_upstreams;
CREATE UNIQUE INDEX idx_llm_upstreams_owner_name ON llm_upstreams(owner_user_id, name);

-- 步骤 4：迁移现有数据（确保现有渠道标记为平台渠道）
UPDATE llm_upstreams 
SET ownership_type = 'platform', 
    owner_user_id = NULL,
    is_shared_with_platform = FALSE,
    billing_mode = 'self'
WHERE owner_user_id IS NULL;

-- 步骤 5：添加外键约束（可选，增强数据一致性）
-- 注意：如果 users 表不存在或字段名不同，请调整
ALTER TABLE llm_upstreams 
  ADD CONSTRAINT fk_llm_upstreams_owner 
  FOREIGN KEY (owner_user_id) 
  REFERENCES users(id) 
  ON DELETE CASCADE;

-- 回滚脚本（如需回滚，执行以下语句）
/*
ALTER TABLE llm_upstreams DROP FOREIGN KEY fk_llm_upstreams_owner;
DROP INDEX idx_llm_upstreams_owner_name ON llm_upstreams;
CREATE UNIQUE INDEX idx_llm_upstreams_name ON llm_upstreams(name);
DROP INDEX idx_llm_upstreams_deleted ON llm_upstreams;
DROP INDEX idx_llm_upstreams_ownership ON llm_upstreams;
DROP INDEX idx_llm_upstreams_owner ON llm_upstreams;
ALTER TABLE llm_upstreams 
  DROP COLUMN deleted_at,
  DROP COLUMN billing_mode,
  DROP COLUMN is_shared_with_platform,
  DROP COLUMN ownership_type,
  DROP COLUMN owner_user_id;
*/
