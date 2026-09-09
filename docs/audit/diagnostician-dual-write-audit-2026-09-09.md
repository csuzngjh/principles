# Diagnostician 双投影一致性审计报告（PRI-678）

- 日期：2026-09-09
- 工具：`scripts/dev/audit-diagnostician-dual-write.mjs`（只读；本报告即其首次全量运行的固化）
- 范围：本机全部可识别 durable PD workspace（6 个 pd-labs 实验 workspace + 1 个开发 workspace）
- 结论一句话：**双写内容零漂移（4/4 可比对任务 byte-identical）；真实漂移仅一类——2 个
  修复前时代的 workspace 存在 MISSING_PI（legacy 有行、pi_artifacts 无行），其任务已
  succeeded，若 tier2 evaluator 走到会永久断链。**

## 数字（§34 Section B 口径）

```text
workspaces scanned       7
diagnoses compared       6   (diag_router 任务；开发 workspace 0 条)
identical                 4
missing legacy            0
missing pi                2   ← pri653-e1, pri653-r2
content drift             0
lineage drift             0
uncomparable              0
retry accumulation        0   (artifacts 每 task 单行)
```

## MISSING_PI 两条的归因（证据）

| workspace | task | status | legacy run | 时间（task id 内嵌 epoch） |
|---|---|---|---|---|
| pd-labs/pri653-e1 | `diag_router-diagnosis_manual_1788488518040_7vcuslxs` | succeeded | `..._1` | 2026-09-05 ~06:21Z |
| pd-labs/pri653-r2 | `diag_router-diagnosis_manual_1788550419717_3a5i9yo5` | succeeded | `..._1` | 2026-09-05 ~23:33Z |

双写（pi_artifacts 侧）由 PRI-667 修复（PR #1512，2026-09-05 合入）引入。两个
workspace 的诊断运行于**不含 pi 写的旧 runtime**：`diagnosis_manual_*` 是人工补录/
重放链的命名形态，走的仍是标准 DiagRouterRunner 提交路径（task_kind=diag_router、
run_1、单 legacy 行）。因此这不是现行代码的活缺陷，而是**修复前存量数据的真实漂移**
——PRI-678 假设的 "pre-PRI-667 workspace" 形态首次得到 durable 证实。

对照组：evolution-episode-001 / evolution-episode-002 / evolution-ep002-r2 /
pri653-r2b（修复后 runtime）全部 IDENTICAL——两次写目前序列化**同一个**
`routerContentJson` 字符串（diag-router-runner.ts:313 构造一次、两处消费），
内容层无独立真相源。

## Writer / Reader Map（摘要，完整版见收敛 SPEC）

| 侧 | writer | 事务边界 | 幂等键 | reader |
|---|---|---|---|---|
| legacy | `SqliteDiagnosticianCommitter.commit`（diag-router-runner.ts:313-331） | 单事务写 artifacts+commits+principle_candidates | `commits.idempotency_key = ${taskId}:${runId}` / `run_id` UNIQUE | candidate-intake（CandidateIntakeService）、evidence-chain / mainline-snapshot / pain-chain 读模型、pd-cli candidate 命令 |
| lineage | `SqlitePIArtifactStore.upsertArtifact`（diag-router-runner.ts:333-366） | 独立 autocommit | `(source_task_id, artifact_kind)` UNIQUE upsert（artifact_id 被 replace） | CandidateLineage（tier2）、evaluator stage2 `diagnostician.raw.evidence`、activation/approval 存在性检查 |

失败窗口（代码证据）：
1. **两次写之间崩溃** → legacy 有行、pi 无行、task 未 succeeded（重试收敛；但若
   重试换 runId，legacy 按次累积、pi 只保最新）——本次审计未观察到实例；
2. **pi 写抛错** → `retryOrFail('artifact_commit_failed')`（非 permanent 类）→
   新 runId 重试 → legacy 累积多行（本次 0 观察）；已有测试
   `diag-router-runner.test.ts:280-300` 断言无 in-process split-brain；
3. **跨进程窗口**（上述 1 的持久化形态）= 本审计抓到的 MISSING_PI 存量形态。

## 审计工具语义

- 只读：better-sqlite3 `readonly + fileMustExist`（与 collect-evidence.mjs 同契约）；
- 分类：IDENTICAL / CONTENT_DRIFT / LINEAGE_DRIFT / MISSING_PI / MISSING_LEGACY /
  UNCOMPARABLE / NO_ARTIFACTS（信息性）；
- exit code：`0` PASS · `2` DRIFT_FOUND · `3` AUDIT_UNAVAILABLE（数据库不可读
  **绝不**折算成 0 drift）；
- 输出：JSON→stdout，人类摘要→stderr。

## 复现

```bash
node scripts/dev/audit-diagnostician-dual-write.mjs \
  D:/pd-labs/evolution-ep002-r2 D:/pd-labs/evolution-episode-001 \
  D:/pd-labs/evolution-episode-002 D:/pd-labs/pri653-e1 \
  D:/pd-labs/pri653-r2 D:/pd-labs/pri653-r2b D:/Code/principles
# → exit 2（两条 MISSING_PI，详见上行归因）
```

## 边界与不做的事

- 本审计不改数据、不回填、不建第二状态源；
- Canonical Artifact Store 收敛的**设计与排期**见
  `docs/specs/diagnostician-artifact-store-convergence.md`（需 Owner 评审后才实施）；
  Episode 002 运行期间双写维持原样（实验冻结）。
