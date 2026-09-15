# PRI-807 Phase 0 — BASELINE（开工基线）

> 由本地 Lead Auditor 在派发 CNB Worker A–F 前锁定。
> 本文件是本轮 current-main Reality Audit 的唯一开工基线；Worker 结论若与本基线冲突，以 Worker 回源的 current-main 证据为准并显式记录。

## 基线 SHA

- **CURRENT_MAIN_SHA**: `cdec05d4bc4252151c7f9f118bdad90f25067594`
  （= PR #1710 merge SHA；main 无更晚提交）
- **#1707 merge SHA**: `d77433fd2b5f12f10fcc5a775aa52dcccff83009`
- **#1710 merge SHA**: `cdec05d4bc4252151c7f9f118bdad90f25067594`
- **审计报告基线 commit（#1707 REPORT 的原始基线）**: `70d824c4`

## 增量窗口事实（Lead Auditor 亲验）

`git diff --name-only d77433fd2..cdec05d4b` 的**代码**改动仅 3 个文件（全部属 PRI-801 安装器范畴）：

- `packages/openclaw-plugin/scripts/lib/transitive-deps.mjs`
- `packages/openclaw-plugin/scripts/sync-plugin.mjs`
- `packages/openclaw-plugin/tests/scripts/transitive-deps.test.ts`

其余差异全部是 `docs/audit/`（#1710 核实文档）。**核心管道代码在 #1707→current main 之间零变化**，因此：

1. #1710 四轮核实的事实对 current main 仍然有效，Worker 不得机械重证已 CONFIRMED 项；
2. Worker 的增量价值在：契约接缝（seam）矩阵、SSOT 权威判定、bypass 搜索、host parity、protection gap —— 而非重做事实核对；
3. CNB 镜像 main 若落后 GitHub main，唯一可能的代码缺口是上述 3 个安装器文件，不触及任何管道契约事实；Worker 仍须记录实际 checkout SHA 并对比（见下）。

## Drift 纪律（每个 Worker 必须执行）

开工第一步 `git rev-parse HEAD`：

- 等于 CURRENT_MAIN_SHA → 报告头部记 `BASELINE: SYNCED`；
- 不等于 → 报告头部加 **Drift Warning** 小节，列出 `git log --oneline <HEAD>..cdec05d4b`（缺的提交）与 `git log --oneline cdec05d4b..<HEAD>`（多的提交），并说明对结论的影响面。结论仅对实际 checkout 的 SHA 负责。

## Carry-forward 发现登记（R-01 ~ R-26）

> 判定词沿用 #1710：CONFIRMED / FIXED / DRIFTED / PARTIAL / NEW / UNVERIFIABLE。
> R-03 已标 FIXED（#1693-r3，afa95651）；R-13 / R-15 因 #1698（285d1c81）重写 rolloutReviewer/通道重构而**待 current-main 复审**。

