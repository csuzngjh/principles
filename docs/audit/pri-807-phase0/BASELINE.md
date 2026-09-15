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


---

# Final-main Delta Sync（Lead Auditor 于合并前执行，2026-09-15）

## 两个 SHA 的语义必须区分

- **WORKER_BASELINE_SHA** = `cdec05d4bc4252151c7f9f118bdad90f25067594`
  - A-F 六个 Worker 与 RED_TEAM 全部**实际运行于**该 immutable SHA。
  - 所有 Worker 报告的原始证据、行号、`BASELINE: SYNCED` 标记继续**只对该 SHA 负责**——它们是历史事实，不是对 final-main 的声明。
- **FINAL_MAIN_SHA** = `28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee`（本次同步时 `origin/main` 实际 SHA）
  - Lead Auditor 在合并前又执行了 `WORKER_BASELINE_SHA..FINAL_MAIN_SHA` 的 targeted delta audit（本节）。

> 本节职责：证明并记录 WORKER_BASELINE → FINAL_MAIN 的变化是否影响 Phase 0 结论。未受影响的 Worker 结论**不重写、不伪造重新执行**。

## Delta 清单（WORKER_BASELINE_SHA..FINAL_MAIN_SHA）

`git log --oneline cdec05d4b..origin/main`：

```
28e1de74 Merge pull request #1709 from csuzngjh/ai/PRI-797-signal-collector-default-on
04c00dea Merge branch 'main' into ai/PRI-797-signal-collector-default-on
fd3b6e98 fix(flags): align signal_collector governance trio per owner review (PRI-797)
6670d4fc PRI-797: signalCollector defaults on — semantic detection stops failing silently
```

`git diff --stat cdec05d4b..origin/main`：8 个文件，+196/-22。唯一实质代码提交 = PRI-797（PR #1709，2026-09-15 Owner 指令）。

## 最小 Delta 表

| Commit / PR | Changed seam | Affected report | Worker 时点结论 | Final-main 结论 | Action |
|---|---|---|---|---|---|
| PRI-797 / PR #1709（6670d4fc + fd3b6e98） | S5 Signal Ingestion（`signal_collector` flag + `SignalCollectorHost` + installer 默认 config + lifecycle） | TOPOLOGY.md（R-25 / F10 邻近行）、HOST_CAPABILITY_MATRIX.md（矩阵 #1） | `signal_collector` quiet / **默认 OFF**；LLM 深判 gate 默认关闭 | `signal_collector` quiet / **默认 ON**（Owner 2026-09-15 指令）；未配置 profile 时**显性 WARN + needs_setup** 降级为 keyword-only，绝不静默；Owner 可 config override 关闭 | 已修订两文件该行结论为 Final-main 状态 |
| PRI-797（同上） | S6 Tests / Protection（`feature-flag-contract.test.ts` +2 条、`signal-classifier-needs-setup.test.ts` 新增 119 行、`j12-fresh-install-defaults.test.ts` 改写） | PROTECTION_GAP_MATRIX.md | 未对 signal ingestion 面下过具体保护断言 | 新增 default-on contract、needs_setup WARN、installer 默认三组回归 | 不推翻任何现有 Gap 行；在 PROTECTION_GAP 记录为「PRI-797 新增保护面」（见该文件 Final-main 节） |
| — | S1 拓扑 / S2 prompt-schema / S3 lineage / S4 writer / S5 RuleCode host parity / R-19 沙箱 / NEW-E1 pins | 上述之外的报告 | 不变 | 不变（delta 未触碰任何相关实现文件） | 无修改 |

## Delta 对发现级结论的影响

- **R-25 的语句修订**：「两个 flag 未入 F10 表」的**事实**（两个 flag 仍不在 F10 表）不变；但 `signal_collector` 的**默认值**已由 `enabled:false` 翻为 `enabled:true`（PRI-797）。TOPOLOGY.md 对应行已同步为 Final-main 事实；**判断词维持 CONFIRMED**（遗漏登记类结论不受默认值翻转影响）。`codex_conversation_ingestion` 仍为 quiet / **默认 OFF**，与 `signal_collector` 是两个独立 flag，不得混写。
- **HOST_CAPABILITY_MATRIX 矩阵 #1（signal ingestion）**：OpenClaw 侧从「LLM 深判默认 OFF」修订为「默认 ON；未配置端点 → keyword-only 降级 + 可见 WARN/needs_setup」；PARTIAL 判定维持（降级本身是 designed degradation，不构成能力升级为 SUPPORTED）。
- **R-19 / NEW-E1 / R-01 / R-20**：delta 未修改任何相关实现文件（`production-gate-deps.ts`、`refiner-sandbox-wrapper.ts`、`demo-rule-compiler.ts`、`rule-code-validator.ts`、`rule-implementation-runtime.ts`、`runtime-version.json`）→ **全部保持原裁决（UNCHANGED）**。
- **SYNTHESIS / RED_TEAM**：各自新增 Final-main Delta 章节，见对应文件。

## 时间语义原则（本同步遵循）

```
Worker 证据 @ WORKER_BASELINE_SHA: 保留原样（file:line / BASELINE: SYNCED 不动）
Final-main 变化 @ FINAL_MAIN_SHA : 用 delta 章节 / final 裁决覆盖（显式标记）
```

本文件上部所有 `CURRENT_MAIN_SHA = cdec05d4…` 表述为 Worker 开工时点事实，保留原义；本节为合并时点对账，两者在时间轴上不冲突。