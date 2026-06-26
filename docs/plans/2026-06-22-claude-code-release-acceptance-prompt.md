# Claude Code 执行指令：PD 种子发布验收

你是本次 PD 种子发布的唯一验收协调者。仓库为 `D:\Code\principles`，历史 OpenClaw workspace 为 `D:\.openclaw\workspace`，干净 workspace 固定为 `D:\.openclaw\workspace-pd-clean`。

开始前完整阅读：

1. `D:\Code\principles\AGENTS.md`
2. `D:\Code\principles\docs\product\PRODUCT_IDENTITY.md`
3. `D:\Code\principles\docs\ERROR_PATTERN_INDEX.md`
4. `D:\Code\principles\docs\superpowers\specs\2026-06-22-seed-release-dual-agent-acceptance-design.md`
5. `D:\Code\principles\docs\superpowers\plans\2026-06-22-seed-release-dual-agent-acceptance.md`
6. `D:\Code\principles\docs\plans\2026-06-22-openclaw-pd-internal-acceptance-prompt.md`

目标不是修改代码或让测试变绿，而是从真实种子用户路径给出有证据的 GO/NO-GO。禁止直接写生产数据库伪造状态，禁止把单元测试、API 200、历史成功记录或代理自述当作六步闭环证据。

执行规则：

- 先把 Linear PRI-442 移到 In Progress，并评论本次 runId、commit、版本和执行计划。
- 先执行 PRI-447 前置门：真实浏览器必须存在 Owner edit-then-approve。若缺失，登记 P1、输出 NO-GO 并停止；不得用 API/CLI 替代。
- 你是唯一报告写入者。OpenClaw 只返回结构化内部观察；所有跨代理任务使用稳定 testId 和独立 session key。
- 证据根目录必须是 `D:\pd-acceptance-runs\release-<UTC timestamp>`，不得位于 A/B workspace。
- A/B 顺序执行，不并行。每次切换都停止 Gateway、切换 OpenClaw workspace、设置 `PD_WORKSPACE_DIR`、重启，并证明 hook 实际解析到目标 workspace。
- A 取证前不得清理。SQLite 必须在停止写进程后连同 WAL/SHM 快照，或使用 SQLite backup。
- B 必须从与当前 release commit/version 对应的正式 pack 产物安装，记录 tarball SHA-256；不得复制 A 的 PD 状态。
- Web Console 必须由真实浏览器操作并截图：默认认证、Focus、Pain、Principles、详情、edit、approve、reject、Activation deactivate、刷新、重启、错误状态、双击和重复提交。
- Owner 决策由用户授权的测试操作者通过 Console 执行，OpenClaw 不得自批。
- 使用 SenseNova 作为发布验收 provider；LM Studio 只能作为对照。
- 所有危险工具调用只作用于 sandbox 诱饵文件、本地 mock HTTP endpoint 和测试 Git remote。
- 每次失败保存原始证据，最多原地重试一次，再做 A/B 最小复现。不要在本次 run 中修产品代码。
- P0/P1、硬门 SKIP、RuleHost 漏拦/误拦、审批假成功、回滚失败或六步任一步失败，都必须判定 NO-GO。

必须生成：

`environment.json`、`workspace-a-forensics.json`、`workspace-b-install.json`、`external-results.json`、`internal-results.json`、`console-results.json`、`test-case-index.json`、`workspace-resolution.json`、`lineage-map.json`、`rulehost-matrix.json`、`behavior-diff.md`、`defects.md`、`restore-proof.json`、`release-verdict.md`。

每个 JSON 测试结果必须包含：

```json
{
  "testId": "WEB-APPROVE-01",
  "hardGate": true,
  "workspace": "B",
  "expected": "one revised artifact is activated",
  "actual": "observed result",
  "status": "PASS",
  "startedAt": "ISO-8601",
  "durationMs": 0,
  "sessionId": "session-or-null",
  "evidence": ["relative/path/to/screenshot-or-log"],
  "reason": null,
  "nextAction": null
}
```

OpenClaw 调用方式：使用 `openclaw agent --session-key agent:main:<runId>-<testId> --message <phase-prompt> --timeout 900 --thinking high --json`。首次调用先发送内部验收角色指令，后续每次只发送一个阶段包；保留并脱敏原始 JSON。

执行完成后：

1. 校验所有 JSON 可解析、截图存在、lineage IDs 可相互对账；
2. 为真实缺陷创建 Linear 工单，包含复现、期望、实际、证据、严重度和 MVP 三问；
3. 更新 PRI-442，附证据根目录与缺陷表；
4. 只有全部硬门有证据且无 P0/P1 时才能输出 GO；
5. 最终回复只报告 verdict、硬门统计、缺陷统计、证据目录和下一步，不能用笼统的“基本通过”。

