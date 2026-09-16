# PRI-807 Phase 0 — SYNTHESIS.md（核心价值管道 Reality Audit 综合）

- 阶段：Phase 0「current-main Reality Audit」
- WORKER_BASELINE_SHA（Worker 实际执行基线）：cdec05d4bc4252151c7f9f118bdad90f25067594（#1710 合并 SHA；A-F 与 RED_TEAM 全部在此 immutable 基线上运行，BASELINE: SYNCED）`n- FINAL_MAIN_SHA（合并前对账基线）：28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee（2026-09-15 同步时 origin/main；WORKER_BASELINE..FINAL_MAIN delta = PRI-797 4 提交，见 §9 Final-main Delta Sync）
- 输入：BASELINE.md + Worker A–F 六份审计报告 + RED_TEAM.md（本地 Red Team，12 条抽验全部 SUSTAINED）
- 产出目的：为核心契约接缝（seam）、SSOT、漂移与测试保护缺口提供单一综合视图，作为后续治理文档与机械护栏（check:pipeline-contract 等）的设计输入。
- 判定合法性声明：所有严重度为各 Worker 定级经 Red Team 抽验后的保留值；NEW-E1 已经独立复现升级为已验证事实。

---

## 1. 核心管道契约接缝（Contract Seams）全景

Phase 0 确认的六条核心接缝，即"改动时必须以单一权威做判断"的位置：

| # | Seam | 权威持有者（当前） | 旁路/重复实现 | 保护强度 |
|---|---|---|---|---|
| S1 | 拓扑（channel → 边集） | `CHANNEL_EDGES` / `resolveChannelEdges`（internalization-job-graph.ts:63,84） | 3 类越权：旁路 producer 硬编码依赖、判定点内嵌 channel 特例（resolveRolloutReviewMode / resolveRolloutRevisionTarget）、未登记的旁路入口（adversarial-loop / rulehost-pipeline-runner / synthetic-baseline） | 中（c2-live-runner-chain 走真实漏斗，但只覆盖 DAG 内） |
| S2 | 失败判定后的迁移（verdict → transition） | `decideInternalizationTransition`（internalization-transition-decision.ts:73） | `enqueue-successors` dry-run 走 `proposeNextTask`（无仲裁）→ 与 confirm 结论系统性相反 | 中（正例多，分叉对照缺失） |
| S3 | 血缘 & artifact 身份 | runner-owned `reconcileLineageEcho` + `pi-art-<taskId>-<runId>` 确定性派生 | scribe→artificer 的 dreamer 血缘字段名断链；`pi_artifacts` 覆盖语义使 instance id 可回收；#### 四命名空间 principleId | 中（强校验链 + 多个未闭环边） |
| S4 | 写者权威（谁有权写某状态） | 各 store 方法（activation_decisions 等 10 项 CONFIRMED） | `tasks.status` 8 条裸 SQL/writer 路径；`promoteActivation` 类型可达零权限；`attempt_count` 11 处硬写 0 双语义 | 低（仓库无任何 writer 唯一性机制） |
| S5 | prompt ↔ schema ↔ validator 五层契约 | OUTPUT_SCHEMA_REGISTRY + 各 stage validator | 示例过不了自身 validator；rollout 空 requiredChanges 使 metadata 不可读；provider JSON Schema 缺 V2 字段 | 低（schema↔schema 有 parity，prompt↔schema 无） |
| S6 | 宿主能力对等（OpenClaw legacy/shared/Codex） | `shouldUseSharedHostRuntime` + `HostAdapter`（仅 Codex 实现） | pinned host-runtime@0.1.0 缺 Owner 守卫（P1）；Codex 无 rulehost/shadow/gate_block/熔断；shared 路径事件缺 activationId | 低（无 host parity 对照测试） |

---

## 2. SSOT 现状裁决

