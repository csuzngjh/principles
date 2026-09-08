# Evolution Alignment Dry Run — EP002-A（2026-09-07，PRI-703/705/700 交付验证）

> 本记录是 Pipeline Evolution Lab 第四轮受控实验的**代码修复验证段**（EP002-A）：
> 在隔离 workspace 副本上复跑 Episode 001 死锁的修复轮任务，验证本 PR
> （`ai/PRI-703-evolution-alignment`）的 PRI-700 因子 B/C 修复与 Phase 2 归因
> 路由在生产路径上的真实行为。完整 Episode 002（Pain→…→Activation→Behavior）
> 按 Owner 决策顺序在其后执行，本段是其入场条件验证。

## Environment（AC4）

| 项 | 值 |
|---|---|
| PD 代码 | worktree `D:\Code\principles-PRI-703-evolution-alignment` @ `01204db5b`（rebase 到 origin/main `3ec948741`，含 Slice D #1536） |
| 执行面 | worktree 构建（core/plugin bundle/pd-cli）；dev-profile 插件 bundle 已部署为 worktree 构建；**安装版 `~/.pd`、live 网关零触碰**（§1.1） |
| 隔离 | workspace 副本 `D:\pd-labs\evolution-episode-002\ws\main`（从 ep001 一次性复制，state.db WAL 清理后按需重开任务） |
| 模型 | 全 API 端点：artificer=`flatkey-ds`(deepseek-v4-flash, router.flatkey.ai)；链其余=`bai-glm-5.3-flash`(api.b.ai)。无本地模型（ep001 教训：27B 被外部 GPU 实例挤死） |
| 重开的任务 | ep001 两条死链的 failed 修复任务 requeue 为 pending（`artificer-73ccce2a…-prompt` att9→0、`artificer-repair-evaluator-7582b3d6…-r1`） |

## 验证目标（本段）

1. **因子 B（回喂断路修复）**：attempt N 违反 output-contract 后，新代码把
   validator 拒绝全文写入 `diagnosticJson.lastValidatorErrors`；attempt N+1 的
   artificer prompt 携带 `priorValidatorErrors`（Episode 001 的 18/18 同 prompt
   零信息重试形态不再可能）。
2. **因子 C（词汇诱导修复）**：repair prompt 含 ADVERSARIAL CASE VOCABULARY
   NOTE（v2-* case 名 ≠ 指令）+ PRIOR OUTPUT-CONTRACT REJECTIONS 块。
3. **Phase 2（归因路由）**：若重放失败全部为 v2-context case 对 v1 规则，
   修复任务不再死修——`repair_loop_test_out_of_scope` 事件 + NHR
   `evaluator_test_out_of_scope`（decision-capable，Owner 决策面直达）。
4. **降级正确性**：ep001 复制来的 scribe 工件无 intentContract（旧代码产物），
   全链必须 best-effort 降级（`intent_contract_absent_on_principle` 事件可见，
   不阻断）。

## 已完成验证（代码层，先于本 dry run）

- 16 契约测试（evolution-alignment-contract.test.ts）：Intent 一致性 / 归因
  分类 / 回喂 / scribe 契约 / validator 闭合性。
- verify:merge 全绿（runtime-contract 0 新违规、全 typecheck、全测试）。
- Mimosa 完整扫描 202 findings 均为既有基线（0 HIGH/CRITICAL）。

## Run 记录

### Attempt 10（修 lab 路由前）——意外抓到共享 binding 缺陷（加重 PRI-677）

run-once --runner artificer 实际调用 **Bai glm-5.3-flash**（state.db
output_failure_details.evidencePack: provider=Bai），而 config.yaml 配的是
flatkey-ds。根因：`resolveRuntimeFromPdConfig`（pd-cli/src/services/
resolve-runtime-from-pd-config.ts）硬编码读 diagnostician binding；runnerKind
参数在 resolver 里有、从未用于 profile 选择。输出幻觉 `{"service.js":[42,47]}`
→ output_invalid × max attempts。**后果**：ep001 后半程"切换 flatkey"的调参
在 CLI run-once 路径从未生效，18/18 死锁全部跑在 bai 大 payload 高方差通道
——PRI-700 因子 A/B/C 是真实死因，但 provider 层噪声被该缺陷放大。已在
PRI-677（Todo，同根因 timeout 单）留证据评论（§21 规则 9）；EP002 lab 用
config 覆写（diagnostician→flatkey-ds）绕过，不在此 PR 修 resolver。

### Attempt 11（flatkey-ds 真实通道）——一次输出通过结构校验 ✅

