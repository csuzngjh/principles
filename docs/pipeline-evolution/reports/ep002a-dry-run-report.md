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

### Attempt 11（flatkey-ds 真实通道）——修复轮首次收敛 ✅

- **attempt 11 一次通过（succeeded）**：Episode 001 中 18/18 全灭的死锁任务
  （artificer-73ccce2a…，ep001 里 9 attempts + force-recovery×3 耗尽）在
  新代码（v4 prompt 契约：case-id 词汇注释 + 修复指令）+ 正确 provider
  通道下**单次收敛**。
- 产物：v2 规则（6 goldenTraceCases、1 evidenceRefs、消费者白名单
  service/port/installToken + dead-fields 写门）——与 scribe 原则语义一致。
- 因子 B 回喂未触发是**正确行为**：attempt 10 的失败在 adapter 层结构化
  修复（repairAttempts 内循环）而非 runner validator，旧 workspace 数据
  也没有 lastValidatorErrors 键；新失败路径的回喂由 16 契约测试覆盖。

### Evaluator 轮——approved 0.88 + INFRA 归因落地

- evaluator approved 0.88（requiredChanges 空）——语义评审通过修复产物。
- 确定性重放：`__compile__` 哨兵 → `sandbox_infrastructure_failure`（
  layer=runtime）——**INFRA_BLOCKED 归因真实落地**（LLM 生成的 RegExp 行有
  坏引号序列 `new RegExp('[\\"'\''…`，沙箱编译失败）。
- fail-safe 正确：approved + passed:false ⇒ rule 工件未装配（不会把编译
  不过的代码写进 RuleHost 面）。

### Rollout 轮——Owner 决策面首次真实可达 ✅

- rollout_reviewer needs_revision（点名 __compile__ syntax error 必须修复
  并重跑零失配门）——判断准确。
- 修订路由在 CLI run-once 路径未接线（`rollout_revision_routing_not_wired`）
  → 任务进入 **needs_human_review**——**Episode 001 全程不可达的 Owner
  决策面，本轮真实到达**（ep001 approvals=0、NHR 从未产生；本轮 NHR 产生、
  reviewKey/durable facts 就绪，Owner 可裁决 revise_once/accept/reject）。
- rollout 修订路由 CLI 缺口与 PRI-661（同路径 gateDeps 缺失）同属 CLI
  run-once 手动推进面的既有限制，消费循环（auto_consumer）路径不受影响。

## 结论

**EP002-A 达成目标**：

1. PRI-700 死锁任务首次收敛（18/18 → 1/1），激活通路的质量层堵点解除；
2. 归因分类真实落地（INFRA_BLOCKED 由 __compile__ 哨兵确定性产生）；
3. Owner 决策面真实可达（NHR + decision facts）——Episode 002 完整闭环
   （Owner 裁决→激活→行为观察）的入场条件全部就绪；
4. 附带发现两个被实证加重的既有缺口（PRI-677 共享 binding / rollout 修订
   路由 CLI 缺口），均已在对应单留证，未在本 PR 扩面。

**纪律声明**：live 网关与安装版零触碰；lab workspace 为 ep001 一次性副本
（重开的两个 failed 任务是 ep001 自身死锁任务的复跑，非人工制造新状态）；
无 gate 弱化；Owner 决策未被 AI 代投（NHR 留给 Owner）。