| 事实 | SSOT 状态 | 判定 |
|---|---|---|
| channel → 边集 | `CHANNEL_EDGES` 唯一 | **YES（局部）**：是 channel→边集 SSOT，非完整拓扑 SSOT（A4 = PARTIAL） |
| kind → route | `KIND_ROUTE_MAP`（私有）+ `CANDIDATE_KIND_TO_ROUTE`（导出）两份 | **NO**：内容一致但无编译期联动 |
| route → channel | `ROUTE_CHANNEL_MAP` 唯一 | **YES**（#1698 后收敛） |
| ready 判定 | 三条语义（decideInternalizationRoute / `!!channel` / `!!channel && MVP_ENABLED_CHANNELS.has`） | **NO**：R-14 CONFIRMED，principle 通道语义分裂仍在 |
| 6-runner kind 清单 | ≥7 份字面量 | **NO**（Console 私有 Set + SQL 字面量） |
| 诊断边 | `DIAGNOSTICIAN_EDGES` | **SSOT 但生产不消费**：split-diagnostician-runner 硬编码依赖数组 |
| rollout 修订目标 | `revision-reopen.ts` + `rollout-reviewer-runner.ts` 逐行等价两份 | **NO**（NEW-A7） |
| 审批/激活绑定 | approval/activation 绑 id 不绑内容 | **NO**（reviewed 绑 hash，approved/activated 只绑 id → 三时点粒度不一致） |
| runtime receipt 回链 | `principle_applications.activation_id` 6 写点 5 个不传、零读取者 | **NO**（多数生产路径 receipt 回链 NULL） |
| 测试门禁组成 | 仓库无 branch protection / required checks 声明文件 | **NO**（CI 全绿 ≠ verify:merge 绿 ≠ 测试绿） |

规则：凡判 NO 者，后续 `check:pipeline-contract` guard 必须以该行为目标做「单权威符号」或「写读往返」断言。

---

## 3. 跨 Worker 顶层发现（去噪后的真实问题）

### D1【P1】pinned Codex runtime 缺 Owner 紧急控制 — 唯一已验证 P1
- 来源：Worker E NEW-E1 + Red Team 独立 npm 包复现。
- 事实：`runtime-version.json` 锁 host-runtime@0.1.0；npm 实测 0.1.0 dist 中 `global_rulecode_pauses` / `activation_control_states` 各 0 命中，0.1.1 起各 1。
- 后果：Codex 用户机器上 emergency-pause / safety_isolate 不生效，退役契约规则照常执行。
- 同类结构性成因：pins 无自动化守护（NEW-E7）——`codex-plugin-bundle.test.ts` 把 0.1.0 断言为期望值，锁死漂移。

### D2【P2】缺字段 → 拓扑与持久化的双重解释漂移（NEW-A1 ⊕ NEW-2 合并）
- A1：`pipelineMode` ABSENT 被 `resolveChannelEdges` 按 full_chain 解释 → prompt 链跑出 RuleCode 子链（PRI-720 禁止形态），且无遥测标记。
- B2：空 `requiredChanges` 的 rolloutRevisionPayload 使 `parsePITaskMetadata` 整块返回 null → governance 恢复能力（revisionCount/channel/completionIntent）一并丢失。
- 合并主题：**不可靠的写入 → 读取侧 fail-closed 以整块粒度惩罚**，缺『字段存在性 + 写读往返』的单一校验点。

### D3【P2】模型被教的 ≠ 机器查的（Worker B + F 交叉）
- 示例过不了自身 validator（rootcause/distiller 机械合成示例 → valid:false）。
- router prompt 内三份字段清单互相冲突（valid/diagnosisId 只出现在机器生成 constraints，不在手写清单）。
- provider JSON Schema 缺 V2/Layer2 字段 + `additionalProperties:false` → 模型被 prompt 要求写、被 schema 禁止写。
- R-19 B 面：模型可见禁止清单 22/9 项 vs validator 28 个模式，双向不重合。
- 测试保护：零对拍（无「prompt 教的 == machine 查的」断言）。

### D4【P2】artifact instance id 可回收，但治理绑定只用 id（C F-01/F-04 ⊕ D NEW-D9）
- `UNIQUE(source_task_id, artifact_kind)` + `DO UPDATE SET artifact_id = excluded.artifact_id` → 旧 id 消失。
- approval/activation 绑 id 不绑内容/版本 → 覆盖后旧 approved/activation 行悬空且无失效机制。
- 修复侧仅 `CandidateLineage` PRI-717 rebind 一条路，approval/activation/Console 无等价重绑。

