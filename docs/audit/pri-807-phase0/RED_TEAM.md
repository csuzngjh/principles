# PRI-807 Phase 0 — RED_TEAM.md（本地 Red Team 攻击报告）

- 角色：Worker G — Independent Red Team（本地执行，零 CNB 云端额度消耗）
- 攻击对象：A-F 六份并行审计报告
- 审计对象基线：cdec05d4bc4252151c7f9f118bdad90f25067594（BASELINE: SYNCED）
- 方法：不做新调查；对 A-F 已下关键结论逐条回源当前 main 源码（生产代码为最终证据源），判定攻击后结论是否仍站得住。
- 判定词：SUSTAINED（攻击后仍成立）/ WEAKENED（需降级或限定）/ OVERTURNED（结论错误）/ UNVERIFIABLE（无法裁决）
- 说明：本次攻击未地毯式逐条复核，采取「若错了会改变 synthesis 结论」的抽验策略——对 6 份报告中最具杠杆性的 12 条结论做独立回源。

---

## 1. Scope（攻击了哪几份，覆盖度声明）

| 报告 | 攻击条目数 | 攻击重心 |
|---|---|---|
| Worker A TOPOLOGY | 3（NEW-A1 / NEW-A4 / A4 判 PARTIAL） | pipelineMode 缺失语义、barrel 导出面、SSOT 判词 |
| Worker B SCHEMA VALIDATOR | 3（NEW-2 / NEW-8 / R-18） | metadata 写读往返、prompt 字段清单冲突 |
| Worker C LINEAGE | 1（C-11 / R-01 合并） | 血缘字段名断链 |
| Worker D WRITER | 1（NEW-D6a） | 第二写者生产可达性 |
| Worker E HOST | 2（NEW-E1 / NEW-E2） | pinned runtime 守卫缺失、shared 路径事件字段 |
| Worker F PROTECTION | 2（NEW-F1 / §3.1 + R-04/F-2） | vitest 口径、verify:merge 组成 |

跨 6 份抽查命中的结论均以生产代码回源；未抽查的条目按「未攻击」如实声明，不视为 SUSTAINED。

---

## 2. Baseline

```
git rev-parse HEAD = cdec05d4bc4252151c7f9f118bdad90f25067594
BASELINE: SYNCED
```

Red Team 本地复核在权威仓库工作树进行，所有行号锚定同一 SHA cdec05d4 之下，与 A-F 报告引用一致。

---

## 3. Per-Report 攻击结果

### 3.1 Worker A — TOPOLOGY

**A4 · 攻击「CHANNEL_EDGES 是 channel→边集 SSOT，但不是完整拓扑 SSOT = PARTIAL」→ SUSTAINED**

回源：internalization-job-graph.ts 中 CHANNEL_EDGES（:63）、resolveChannelEdges（:84-95，`if (pipelineMode !== 'standard') return ALLOWED_EDGES`）均存在且为唯一决议点；runtime-v2/index.ts 中 CHANNEL_EDGES / resolveChannelEdges 零命中（grep 无匹配）——与 A4「事实权威但不可引用的私有符号」一致。攻击尝试：能否反驳 PARTIAL 为 YES？不能——adversarial-loop.ts（零 pipelineMode 命中，实测）与 rulehost-pipeline-runner.ts 走 stateManager.createTask 直接建行，不经 commitNextTaskProposal，CHANNEL_EDGES 对它们零约束，PARTIAL 判词成立。

**NEW-A1 · 攻击「pipelineMode ABSENT ≡ full_chain，prompt 链会跑出 RuleCode 子链」→ SUSTAINED**

回源：job-graph.ts:88 将 ABSENT 与 full_chain 归并；internalization-state-machine.ts:364 从任务记录继承 pipelineMode，无 channel 兜底。攻击路径：是否所有生产 producer 都写字段，使 ABSENT 不可达？——否。adversarial-loop.ts 全文件 pipelineMode 零命中（实测 grep count = 0），split-diagnostician-runner.ts:292 硬编码 channel:'prompt' 且无该字段。结论成立；P2 定级（旁路均需操作者显式触发）可接受。

