# PRI-941 Option A 实现审计 — Codex Authorized Evidence Consumption

- 日期：2026-10-06
- 分支：`ai/PRI-941-codex-tool-evidence`（worktree，base = origin/main `ac46818e`）
- 授权链：PRI-940 / PRI-941 审计（Owner 批准 Option A）→ 本实现
- 状态：实现 + 测试 + 门禁全绿；**未建 PR**（任务要求），等 Owner review

---

## 1. Changed Files

| 文件 | 变更 |
| --- | --- |
| `packages/pd-cli/src/commands/build-trajectory-evidence.ts` | ①从 `collectEvidenceFromDb` 提取单一 SQL 读取器 `readToolFailureEvidence`（OpenClaw 路径改调它，行为零变化）；②新导出 `acquireCodexToolFailureEvidenceFromDb(stateDir, sessionId, workspaceDir?)`——只读 `tool_calls` 失败行（不触 sessions/user_turns/assistant_turns、不开 rollout），复用既有 `TrajectoryEvidenceAcquisition` union 与脱敏管道 |
| `packages/pd-cli/src/commands/pain-record.ts` | codex 分支：硬编码 `evidence:{status:'unavailable',reason:'trajectory_unavailable'}` → 调用新 acquisition；available 时 evidence/`legacy.evidence` 非空（admission `inputEvidenceCount>0` 链闭合）；unavailable 时保持诚实降级、reason 精确化（`empty_trajectory` 等）；设计注释按审计收窄（"只读已授权工具失败证据；对话表 ingestion 独占"） |
| `packages/pd-cli/tests/commands/build-trajectory-evidence.test.ts` | T1（失败行→available+内容断言+对话内容零混入）、T2a/T2b（空表/缺库）、边界（对话行存在但零失败仍 empty_trajectory）、sentinel |
| `packages/pd-cli/tests/commands/pain-record.test.ts` | T1b（available → recordPain evidence 非空 + evidenceClass available）、T2c（empty_trajectory 降级逐字段保持）、T4（consent not_present 行为不变）；既有 PRI-743 用例增补 acquisition 调用断言 |
| `packages/pd-cli/tests/commands/codex-tool-evidence-boundary.test.ts` | 新增源码级边界 guard：G1（codex 函数与共享 reader 无对话表 SQL）、G2（codex 分支只走 scoped acquisition）、G3（pain-record 零 consent/ingestion import） |
| `.changeset/pri-941-option-a-codex-tool-evidence.md` | `@principles/pd-cli` patch 发布意图 |

## 2. Complexity Delta

```
New durable source of truth: NO（消费既有 tool_calls 表，零新存储）
New persisted schema/state:  NO
New subsystem/service/background process: NO
New public abstraction/interface: NO（一个导出函数，复用既有 union 类型与脱敏管道）
New runtime feature flag: NO
New cross-package dependency: NO
New host/platform-specific behavior: YES — codex 分支行为变更（经 PRI-940/941 审计批准的本任务目的本身）：
  why existing owner cannot satisfy: 现有 ingestion 路径被 G2A 授权边界正确挡住，
  而 tool_calls 已在授权面内；空证据降级使手工 pain 全部 needs_evidence（R-2）。
  minimal: 消费面收窄至"已授权表+仅失败行"，SQL 单一来源防双宿主漂移。
  verified: T1-T5 + 全量回归；removable: revert 单提交即回退。
New external/network capability: NO
```

## 3. Stop Condition 合规

- 允许面：只读 `tool_calls`、仅 `outcome='failure'`、复用 acquisition contract ✓
- 禁止面：未读 user_turns/assistant_turns（G1 guard 锁死）、未读 rollout/reasoning、未执行 `pd codex setup`、未开 ingestion、consent 零变化、G2A 披露未动 ✓
- PainProvenance / painIngress.v1 / admission gate 零改动 ✓
- **未创建 PR** ✓；完成后停止等 Owner review。

## 4. Verification Results

| 套件 | 结果 |
| --- | --- |
| T1-T5 定向（build-trajectory-evidence 26 + pain-record 35 + boundary guard 3） | ✅ 64/64 |
| pd-cli 全量 | ✅ 1808 passed（3 个 spawn 类 5s 超时为负载 flake，单独重跑 19/19 绿） |
| principles-core 全量 | ✅ 8080 passed（Exit 0） |
| eslint（改动文件） | ✅ 0 problem |
| typecheck pd-cli | ✅ 0 error |
| `npm run verify:merge` | ✅ **PASS，exit 0**（一次过，changeset 已含） |

## 5. Risks

1. 上行 LLM 的 evidence 内容含失败工具摘要（tool_name/error_type/exit_code/result_preview≤200，写入与采集双重脱敏）——与 OpenClaw 现状同款；SPEC 修订（"CLI 只读已授权工具失败证据"）须随实现 PR 落 docs。
2. 喂给量随 Codex 使用增长（当前存量 3 条）；`LIMIT 3`+`MAX_EVIDENCE_ENTRIES=8` 天然限幅。
3. 历史存量：codex 工作区尚无被 admission 接受的自动工具失败 pain——Option A 只影响手工 pain 路径，自动链行为不变。

## 6. Rollback

revert 单提交即回退（codex 分支恢复诚实空证据降级）；无数据迁移、无配置、无 flag。
