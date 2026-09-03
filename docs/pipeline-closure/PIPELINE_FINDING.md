# PIPELINE_FINDING — PRI-634-C 闭环验证发现

F-1 · **[P0]** 诊断输出未进入 PI artifact store，dreamer 及以下全部阶段上下文饥饿
发现时间：2026-09-03 14:1x (UTC+8)
状态：**已定位根因，已修复（本 worktree），待部署验证**

## Expected

pain → 诊断（diagnostician/rootcause/distiller/router 四段）→ 候选 → dreamer 及后续内化阶段。
dreamer 的 `buildContext` 通过 `artifactStore.listBySourceTaskId(depId)` 读取其依赖
（diag_router 任务）的产物作为 `predecessorOutput` 注入 prompt（`dreamer-runner.ts:163-190`）。
设计注释明确假设："In the production pipeline diag_router is dreamer's only
dependency, so it is always the first succeeded dep"。

## Actual

- `diag-router-runner` 只通过 `SqliteDiagnosticianCommitter` 写 **legacy `artifacts` 表**
  （`diagnostician-committer.ts:140`），从不写 `pi_artifacts`——而其余所有 peer runner
  （rootcause/distiller/dreamer/philosopher/scribe/artificer/evaluator/rollout_reviewer）
  都在自己的 `succeedTask` 里 `artifactStore.upsertArtifact`。
- 内化 runner 的 artifactStore = `stateManager.piArtifactStore`（只读 `pi_artifacts`，
  `internalization-consumer-cycle.ts:450`；pd-cli run-once 同）。
- 因此 `listBySourceTaskId('diag_router-…')` 恒为空 → `predecessorOutput = null` →
  dreamer 收到的 prompt 里前置诊断为 null。

## 症状（两条独立执行路径都复现）

1. **CLI 路径**：`pd runtime internalization run-once`（pain `manual_1788415743052_os4aicut`）→
   dreamer 输出候选："No predecessor output was provided, so no diagnosis context exists…"。
2. **gateway 生产路径**：插件内 auto-consumer（120s 周期）执行另两条链（`7067acd7`、`b95a3a35`）
   → 同样输出 "No predecessor output was provided — the dreamer has no diagnosis to analyze"。
3. **垃圾向下游传播**：philosopher 把"缺依赖"上升为候选原则
   "Dependency completeness before downstream synthesis"——**系统在学习自己的缺陷，
   而不是 Owner 的纠正**。
4. `pd runtime internalization context-trace`（PR B 诊断面）正确报警：
   `pain_to_dreamer: fail — "Dreamer artifact … has no summary envelope"`
   （summary envelope 缺失的根因就是同一缺口：pi store 里根本没有 router 产物）。

## Evidence

- `pi_artifacts` 表：`diag_rootcause`/`diag_distiller` 各有一行（runner 写入），
  **`diag_router` 永远没有**；legacy `artifacts` 表：`diag_router|diagnostician_output` 存在。
- dreamer 产物 content（两条路径，见上）；context-trace JSON 输出。
- 09-01 历史"成功"链（vautfk3l）结构相同（router 无 pi 行）——当天的 dreamer 产物
  疑似从 CORE AXIOMS 泛化"猜"出与 pain 相关的候选（LLM 行为差异掩盖了缺口），
  即该缺口为**长期潜在缺陷**而非新回归；当日更严格/更字面的模型行为使其显性化。

## Root cause

`diag-router-runner.succeedTask` 缺少与其余 8 个 runner 一致的 PI artifact 写入
（router 是链上唯一"只 commit 不 upsert"的 runner）；而 dreamer 的依赖边恰好指向它。

## Fix（本 worktree，最小一致修复）

`diag-router-runner.ts` succeedTask：在 committer commit 之后，用**同一 artifactId、
同一 contentJson**（Layer 0 envelope，与 legacy 产物字节一致，Requirement 11.5/11.9）
`artifactStore.upsertArtifact` 镜像写入 pi store；lineage 经 `resolveLineageArtifactIds`
解析；写失败 → `artifact_write_failed` 事件 + `retryOrFail`（fail loud，不静默成功）。
同步桥（pain record --session）与 gateway 消费者都经过该 succeedTask，一处修复双路径生效。

回归测试：`diag-router-runner.test.ts` 新增 2 例（镜像可被 dreamer 的
`listBySourceTaskId` 查到且字节一致；镜像写失败时任务不得标记 succeeded）。13/13 绿。

## Severity

P0 —— 直接违反闭环目标：诊断之后的整条内化链在没有 pain 上下文的情况下运转，
产出的"原则"与 Owner 纠正无关。Spec §15 Final Owner Question 在此缺陷下的答案是"不能"。

## Follow-ups（不在本次范围）

- 为什么 09-01 链的 dreamer 在同样 null 上下文下产出了 pain 相关候选（模型行为差异）
  ——建议在 evaluator/admission 加"上下文饥饿"护栏（如 predecessorOutput 为 null 时
  dreamer 产物直接判 invalid，而非让 LLM 自由发挥）。
- context-trace 的 `dreamer_to_scribe` 段在 scribe 未跑时即报 fail（级联噪音，可另行斟酌）。