| ID | 级别 | 一句话事实 | 状态（#1710 时点） |
|---|---|---|---|
| R-01 | P2 | scribe→artificer 血缘命名断链：philosopher 产出 `sourceDreamerArtifactId`，scribe 提示词找 `dreamerArtifactId`；可选无校验，缺省时 `resolveDreamerContext` 静默返回 undefined 且无事件（违反 rc-9） | CONFIRMED |
| R-02 | P2 | artificer OUTPUT FORMAT 示例违反 v2 硬契约（缺 `requiresContextVersion`/case 级 `ruleContext`/`evidenceRefs`），逐字模仿必被拒；"CONTEXT MODE block above" 方位自指错误 | CONFIRMED |
| R-03 | P2 | artificer 双 schema 漂移（typebox 缺 evidenceRefs） | **FIXED**（#1693-r3） |
| R-04 | P1 | Stage C 缓存复用旁路全部校验：历史成功 run 的 outputPayload 仅 `JSON.parse` + `as` 即当诊断结果（违反 rc-1/rc-2） | CONFIRMED |
| R-05 | P2 | empathyObserver 死角色但 Owner 面还活着（Console 仍渲染开关，打开零运行时效果） | CONFIRMED |
| R-06 | P2 | 渐进披露三层默认关闭 + manifest 层即使打开也因 summary 键碰撞恒回退全量注入 | CONFIRMED |
| R-07 | P2 | 同一诊断任务两条入口对 retry 预算语义相反（`onPainDetected` 把 attemptCount 清零 vs worker "预算神圣"） | CONFIRMED |
| R-08 | P2 | DiagRouterRunner 漏传 `effectiveConfig` → Stage C rate-limit 降级路径永不生效 | CONFIRMED |
| R-09 | P2 | `progressive_evaluator` 判据字段不在 evaluator 输出 schema/prompt 中 → 恒走双倍 LLM 调用 | CONFIRMED |
| R-10 | P2 | correctionObserver FP 判定依赖恒为空串的 `userMessage` | CONFIRMED |
| R-11 | P2 | EP-07 不变量清单不含 `abstractedPrinciple`：入库的是 router 转述版而非 distiller 蒸馏原件 | CONFIRMED |
| R-12 | P2 | PendingTermStore 无生产写入者、Console 端点全 stub（"LLM 学词→Owner 批准"断链） | 记录 |
| R-13 | P2 | rolloutReviewer `needs_revision` 无 requiredChanges 硬约束；自报 confidence 参与 decideAutoPromotion | **待复审**（#1698 重写） |
| R-14 | P2 | route→ready 判定双实现：自动路径 `ready=!!channel` 短路 missingFields 检查；kind→channel 映射两份 | 记录 |
| R-15 | P3 | diagnostician 产 implementation 候选固定路由到未启用 skill 通道 → 必然 not_internalizable | **待复审**（#1698 通道重构） |
| R-16 | P3 | dreamer 候选数量口径三处不一（prompt/validator/文档注释） | 记录 |
| R-17 | P3 | 诊断超时元数据与实际死线脱节（600s vs 300s） | 记录 |
| R-18 | P3 | rootcause prompt 承诺 "evidence 空则 confidence<0.3" 无任何执行面 | 记录 |
| **R-19** | **P1** | **RuleCode 沙箱信任边界**：静态禁门可被字符串拼接绕过；core 侧两条 vm 预处理路径把宿主 realm input/helpers 注入 vm，`input.constructor.constructor` 可取宿主 `process`/fs/env。生产 live gate 走子进程不受影响；受影响面为评估/激活预检路径 | **CONFIRMED（本轮最重要 carry-forward）** |
| R-20 | P2 | Console「停用」路径 `POST /activations/:id/disable` 不要求 Owner 身份、不写 activation_decisions、不检查 control state | NEW（D轮） |
| R-21 | P2 | correctionObserver 结构性失明三连：hitCount 恒 0、`CorrectionCueLearner.match()` 无调用者、llm 词升 high 后不可逆 | NEW（D轮） |
| R-22 | P2 | Codex 侧无 `rulehost_evaluated` 事件通道 → shadow 证据恒不可得、promote 结构性不可达 | NEW（D轮） |
| R-23 | P2 | `tasks.attempt_count` 与 `runs.attempt_number` revision 窗口双源不一致 | NEW（C轮） |
| R-24 | P2 | `pi_artifacts(source_task_id, artifact_kind)` 唯一索引 = 覆盖语义（第二语义过载持久化键） | NEW（C轮） |
| R-25 | P2 | 管道入口/gate 全景遗漏：Codex 会话摄取未入清单；两个 flag 未入 F10 表 | NEW（A轮） |
| R-26 | P2 | 「第二条 live 写者 / skill 通道无 writer」 | NEW（D轮） |

## Current Phase 0 scope

1. **Worker A — Topology / Channel DAG**：当前拓扑权威、边权威矩阵、bypass 搜索、`CHANNEL_EDGES` 是否真 SSOT → `TOPOLOGY.md`
2. **Worker B — Prompt / Schema / Validator Contract**：11 个内置 agent 的 Contract Matrix、机械核对五类断缝 → `PROMPT_SCHEMA_VALIDATOR_MATRIX.md`
3. **Worker C — Lineage / Artifact Identity**：Pain→runtime receipt 全链身份传递、silent drop 搜索 → `LINEAGE_CHAIN.md`
4. **Worker D — State / Writer Authority**：9 类核心事实的 writer 权威矩阵、second writer 搜索 → `WRITER_AUTHORITY_MATRIX.md`
5. **Worker E — Host Parity / Runtime Evidence**：OpenClaw/Codex 能力矩阵（SUPPORTED/PARTIAL/UNSUPPORTED/UNVERIFIABLE）→ `HOST_CAPABILITY_MATRIX.md`
6. **Worker F — Tests / Protection Gaps**：按 invariant 的保护矩阵、Top 10 管道瘫痪风险缺口 → `PROTECTION_GAP_MATRIX.md`
7. （可选）**Worker G — Red Team**：A–F 完成后攻击其结论 → `RED_TEAM.md`
8. 本地 Lead Auditor 收敛 → `SYNTHESIS.md`（回答 8 问 + Phase 1/2 建议）

## Explicitly out of scope

- 修任何 bug / 改任何 `packages/**` 代码 / 改 schema / 建 PR 修代码；
- 为 R-19 提出修复方案（另立工单；本轮只要 current-main fact / affected path / security boundary / 可复用 hardened 实现 / 回归覆盖）；
- 重做 #1707 全仓扫描或 #1710 四轮复核（已 CONFIRMED 且 main 未变的不重证）；
- 新建治理框架 / scanner 框架 / 第二 SSOT；
- Worker 直接改 Linear / 自行建 issue；
- 把 audit snapshot 升级为 runtime SSOT。