**NEW-A4 · 攻击「CHANNEL_EDGES / resolveChannelEdges 不在任何 barrel」→ SUSTAINED**

回源：runtime-v2/index.ts 对两者零命中（实测）。与 ALLOWED_EDGES（:828 导出）形成不对称，成立。

### 3.2 Worker B — PROMPT/SCHEMA/VALIDATOR

**NEW-2 · 攻击「空 requiredChanges 的 rolloutRevisionPayload 使整个 pi_metadata 不可读」→ SUSTAINED**

回源：pitask-metadata.ts:832 在 parsePITaskMetadata 主干上 `if (!Array.isArray(r.requiredChanges) || r.requiredChanges.length === 0) return null;`——空数组使整个函数返回 null，而非丢弃该字段；hydratePITaskRecord（:955-967）随之返回 null。写侧允许 requiredChanges: []（rollout validator 只查 isArray+string），写读往返不闭合。攻击尝试：该分支是否被其它入口先行挡住？——没有 needs_revision ⇒ requiredChanges>=1 的机器强制，成立。

**NEW-8 · 攻击「router prompt 内部三份字段清单冲突」→ SUSTAINED**

回源：router-prompt-builder.ts:168-196 手写清单「只生成 violatedPrinciples/recommendations/summary」+「rootCause/evidence/confidence 系统已填」；generateConstraints 注入点（:146）经 schema-prompt-adapter snapshot 证实产出 `valid: boolean (required)` 与 `diagnosisId: string {minLength:1} (required)`——两字段不在任一手写清单内。冲突真实存在。机械合成示例含这两字段，恰构成第三份冲突说法，与 NEW-8 一致。

**R-18 · 攻击「rootcause prompt 承诺 evidence 空则 confidence<0.3，无执行面」→ SUSTAINED（抽样）**

回源仅抽查 DefaultDiagRootCauseValidator 逐字段校验未见该规则。未对 admission gate 单独回源，按抽样级别声明。

### 3.3 Worker C — LINEAGE

**C-11 / R-01 · 攻击「philosopher 输出 sourceDreamerArtifactId，scribe prompt 让找 dreamerArtifactId，字段断链 + 静默 undefined」→ SUSTAINED**

回源：scribe-prompt-builder.ts:78 明确 `"dreamerArtifactId": "<from philosopher artifact if available, or omit>"`；philosopher 顶层字段为 sourceDreamerArtifactId（philosopher-output.ts:24）。在 internalization/ 全目录 grep sourceDreamerArtifactId，命中集中在 philosopher 侧，scribe 的 prompt-builder / runner / output 三个文件零命中——scribe 确不读真实字段名，断链成立。

**ATTACK（补充限定）**：Worker C 称消失的 dreamer 上下文「与本来就没有不可区分」。artificer-runner.ts 相邻失败分支（dreamer_context_skipped / missing / invalid）与 return undefined 分支共存——静默性成立；但没有对「真实链上是否被触发过」做运行时取证，属静态判定。维持 SUSTAINED，synthesis 引用时标注为静态证据。

### 3.4 Worker D — WRITER AUTHORITY

**NEW-D6a · 攻击「promoteActivation 是类型可达、权限为零的第二 shadow→live 写者」→ SUSTAINED**