> **Round-2 R5 勘误（2026-09-08）**：原结论"修复轮首次收敛/18/18→1/1 收敛"
> 言过其实。可保留的事实只有：**一次输出通过了结构校验**。它不代表
> repair 闭环收敛（产物仍含编译错误）、不代表 provider 稳定（单次单通道
> 观测）、更不代表行为改善。

- **attempt 11 通过结构校验（succeeded）**：Episode 001 中 18/18 全灭的
  死锁任务（artificer-73ccce2a…）在新代码（v4 prompt 契约）+ 正确
  provider 通道下产出了一次结构合法的 v2 规则（6 goldenTraceCases、
  1 evidenceRefs、消费者白名单 service/port/installToken + dead-fields
  写门）。
- **18/18→1/1 的归因限制**：变量不止代码修复一个（provider 同时从 bai
  切到 flatkey），且本轮产物后续死于 `__compile__`（见下），因此该对比
  不能证明因子 B/C 的修复闭环收敛——B/C 的生产有效性由契约测试与
  Round-2 的 R1/R2 生产路径回归（NHR 写失败+重启一致性）背书。
- 因子 B 回喂未触发是**正确行为**：attempt 10 的失败在 adapter 层结构化
  修复（repairAttempts 内循环）而非 runner validator，旧 workspace 数据
  也没有 lastValidatorErrors 键。

### Evaluator 轮——approved 0.88，但归因分类暴露既有缺陷

- evaluator approved 0.88（requiredChanges 空）——语义评审通过修复产物。
- 确定性重放：`__compile__` 哨兵（LLM 生成的 RegExp 行有坏引号序列）→
  **被归因为 `sandbox_infrastructure_failure`（layer=runtime）——这是既有
  归因分类的缺陷（生成代码语法错误 ≠ 基础设施故障），不是本 PR 归因机制
  的正例**。Round-2 R1 已按 Owner 口径修正判据；该哨兵分类问题随
  PRI-705 后续演化收口。
- fail-safe 正确：approved + passed:false ⇒ rule 工件未装配（不会把编译
  不过的代码写进 RuleHost 面）。

### Rollout 轮——到达 NHR 恢复路径，Owner 可裁决能力未达成 ✗

> **Round-2 R5 勘误（2026-09-08）**：原结论"Owner 决策面首次真实可达"错误，
> 已用当前代码对真实 lab DB 只读复核证实。

- rollout_reviewer needs_revision（点名 __compile__ syntax error 必须修复
  并重跑零失配门）——判断准确。
- 任务虽进入 needs_human_review，但 reasonCode 为
  `rollout_revision_routing_not_wired`——**recovery-only**：只读复核显示
  `eligible:false / attention:recovery / allowedActions:[]`。任务进入
  NHR ≠ Owner 拥有 approve/revise/reject 能力。**Episode 002 的 Owner
  裁决→激活→行为观察段尚未完成，决策面可达性未达成**（独立评审复现，
  详见 PR #1551 评审轮报告；CLI 修订路由缺口已立 PRI-708）。
- 修订路由 CLI 缺口与 PRI-661（同路径 gateDeps 缺失）同属 CLI run-once
  手动推进面的既有限制，消费循环（auto_consumer）路径不受影响。

## 结论（Round-2 R5 勘误后）

**EP002-A 的实际达成**：

1. 死锁修复任务产出了一次结构合法的规则输出（此前 18/18 连结构校验都
   不过）——但闭环收敛未证明（产物含编译错误；provider 变量未分离）；
2. 出界判责机制在本轮后才落地并可验证（R1 oracle 判据 + R2 重启一致性
   的生产路径回归）——本轮实验本身没有触发纯出界场景；
3. ** Episode 002 行为闭环未完成**：Owner 可裁决能力未达成（recovery-only
   NHR）、激活 0、行为观察未开始。可信实验基础的判断链已打牢
   （归因按 oracle 证据、治理处置跨重启一致、行为结论必须带证据），
   完整闭环等 PRI-708 修复后由下一次实验验证；
4. 附带发现两个被实证加重的既有缺口（PRI-677 共享 binding / rollout
   修订路由 CLI 缺口 PRI-708），均已在对应单留证，未在本 PR 扩面。

**纪律声明**：live 网关与安装版零触碰；lab workspace 为 ep001 一次性副本
（重开的两个 failed 任务是 ep001 自身死锁任务的复跑，非人工制造新状态）；
无 gate 弱化；Owner 决策未被 AI 代投（本轮 NHR 为 recovery-only，本来也
不存在 AI 代投的合法通道）。
