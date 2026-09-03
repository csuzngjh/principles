# Failure Report — PRI-634-C 失败注入与失败路径验证（SPEC §12）

## 1. Missing Context → fail loud ✅

注入：`pd runtime internalization context-trace --task nonexistent-task-xyz`

```json
{ "ok": false, "error": { "code": "artifact_not_found",
  "message": "No artifact found for task nonexistent-task-xyz" },
  "nextAction": "Verify the task ID and artifact ID. Use `pd runtime internalization integrity` to check chain health." }
```

结论：结构化 fail-loud（rc-3：显式 code + message + nextAction），无静默空结果。

## 2. Broken Lineage → blocked + reason ✅

注入面：`pd runtime internalization integrity`（工作区现存真实断链，非人工制造）：

- `retry_wait_stale`（warning）×2：09-01 遗留任务卡 retry_wait ~41h（超过 24h TTL），
  附 recommendedAction（integrity-repair --confirm 或 force-fail）
- `running_run_stuck`（error）×2：run 标记 running 但任务 retry_wait，
  附 recommendedAction（标记 run 失败）

context-trace 对断链的报告（P0 期间采集）：`pain_to_dreamer: fail — "…has no summary
envelope"` + degradations 数组 + nextAction —— 定位到具体 artifact。

## 3. Rule Failure → repair receives detailed evidence △（部分实证）

- 历史实证（09-01 链，本次基线盘点确认）：`artificer-repair-evaluator-…-r1/r2` 任务存在且
  succeeded——PRI-634-A 的修复轮真实跑通过（memory 佐证：FAIL→Repair→PASS 回归）。
- 本次验证窗口内，新 rule 通道链（`e6e9636b` code_tool_hook）的 artificer 尚未到
  RuleHost 校验位；若校验失败将进入 artificer-repair（观察中，结论见 internalization-report）。
- 附：本次闭环验证本身发现并修复了一个比"规则修复"更上游的 P0（诊断上下文断裂，
  见 PIPELINE_FINDING.md）——其修复遵循了"fail loud + 定位 + 修复 + 回归"的同构路径。

## 4. 附加失败路径实测（计划外，真实发生）

| # | 失败 | 期望行为 | 实际行为 | 判定 |
|---|---|---|---|---|
| F-1 | 无会话绑定 pain（`pd pain record` 无 --session） | 拒绝/降级 | `all_candidates_gated: needs_evidence ×3`，agent 收到结构化 degraded 回执 | ✅ PRI-642 证据门生效 |
| F-2 | 低置信 pain（内容判 0.42 < 0.5） | 不入链 | 4 候选全部 `needs_evidence: confidence_below_threshold`，诊断任务完成但无下游 | ✅ 置信门生效 |
| F-3 | dreamer 前置诊断缺失（P0 缺陷） | fail loud | **未 fail**：dreamer 以 null 上下文成功产出"缺上下文"元候选并向下游传播 | ❌ → 已修复 + 回归测试（缺口本身即 F-1 级发现，护栏建议见 PIPELINE_FINDING follow-ups） |
| F-4 | dashboard 斜杠命令 `/pd-pain` | 派发到插件命令 | 送入 LLM 当文本（agent 自行解读） | ❌ 平台侧缺口（G-3，记录待跟进） |

## 5. 环境级失败（更新流程，非 PD 代码，已恢复）

- E-1：PD 重装后 `codex` 官方插件 consent 记录丢失 → gateway 拒绝报告 ready（两次复现）。
  恢复：`openclaw plugins install @openclaw/codex --accept-capabilities --force`。
  建议：PD 安装器的 registry 刷新与 OpenClaw 插件 consent 记录的交互需向 Owner 提示。
- E-2：release asset 构建需 `SOURCE_DATE_EPOCH`（未设置时失败信息清晰）。
- E-3：安装器 gateway 探测未识别 schtasks 型 gateway（--stop-gateway 不生效），需手动 stop。
