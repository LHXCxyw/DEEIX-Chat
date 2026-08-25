-- 迁移脚本：为用量表添加用户渠道归属字段
-- 创建时间：2026-08-23
-- 说明：为 billing_usage_ledgers 表添加渠道归属标记，支持用户自有渠道用量统计

-- 步骤 1：添加新字段
ALTER TABLE billing_usage_ledgers 
  ADD COLUMN is_user_owned_upstream BOOLEAN NOT NULL DEFAULT FALSE COMMENT '是否用户自有渠道',
  ADD COLUMN upstream_owner_user_id INT UNSIGNED NULL COMMENT '渠道归属用户ID',
  ADD COLUMN upstream_billing_mode VARCHAR(16) NULL COMMENT '渠道计费模式快照';

-- 步骤 2：添加索引
CREATE INDEX idx_billing_usage_ownership ON billing_usage_ledgers(is_user_owned_upstream);
CREATE INDEX idx_billing_usage_upstream_owner ON billing_usage_ledgers(upstream_owner_user_id);

-- 步骤 3：迁移现有数据（现有记录全部标记为平台渠道）
UPDATE billing_usage_ledgers 
SET is_user_owned_upstream = FALSE, 
    upstream_owner_user_id = NULL,
    upstream_billing_mode = NULL
WHERE is_user_owned_upstream = FALSE;

-- 回滚脚本（如需回滚，执行以下语句）
/*
DROP INDEX idx_billing_usage_upstream_owner ON billing_usage_ledgers;
DROP INDEX idx_billing_usage_ownership ON billing_usage_ledgers;
ALTER TABLE billing_usage_ledgers 
  DROP COLUMN upstream_billing_mode,
  DROP COLUMN upstream_owner_user_id,
  DROP COLUMN is_user_owned_upstream;
*/