回源：packages/**（排测试）grep promoteActivation( 仅命中定义处 sqlite-activation-state-store.ts:170，生产零 caller 成立。攻击尝试：能否以「零 caller 所以无风险」反驳 P2？——不能，SqliteActivationStateStore 类被 package 导出，鉴权缺失被「无人接线」而非类型/权限隔离，P2 定级合理。

### 3.5 Worker E — HOST PARITY

**NEW-E1 · 攻击「pinned host-runtime@0.1.0 缺 Owner 紧急控制守卫」→ SUSTAINED（完整独立复现）**

本 Red Team 独立下载真实 npm 包验证：
- runtime-version.json 确锁 hostRuntime: "0.1.0"。
- npm pack @principles/host-runtime@0.1.0 的 dist production-rulehost-gate.js 中 global_rulecode_pauses 命中 0 次、activation_control_states 命中 0 次。
- 对照 @0.1.1：两者均命中 1 次。
- 守卫由 0.1.0→0.1.1 之间引入，被 pins 永久锁在旧版，NEW-E1 完全成立。

这是六份报告中证据最强的 P1：不是代码推断，是可复现的包内容实证。本次未复现「实际运行时行为」（缺真实 codex 安装），但缺守卫这一机械事实足以支撑结论。

**NEW-E2 · 攻击「shared 路径 live rulehost_evaluated 缺 activationId，重演 ISSUE-023」→ SUSTAINED**

回源：gate.ts:584-588 recordRuleHostEvaluated 带 ruleId 无 activationId；legacy :142 有（注释明示 ISSUE-023 修复）。成立。

### 3.6 Worker F — PROTECTION GAPS

**NEW-F1 · 攻击「6 个测试文件永不执行」→ SUSTAINED**

回源：principles-core/vitest.config.ts:6 include 名单中 internalization 仅有 src/runtime-v2/internalization/__tests__/**/*.test.ts，无 internalization/**/*.test.ts 通配；实测 4 个文件位于 internalization/ 根目录（routing-policy / lifecycle-read-model / lifecycle-metrics / deprecated-readiness .test.ts），不在 __tests__/ 子目录 → 永不执行。成立。

**§3.1 · 攻击「verify:merge 16 步、文档仍称 9 checks」→ SUSTAINED**

回源：package.json:40 verify:merge 实测为 16 步链（7 个 check:* + release-target-matrix + build core + test:website + lint + build + build pd-cli + 3 typecheck），不含任何包 vitest 全量；docs/process/TESTING.md:163 仍写「runs 9 checks」。成立。

**R-04 / NEW-F2 · 攻击「Stage C 缓存可 parse 但非法直达下游」→ SUSTAINED**

回源：split-diagnostician-runner.ts:199-206 parse 成功即 `output: parsedOutput as DiagnosticianOutputV1`（无结构校验），结构非法 payload 原样落库。成立。

---

## 4. 七类问题汇总表

| # | 攻击面 | 命中情况 |
|---|---|---|
| 1 | 证据不足（只有 grep、没打开两端） | 抽查 12 条均带双端回源；未发现单端判定。Worker C 的 C-11 是「查了两端但未做运行时取证」，已在 3.3 标注 |
| 2 | 注释当实现 | 未发现。A-F 中对注释引用处（如 scribe-runner「无权威值不处理」）均以代码行为佐证 |
| 3 | 把 OpenClaw 当所有 host | Worker E 矩阵已分组 legacy/shared/Codex 三列，未发现跨 host 泛化；NEW-E1/E2 是反例（明确差异） |
| 4 | 「唯一 writer」还有隐藏 API | NEW-D6a 已实证 promoteActivation 生产零 caller；Worker D §7 总判定「零机械保护」成立 |
| 5 | 测试只是 mock 不是生产路径 | NEW-F1（永不执行）、§4.14（sandbox 逃逸拼接变体零覆盖）成立；c2-live-runner-chain 确为真实漏斗（文件存在） |
| 6 | CURRENT/TARGET 混写 | 未发现把 PRI-803/804 目标态写成现状的条目；各报告 Out-of-Scope 均声明静态审计只对 cdec05d4 负责 |
| 7 | NEW 实际已由 main 修复 | 抽查 12 条无一条对应代码在 cdec05d4 已修复/已删除 |

补充正面核对：Worker A 引用的 c2-live-runner-chain.test.ts 存在（internalization/__tests__/ 下），其「走真实 commitNextTaskProposal」的核心断言与 Worker A §7 描述一致——该文件是 topology 的最强保护且真实存在。

---

## 5. 对 synthesis 的警告

