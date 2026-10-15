---
"@principles/pd-cli": minor
---

feat(PRI-985): `pd runtime internalization audit-artificer-evidence` — SPEC-PD-IAER-001 FR-09 的只读历史审计命令。对 workspace `.pd/state.db` 以 readonly 连接（不 bootstrap、零写路径、无 --confirm）扫描 `pi-ai-l2`/`pi-ai` 两种 runtime_kind 下 reason 命中 `behavior_example_pack_missing` 的失败运行，按独立 Task ID 聚合（运行数 ≠ 任务数），每任务报告运行次数、失败分类计数、首次/末次时间、任务当前状态与 attempt/maxAttempts，并给出四类异常布尔标记（repeated_retry_consumption / succeeded_run_then_failed / has_governance_side_effects / pack_missing_failure，治理痕迹经 approvals ⋈ pi_artifacts.source_task_id 权威联查，源表缺失时如实标注 detection=unavailable）；汇总段含按 runtime_kind 与最终任务状态细分；每任务 nextAction 指向真实恢复入口（needs_human_review → `pd runtime internalization retry --confirm`，failed → `pd runtime recovery failed-tasks --confirm`，证据附加入口 PRI-983）。`--json` 严格单对象输出（cli-1），空结果为结构化空报告而非报错，DB 打不开/表缺失为结构化拒绝（exit 1，reason+nextAction，不做任何修复尝试）。