### D5【P2】宿主能力面不对称且无守卫（Worker E + F 交叉）
- Codex 无：rulehost_evaluated 通道（接口层缺失）、shadow 执行、gate_block 记账、安全熔断、assistant_turns 写者。
- OpenClaw shared 缺：live 事件 activationId（ISSUE-023 重演）、shadow 静默跳过（rc-9 违反）。
- 唯一 parity 测试比的是 legacy vs shared，不是 OpenClaw vs Codex；pinned vs source 零守护。

### D6【P2】门禁绿 ≠ 测试绿（Worker F §3.1/§5.1）
- verify:merge 16 步，仅 1 个测试文件 + website 包；不含任何包 vitest 全量。
- 6 个测试文件（49 断言）不在 vitest include 口径，永不执行。
- 仓库无 required-checks 声明可自证；TESTING.md 仍写「9 checks」漂移。

---

## 4. 测试保护缺口（Top 按风险排序，源自 Worker F 经 Red Team 保留）

1. Prompt 示例 ↔ validator 零对拍（P1，NEW-F3）
2. 血缘字段名不匹配 → 静默丢 dreamerContext（P1，NEW-F4，与 D2 关联）
3. Stage C 缓存「可 parse 但非法」直达下游（P1，NEW-F2）
4. 升级「真实旧版 → 新版」零端到端（P1，NEW-F5）
5. verify:merge 不含 vitest 全量 + 无 required-check 自证（P1）
6. J1 端到端（pain→approval→activation→receipt）不存在（P1）
7. R-19 静态门可被字符串/模板拼接绕过（P1，§4.14：`input["con"+"structor"]` 实测逃逸）
8. Console disable 授权不对称且无负例（P2，R-20）
9. Codex rulehost/shadow 面整块缺失且无 guard（P2，R-22）
10. 6 个测试文件永不执行（P2，NEW-F1）

---

## 5. 后续护栏设计输入（check:pipeline-contract 候选不变式，按 Worker 汇总）

- S1 拓扑：INV-T1..T7（Worker A）；单一可引用拓扑符号（T4）。
- S2 迁移：INV-T7（dry-run 与真实漏斗同源）。
- S3 血缘/身份：INV-L1..L8（Worker C）；写读往返（Worker B I-09）。
- S4 写者：I-D1..D12（Worker D）；示例-校验一致性（Worker B I-01）。
- S5 契约：I-01..I-12（Worker B）；prompt↔schema↔validator 单向一致。
- S6 宿主：INV-E1..E8（Worker E）；pins 能力面守护（E2）。
- 测试门禁：I-2（vitest include 覆盖）、I-6（verify:merge 对齐）。

最小高价值集（Worker F 建议）：I-1示例-over-validator / I-2 include 覆盖 / I-3 跨段血缘字段名 / I-7 拼接变体负例。

---

## 6. 基线漂移登记

- 全部 7 份报告（A–F + RED_TEAM）锚定 cdec05d4，BASELINE: SYNCED，无 drift warning。
- 历史审计 #1707 基线 70d824c4 是 cdec05d4 的祖先（79 commits 窗口）；窗口内变更文件已由各 Worker 重新判定，未继承历史结论。
- 历史 REPORT.md 的条目在本轮中回升的 DRIFTED：validateEdge 无 channel 特例（实为 channel-aware）、F7 6-runner 常量 3-4 处（实 ≥7 处）、TESTING.md 9 checks（实 16 步）。
- 未归并的差异：`docs/process/TESTING.md` 与 `docs/adr/0018` 的 verify:merge 步数描述 vs package.json 实际。

---

## 7. 严重度汇总

| 严重度 | 条目 | 归属 |
|---|---|---|
| P1（已验证） | NEW-E1 pinned runtime 缺 Owner 守卫 | E |
| P1（候选，审计登记） | NEW-F2/F3/F4/F5/J1/R-19 拼接逃逸/verify:merge 组成 | F |
| P2 | NEW-A1/A2/A3/A5/A6/A7、NEW-1/2/3/4/5/8、C-11/F-01..F-04/R-01/R-24、NEW-D1..D7/R-19/R-20/R-23/R-26、NEW-E2..E5、NEW-F1/F6/F7/F8 | A–F |
| P3 | NEW-A4/A8、NEW-6/7/9、F-05..F-07、NEW-D8/D9、NEW-E6..E8 | A–F |

