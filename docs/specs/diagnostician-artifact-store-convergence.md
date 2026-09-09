# SPEC — Diagnostician Artifact Store 收敛（Canonical + 双投影）

- Linear：PRI-678（parent：PRI-667）
- 状态：**设计稿，待 Owner 评审后排期**——本 SPEC 不在 Episode 002 运行期间实施
- 依据：`docs/audit/diagnostician-dual-write-audit-2026-09-09.md`（durable 证据）+
  2026-09-09 源码核对（`origin/main` @ 5071308c8）

## 1. Current topology（真实 writer/reader，file:line 见审计报告摘要表）

```text
DiagRouterRunner.succeedTask (diag-router-runner.ts:296-402)
 ├─ stateManager.updateRunOutput            → runs.output
 ├─ committer.commit（单事务）               → artifacts + commits + principle_candidates
 ├─ artifactStore.upsertArtifact（独立提交） → pi_artifacts
 └─ stateManager.markTaskSucceeded          → tasks
```

- 内容层无第二真相：两侧消费**同一个** `routerContentJson` 字符串（:313 构造一次）。
  审计实证 4/4 可比对任务 byte-identical、0 内容漂移。
- 事务层有两个真相"事件"：legacy 三表提交与 pi upsert 各自原子、相互独立。
- 其他 stage（rootcause/distiller/dreamer/philosopher/scribe/artificer/evaluator/
  rollout_reviewer）只写 pi_artifacts；legacy `artifacts` 的**唯一**生产者是
  diagnostician committer（外加 console e2e seeder）。

## 2. Failure windows（已在 durable 数据证实的排前面）

| # | 窗口 | 后果 | 证据 |
|---|---|---|---|
| W1 | 双写引入**之前**的存量提交（修复前 runtime） | legacy 有行、pi 无行；task succeeded；tier2 永久缺 `diagnostician.raw.evidence` | **已证实 ×2**（pri653-e1 / pri653-r2，审计报告） |
| W2 | 两次写之间进程死亡 | 同 W1 形态但 task 未 succeeded → 重试收敛（换 runId 时 legacy 累积） | 设计推断；0 实例 |
| W3 | pi 写抛错 | `retryOrFail('artifact_commit_failed')` → 新 runId 重试 → legacy 多行/单 pi 行 | 测试覆盖（diag-router-runner.test.ts:280-300）；durable 0 观察 |
| W4 | pi upsert 的 artifact_id 被 replace | 下游 lineage_artifact_ids 里的旧 id 变悬空（CandidateLineage 报 ancestor_pruned） | 设计推断；0 观察 |

## 3. Canonical candidate

**`pi_artifacts`**（PIArtifactStore）为 canonical，其余为投影：

1. 它已是全部 9 个 stage 的共同落点——diagnostician 是唯一例外，收敛即消除例外；
2. evaluator tier2 / lineage / activation 存在性检查这些**决策面**已经读它；
3. legacy `artifacts`+`principle_candidates` 的真实消费者（candidate-intake、
   读模型、CLI）只需要"诊断产物 + 推荐候选"的查询面，不需要它是写入权威。

不选 legacy 侧做 canonical 的理由：它只有 diagnostician 一个生产者，把 9-stage
家族搬进来等于反向扩大改动面。

## 4. Projection model（验证过的适配形态）

```text
Canonical Artifact（pi_artifacts，单点写入）
 ├── intake projection（artifacts + commits + principle_candidates）
 │     写入时机：canonical 提交成功后，同事务或紧随的幂等派生写
 │     读者：CandidateIntakeService / evidence-chain / mainline-snapshot /
 │           pain-chain 读模型 / pd-cli candidate 命令（全部保持只读）
 └── lineage projection = canonical 本体（tier2/CandidateLineage 直接读）
```

该模型与 Owner 评审建议一致，且与仓库现实吻合：intake 面的三个表从未被第二个
生产者写过，天然是派生查询面。

## 5. Migration

1. **写入收敛**：`succeedTask` 改为 canonical 先行（pi upsert），intake 三表由
   同一事务内的派生写生成（或明确两级幂等：canonical `(source_task_id, kind)` +
   派生 `idempotency_key`）。W2 窗口从"intake 有/lineage 无"翻转为"canonical 有/
   intake 无"——intake 缺行可由 canonical 重放派生，不再有不可恢复方向。
2. **存量识别**（谁 authoritative）：
   - `MISSING_PI`（W1 存量，task succeeded）：canonical 侧**回填**——从 legacy
     `artifacts.content_json` 派生 pi 行（artifact_id 按 `pi-art-<task>-<run>` 重建，
     lineage_artifact_ids 按依赖任务的 pi 行解析；解析不到记 `[]` 并标注
     `backfilled: true` 的 validation_status 备注）；
   - `MISSING_LEGACY`（0 观察）：反向派生回填；
   - `CONTENT_DRIFT`（0 观察）：若未来出现，以**最新 run 的 legacy 行**与 pi 行
     比对 created_at/updated_at，新者胜，差异写进审计报告人工裁决——不静默选择。
3. **回填工具**：扩展现有审计脚本为 `--backfill`（默认仍只读；显式旗标才写），
   逐 workspace 输出 backfill 计划 → dry-run → 执行三段式；幂等（重跑零写入）。
4. **failure policy**：回填只增不删（P18 数据保全），任何一行的改写都需要该行
   出现在审计的 drift 清单里。

## 6. Rollback

- 写入收敛以代码回滚即回滚（双写形态仍是当前 main 的可工作状态，两处幂等机制
  均保留）；不引入新 flag——回滚=还原提交，不依赖运行时开关（`mvp-q-3`）；
- 回填是纯增量数据操作，回滚=删除带 `backfilled` 标注的 pi 行（工具提供
  `--undo-backfill`，同样只针对其自己写入的行）。

## 7. Observability（收敛后如何证明不再漂移）

1. **审计脚本常驻**：CI/dev 定期跑 `audit-diagnostician-dual-write.mjs`，期望恒为
   IDENTICAL/NO_ARTIFACTS；exit 语义已定义（PASS/DRIFT_FOUND/AUDIT_UNAVAILABLE）；
2. **写入时断言**：intake 派生写与 canonical 同事务后，跨表不一致只剩进程死亡
   一种来源——W2 翻转后的残余形态（canonical 有/intake 无）由现有
   `internalization-chain-integrity-read-model` 扩一条 diag_router 维度覆盖
   （现仅覆盖 dreamer 的 `missing_dreamer_pi_artifact`，:252-264）；
3. **W4 防回归**：upsert replace artifact_id 的行为加一条 lineage 完整性断言
   （被引用 id 不悬空）或改为 append-only 别名——实施时二选一，需 Owner 拍板。

## 8. 实施前置

- Episode 002 完成并解除实验冻结；
- 本 SPEC 过 Owner 评审（尤其 §5 回填方向与 §7.3 二选一）；
- 实施单独开 PR，不与任何语义变更混装。