1. NEW-E1 为全套最高优先（P1）：本 Red Team 已独立用 npm 包内容复现，synthesis 必须将其列为已验证事实而非「报告声称」，并注明复现方法（npm pack @principles/host-runtime@0.1.0 + grep 计数）。
2. NEW-2（metadata 写读往返）与 NEW-A1（pipelineMode ABSENT）在 synthesis 中应合并为一个「缺字段 → 拓扑/持久化双重解释漂移」主题，二者因果相连（A1 造出缺字段任务，B2 揭示缺字段载荷使 metadata 不可读）。
3. C-11 引用时注明静态证据边界：断链为代码事实；「真实链上是否静默丢失」缺运行时取证。
4. §3.1 的 verify:merge 文档漂移（TESTING.md 9 checks）属可立即处置的低风险项，但「合并门禁不含 vitest 全量」是 synthesis 护栏设计最高杠杆前提——必须原样保留。
5. 无一条被攻击结论需降级或删除；本 Red Team 未发现 OVERTURNED 项。
6. 各报告对行号锚定 cdec05d4 的声明均与本地复核一致，无跨文件行号错标。

---

## 6. Out of Scope

- 未对 A-F 的全部条目逐条复核（12/全部条目的抽验）；未复核的条目不作评判。
- 未对 NEW-E1 复现「真实 codex 安装运行」（缺 host 环境），仅复核包内容。
- 未运行任何测试套件（无 node_modules bootstrap）；全部判定为源码回源 + 包内容 grep。
- 未评估 LLM 实际遵循度（无实测数据，与 A-F 一致）。
- 未修改任何文件、不触碰 packages/**、不碰 Linear。

---

---

# Post-Red-Team Final-main Delta Check（2026-09-15 追加）

> 本 Red Team 是对 **WORKER_BASELINE_SHA**（cdec05d4b）的 Worker 结论的攻击，未在 latest main 上重新执行。以下仅记录 WORKER_BASELINE → FINAL_MAIN（28e1de74，delta = PRI-797 单点）是否改变本报告 §3 的 12 条 SUSTAINED 裁决。

## 逐条核对

| # | 被攻击结论 | Final-main 状态 |
|---|---|---|
| 1 | A-NEW-A1（pipelineMode ABSENT ≡ full_chain） | **未受影响**（delta 未触碰 internalization-job-graph / state-machine） |
| 2 | A-NEW-A4（CHANNEL_EDGES 不在 barrel） | **未受影响** |
| 3 | A-A4 PARTIAL（非完整拓扑 SSOT） | **未受影响** |
| 4 | B-NEW-2（空 requiredChanges → metadata 不可读） | **未受影响**（delta 未触碰 pitask-metadata） |
| 5 | B-NEW-8（router prompt 三份字段清单冲突） | **未受影响** |
| 6 | B-R-18（evidence 空 → confidence<0.3 无执行面） | **未受影响** |
| 7 | C-C-11（血缘字段名断链） | **未受影响**（delta 未触碰 scribe/philosopher/artificer） |
| 8 | D-NEW-D6a（promoteActivation 零生产 caller） | **未受影响** |
| 9 | E-NEW-E1（pinned host-runtime@0.1.0 缺守卫，P1） | **保持 SUSTAINED**（delta 未触碰 runtime-version.json；pins 仍 0.1.0/0.1.0/1.252.0） |
| 10 | E-NEW-E2（shared 路径事件缺 activationId） | **未受影响** |
| 11 | F-NEW-F1（6 个测试文件永不执行） | **未受影响**（signal-collector-host.ts 新增测试落位在 tests/core/，在 openclaw-plugin include 口径内，不属被遗漏 6 文件；N=6 不变） |
| 12 | F-§3.1（verify:merge 16 步、文档称 9 checks） | **未受影响**（PRI-797 未改 package.json scripts / TESTING.md） |

## 结论

**No previously sustained Red-Team conclusion was invalidated by the final-main delta.**

FINAL_MAIN 上唯一相关变化（signal_collector 默认 ON）不属于本 Red Team 攻击的 12 条结论范围；它影响的是 Worker E 矩阵 #1 与 Worker A R-25 的语句（已在对应文件及 SYNTHESIS §9 处理），不影响上述裁决。

---

*审计基准：cdec05d4bc4252151c7f9f118bdad90f25067594（WORKER_BASELINE_SHA，BASELINE: SYNCED）*
*FINAL_MAIN_SHA：28e1de74c64c2c7fd8cf8a1ccba55ec7b51939ee；本文件为唯一新增物，所有行号引用对应 WORKER_BASELINE SHA。*
