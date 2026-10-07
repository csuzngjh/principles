# PRI-941 Option A 实现审计 — Codex Authorized Evidence Consumption

- 日期：2026-10-06
- 分支：`ai/PRI-941-codex-tool-evidence`（worktree，base = origin/main `ac46818e`）
- 授权链：PRI-940 / PRI-941 审计（Owner 批准 Option A）→ 本实现
- 状态：实现 + 测试 + 门禁全绿；分支已推送，PR #1942 已创建（Owner 指令），等 Owner review

---

## 1. Changed Files

| 文件 | 变更 |
| --- | --- |
| `packages/pd-cli/src/commands/build-trajectory-evidence.ts` | ①从 `collectEvidenceFromDb` 提取单一 SQL 读取器 `readToolFailureEvidence`（OpenClaw 路径改调它，行为零变化）；②新导出 `acquireCodexToolFailureEvidenceFromDb(stateDir, sessionId, workspaceDir?)`——只读 `tool_calls` 失败行（不触 sessions/user_turns/assistant_turns、不开 rollout），复用既有 `TrajectoryEvidenceAcquisition` union 与脱敏管道 |
| `packages/pd-cli/src/commands/pain-record.ts` | codex 分支：硬编码 `evidence:{status:'unavailable',reason:'trajectory_unavailable'}` → 调用新 acquisition；available 时 evidence/`legacy.evidence` 非空（admission `inputEvidenceCount>0` 链闭合）；unavailable 时保持诚实降级、reason 精确化（`empty_trajectory` 等）；设计注释按审计收窄（"只读已授权工具失败证据；对话表 ingestion 独占"） |
| `packages/pd-cli/tests/commands/build-trajectory-evidence.test.ts` | T1（失败行→available+内容断言+对话内容零混入）、T2a/T2b（空表/缺库）、边界（对话行存在但零失败仍 empty_trajectory）、sentinel |
| `packages/pd-cli/tests/commands/pain-record.test.ts` | T1（available → recordPain evidence 非空 + evidenceClass available）、T2（empty_trajectory 降级逐字段保持）、T4（consent not_present 行为不变）；既有 PRI-743 用例增补 acquisition 调用断言 |
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
- 完成后停止等 Owner review；PR #1942 经 Owner 指令创建。

## 4. Verification Results

| 套件 | 结果 |
| --- | --- |
| T1-T5（T1/T2 直测于 acquisition+CLI 两层；T3 由 boundary guard + 对话表边界用例；T4 由 CLI 用例 + G3 guard；T5 由既有 OpenClaw 套件承担） | ✅ 64/64（评审轮后 66/66） |
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

## 7. 三维子代理评审轮（2026-10-06/07）

三个独立评审代理（正确性/边界、安全隐私授权、测试质量合规）对 PR #1942 diff 的结论：**三维全部 APPROVE WITH FINDINGS，零 P0，授权边界零违例**（无对话表/rollout/reasoning 访问、consent/ingestion/G2A 零触碰、数据外发面为 OpenClaw 严格子集）。

已修复（评审后追加提交）：
- **P1（正确性维度）**：codex 分支回填 acquisitionReason/Detail 会在 refuse 路径劫持 operator-facing reason（`--logical-key` lineage mismatch 场景被错报为 trajectory 措辞、nextAction 自相矛盾）→ 恢复 null/null + 忠实 reason 回归测试。
- **P2（双代理交叉发现）**：tool_calls 表损坏/缺失被错报 `empty_trajectory` → 区分 `readFailed` → `evidence_read_failed`/`codex_tool_calls_unreadable`（与 OpenClaw 兄弟函数语义对齐）+ 用例。
- **P2-1**：新 describe 补 afterEach tmpdir 清理（对齐同文件模式）。
- **P2-5**：本文档三处表述更正（PR 状态/T 用例名/T3、T5 的间接覆盖映射）。

记录为 follow-up（不阻塞合并，均非本 PR 引入或属精度加固）：
- sentinel 检查结果在 CLI 层被 bound-无条件降级吞没（PRI-743 既有语义；acquisition 单测可能造成保护错觉）；
- `sourceRef` 无长度界（OpenClaw 路径既有同款模式，建议统一 ≤300）；
- result_preview 截断先于读取侧 token redact 的微缝隙（需 DB 被未脱敏第三方写入才成立）；
- CLI T4 的字符串缺席断言实质由 G3 guard 承担；`mockReturnValueOnce` 跨用例残留为潜伏风险；
- G1 切片断言对精确实参文本/函数后追加代码有误报脆弱性（漂移时均响亮失败，无假通过路径）。

## 8. PR #1942 机器人评审轮（2026-10-07）

三条行内意见逐条核验与处置：

| 来源 | 意见 | 核验 | 处置 |
| --- | --- | --- | --- |
| CodeRabbit（Minor） | readFailed 应先于空判断区分 → `evidence_read_failed` | 属实——与三维评审轮 F2 为同一发现 | **已修复**（评审轮提交，与该建议 diff 一致） |
| Codex（P1） | session 级失败证据与 pain 所绑 turn 无权威关联，可能"他处失败"撑起 evidence | 粒度观察属实，**修复建议不采纳**：session 级上下文是共享 acquisition contract（PRI-341）既有语义，OpenClaw 同构且本 PR 明确不改契约；turn 级关联需 tool_calls 加列 = schema 演进，超出已批边界；"绕过空证据门"即 Option A 设计目的；LIMIT 3+时间倒序已限幅 | 已在 PR 行内回复裁定理由 + 记 follow-up（tool_calls 演进出 turn 列后可收紧） |
| Codex（P2） | note 先 slice(200) 后 sanitize，跨界 token 残段可逃过 redact | 属实——本 PR 的共享 reader 使**双宿主同时**暴露该缝隙 | **已修复**：`sanitizeString` 先 redact 完整 note 再自截断（附跨界 sk- token 用例，断言残段不逃逸） |

## 8.1 Owner review 轮（review 5435830966，2026-10-07）

Owner 判定"整体架构方向通过"，仅余一项安全边界细节：`resultPreview.slice(0, 200)` 仍是 sanitize 之前的**早期截断点**（上轮修复只移除了 note 级截断，preview 级预切还在——一个横跨 preview 第 200 字符的凭据会先被切成低于 token 模式阈值的残段）。

**修复（Owner 建议方案 1）**：preview 进入 sanitizer 前**零切片**——组成完整 note，redact → truncate → 输出限长全部由 `sanitizeString` 统一负责（其内部先全量 redact 再自截 200 + `___TRUNCATED___` 标记）。写入侧 `result_preview` 本身有界（≤500），无 DoS 面。

**测试强化**：跨界用例改为 token 真正横跨旧 slice(0,200) 边界（起始 ~字符 191），断言：token 字面量零残留、不匹配 token 模式、**`___REDACTED___` 存在**（redact 发生而非静默丢弃）、note 长度 ≤215（sanitizer 拥有截断权）。该用例在旧顺序下必然失败。