Red Team 结论：无一条被攻击结论需降级或删除；无 OVERTURNED。

---

## 8. Out of Scope（后续 Phase）

- 修复方案 / guard 实现 / 架构选型：一律未做，选项交 Owner（章程 D9）。
- 未做运行时动态复现（除 RED_TEAM 对 NEW-E1 的 npm 包内容复现）。
- 未评估 LLM 实际遵循度；未评估非 production host（Claude Code 等均为 ADR 规划，无实现）。
- Worker G 云端执行失败（npc go error，原因未取日志），已在本地完成等价 Red Team 工作。

---

## 9. Final-main Delta Sync（合并前对账，2026-09-15 追加）

### 9.1 对账范围

- **WORKER_BASELINE_SHA** = `cdec05d4bc4252151c7f9f118bdad90f25067594`（A-F + RED_TEAM 实际执行基线，历史证据绑定此 SHA，不改写）
- **FINAL_MAIN_SHA** = `28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee`（本次同步 origin/main 实际 SHA）
- Delta 提交（`git log cdec05d4b..origin/main`）：PRI-797 / PR #1709 共 4 提交（6670d4fc、fd3b6e98、04c00dea、28e1de74），8 文件 +196/-22

### 9.2 对 Phase 0 结论的影响

| Worker 结论 | Final-main 裁决 | 依据 |
|---|---|---|
| R-25「两个 flag 未入 F10 表」 | **维持 CONFIRMED**（语句已修订） | 遗漏登记类结论不受默认值翻转影响；`signal_collector` 默认 OFF→ON（PRI-797）已同步至 TOPOLOGY.md |
| HOST #1「LLM 深判默认 OFF」 | **修订为默认 ON + 显性降级**（PARTIAL 维持） | `feature-flag-contract.ts:195` enabled:true；`signal-collector-host.ts:604-627` 未配置 profile → keyword-only + WARN/needs_setup（每 workspace 一次） |
| Worker F「signal 面无测试保护」 | **新增保护面** | PRI-797 新增 `feature-flag-contract.test.ts` +2 条 / `signal-classifier-needs-setup.test.ts`(119 行) / `j12-fresh-install-defaults.test.ts` 改写——default-on + needs_setup WARN + installer 默认三组回归；不推翻任何现有 Gap 行，也不夸大为完整保护 |
| R-19（沙箱信任边界，P1） | **UNCHANGED（still sustained）** | delta 未触碰 production-gate-deps / refiner-sandbox-wrapper / demo-rule-compiler / rule-code-validator / rule-implementation-runtime |
| NEW-E1（pinned host-runtime@0.1.0 缺守卫，P1） | **UNCHANGED（still sustained）** | delta 未触碰 runtime-version.json，pins 仍为 codexAdapter 0.1.0 / hostRuntime 0.1.0 / core 1.252.0 |
| S1/S2/S3/S4 其余结论 | **UNCHANGED** | delta 单点落在 signal ingestion 面（S5/S6 局部），未触及任何拓扑/契约/血缘/写者实现 |

### 9.3 最终表述

本 Phase 0 结论现在诚实表述为：

```
Immutable Worker Audit（@cdec05d4）
+ Targeted Final-main Delta Audit（@28e1de74，PRI-797 单点）
= Merge-time Current Reality View
```

- 全部 Worker 分报告与 RED_TEAM 继续对 WORKER_BASELINE_SHA 负责。
- 受 delta 影响的两处（TOPOLOGY R-25 语句、HOST #1）与新增保护面（PROTECTION）已在各自文件显式标记 Final-main 状态。
- 两条 P1（R-19 / NEW-E1）与全部其余结论保持成立。
- 未出现新的 blocker。

---

*综合基线：WORKER_BASELINE_SHA cdec05d4bc4252151c7f9f118bdad90f25067594（Worker 执行基线，BASELINE: SYNCED）+ FINAL_MAIN_SHA 28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee（合并前对账基线）*
*本文是 Phase 0 的唯一综合产物；六份分报告与 RED_TEAM.md 为附件。*
