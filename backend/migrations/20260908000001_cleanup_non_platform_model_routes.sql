-- 迁移脚本：清理模型路由中指向非平台渠道的遗留绑定
-- 创建时间：2026-09-08
-- 背景：BYOK 上线（2026-08-25）之前，管理端绑定模型来源时未校验渠道归属，
--       部分路由指向了用户自用渠道（ownership_type='user'）。这些路由：
--       1) 不参与任何实际路由调度（平台/用户路由查询均已按归属过滤）；
--       2) 新版代码不再展示（modelUpstreamSourcesBaseQuery 已过滤）。
--       本脚本将其从数据库中彻底清除。可重复执行（幂等）。

DELETE FROM llm_model_routes r
USING llm_upstream_models um, llm_upstreams u
WHERE r.upstream_model_id = um.id
  AND um.upstream_id = u.id
  AND (
    NOT (
      u.ownership_type = 'platform'
      OR ((u.ownership_type IS NULL OR u.ownership_type = '') AND u.owner_user_id IS NULL)
    )
    OR u.deleted_at IS NOT NULL
  );

-- 回滚说明：删除的路由无法通过本脚本恢复，如需找回可从备份恢复，
-- 或在模型管理「上游来源」中重新绑定对应渠道（需先将渠道恢复为平台渠道）。
