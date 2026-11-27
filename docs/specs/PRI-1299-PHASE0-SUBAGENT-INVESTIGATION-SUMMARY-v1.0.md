# PRI-1299 Phase 0 Subagent Investigation Summary v1.0

**Status：** Evidence integration report — documentation only
**Date：** 2026-11-27
**Baseline：** `origin/main` `e3ddf901d0be93b10713beff8165c7008e64d2d6`
**Related：** ADR-0031、SPEC v1.1
**Boundary：** 四个子代理均为只读调查；没有修改文件、运行写操作或提交代码。

---

## 1. 调查组织

| 子代理 | 范围 | 完成状态 |
|---|---|---|
| Agent A | Current Main & Merge Audit | completed |
| Agent B | Logical Identity & Repair Lifecycle | completed |
| Agent C | SQLite Transaction & Store Architecture | completed |
| Agent D | Lifecycle Recovery & Test Coverage | completed |

主代理额外执行了一项有限动态验证：使用仓库 pinned `better-sqlite3` **13.0.3**、in-memory DB 复现 outer raw transaction 捕获 inner `db.transaction()` 的机制。该 probe 只证明机制，不证明 production frequency。

---

## 2. Agent A — Current Main & Merge Audit

### 核心结论

1. `aaccb6b4^{tree}` 与 `e3ddf901^{tree}` 完全相同：`0145ccc594941ffcdb0d1c80be8c52c914d9d51e`。
2. PR #2805 是 squash merge；`aaccb6b4` 不是 merge commit ancestor，但内容上无差异。
3. PRI-1300/PRI-1301/PRI-1294 Phase 4 docs 已在 `aaccb6b4` baseline 内。
4. v1.0 的 production source line references 没有因 merge 漂移。
5. ordinary successor lookup/create、RuleHost/adversarial ordinary authority、preview/confirm implementation fork、repair lineage/backfill uplift 是 scoped `RESOLVED`。
6. repair creation authority、identity contract、transaction authority、unified evidence-validity contract仍是 `CONFIRMED` gaps。

### 重要状态修正

- `successor-lookup.test.ts` 中“two independent SQLite connections”不是 multi-process 证据，因为同一进程共享 module-global FIFO。
- `pitask-metadata.ts` 的 validation 更精确范围是 `947-1002`。
- v1.0 中两个 `5.3` 小节编号已在 v1.1 修正。

---

## 3. Agent B — Logical Identity & Repair Lifecycle

### 核心结论

1. ordinary logical identity `(parentTaskId, taskKind, channel)` 已在源码中明确。
2. repair identity还必须包含 `repairIteration`，并通过 source evaluator、parent、correlation、channel、deterministic id 与 payload 互证。
3. R1/R2 合法共存已确认，但与 ordinary triple 存在 latent contract conflict。
4. deterministic id 防止同 round 物理 duplicate row，但并发 loser 缺 structured adopt/reuse outcome，可能误报 `seed_failed`。
5. `verifyRepairTaskIdentity()` 在 reuse/completion 中强制执行，但 creation 前没有统一 authority 使用同一 adjudication contract。
6. channel 不是 repair uniqueness 的独立 degree of freedom；它应作为 consistency invariant。
7. `rulehost-pipeline-runner.ts` 中仍存在过期注释：一处说 direct createTask 是 sanctioned path，一处说 repair id fresh UUID per call，与 deterministic implementation矛盾。
8. pd-cli repair seeder 未继承 source evaluator 的 `pipelineMode`，而 host seeder 会继承。

### 主代理整合判断

ADR/SPEC 采用调和后的合同：channel 保留在书面 `RepairSuccessorIdentity` 中，但不是独立 uniqueness degree of freedom；channel mismatch 是 conflict/fail-closed，不是创建第二个 repair row 的理由。

---

## 4. Agent C — SQLite Transaction & Store Architecture

### 核心结论

1. 当前存在三类不协调事务机制：
   - async write transaction + module-global FIFO + per-instance ALS；
   - `db.transaction()` sync transaction；
   - raw `BEGIN IMMEDIATE` + manual COMMIT/ROLLBACK。
2. bare outer BEGIN 会使 inner `db.transaction()` 退化为 savepoint；inner write 看似成功，outer rollback 后消失。
3. global FIFO 是 process-wide/module-level，ALS 是 store-instance-level，粒度不匹配。
4. rollback/close failure 可静默污染连接，缺少 telemetry/degraded state。
5. `BEGIN IMMEDIATE` held across awaits 等于 transaction duration 变成业务 callback duration；当前多数 callback 是 sync microtasks，但这是设计风险。
6. Memory store不是 SQLite faithful double。
7. 缺少 non-participating-store capture matrix、cross-instance、rollback/COMMIT failure、true multi-process测试。

### 主代理补充验证

使用 better-sqlite3 **13.0.3** 的 probe 输出：

```text
{"version":"13.0.3","rowsAfterRollback":[],"inTransaction":false}
```

含义：capture mechanism 在仓库 pinned version 上成立。该结论仍不等价于 production capture frequency 已证明。

---

## 5. Agent D — Lifecycle Recovery & Test Coverage

### 核心结论

1. 状态迁移权威部分收敛：
   - single transition-decision entry；
   - single `commitNextTaskProposal` arbitration；
   - single `revision-reopen.ts` implementation；
   - ordinary successor creation unified；
   - adversarial loop不直接创建 repair transition。
2. repair creation 未统一是最高优先级 lifecycle gap。
3. standalone multi-edge lineage backfill atomicity undefined。
4. Owner submission-time exact-input proof缺失；runner application-time supersede只是fallback。
5. SQLite transaction authority仍只在 TaskStore layer scoped。
6. 最大测试缺口：
   - 两轮 repair full lifecycle；
   - true multi-process concurrency；
   - direct-writer capture；
   - durable boundary crash fault injection；
   - owner submission-time stale race。

### 主代理整合判断

Agent D 的测试场景已映射为 SPEC v1.1 §20.2 的 A-U 矩阵。该矩阵明确每场景的测试类型、数据准备、步骤、预期 DB 状态、是否允许 partial write、错误分类和新增需求。

---

## 6. 跨报告一致性与冲突处理

### 一致结论

- PR #2805 合并后没有引入超出原 baseline 的 production diff。
- ordinary successor spine 已 scoped 收敛。
- repair creation authority 未收敛。
- R1/R2 合法共存必须被身份合同显式支持。
- transaction architecture 必须在 Phase 4 独立设计，不能混入 Phase 1。
- Memory store不能证明 SQLite transaction correctness。
- Owner stale resolution 还有 submission-time exact-input gap。

### 需要架构决策调和的点

| 问题 | 子代理观察 | 最终处理 |
|---|---|---|
| channel 是否应参与 Repair uniqueness | Agent B：不是独立 degree of freedom；用户初始建议是纳入 key | 纳入书面 identity，但定义为 consistency dimension；有效 allocation scope仍是 `(sourceEvaluatorTaskId, repairIteration)` |
| 两轮 repair 是 identity invariant 还是 policy | validator目前 hard limit 2 | 当前保留两轮 policy；不要把2永久写成 identity invariant；R3+需Owner批准 |
| Memory 是否需要 transaction parity | 可做copy-on-write但成本高 | 不构建复杂内存事务引擎；正式定义为 Non-Transactional Test Double |

---

## 7. 证据等级汇总

| 结论 | 等级 |
|---|---|
| merge tree 与调查 baseline tree 相同 | CONFIRMED |
| ordinary successor authority 收敛 | RESOLVED（scoped） |
| repair creation authority缺失 | CONFIRMED |
| R1/R2 identity contract conflict | CONFIRMED（latent contract conflict） |
| capture mechanism | CONFIRMED（mechanism only） |
| direct writer production capture frequency | UNVERIFIED |
| cross-instance FIFO/ALS deadlock | UNVERIFIED |
| true multi-process behavior | UNVERIFIED |
| rollback failure connection poisoning | high risk / UNVERIFIED |
| evaluator exact-input defenses存在 | CONFIRMED |
| unified cross-module evidence validity contract缺失 | CONFIRMED |
| arbitrary UUID legacy repair rows存在 | UNVERIFIED |

---

## 8. 对 ADR/SPEC 的输入映射

| 报告结论 | ADR/SPEC位置 |
|---|---|
| identity/channel/contract | ADR §6、§14 D1；SPEC §9 |
| two-round policy | ADR §14 D2；SPEC §10.6、§25 OD-2 |
| identity classes | ADR §14 D3；SPEC §5 |
| Memory contract | ADR §12/§14 D4；SPEC §12.3 |
| transaction architecture | ADR §11/§14 D5；SPEC §12/§21 Phase 4 |
| owner stale resolution | ADR §14 D6；SPEC §20 L/§21 Phase 3 |
| A-U test matrix | SPEC §20.2 |
| phase boundaries | SPEC §21 |

---

## 9. 限制

1. 子代理没有修改或运行动态生产系统。
2. 主代理只执行有限 in-memory probe；未执行多进程/fault injection。
3. 部分测试覆盖判断依赖静态搜索；不能替代动态覆盖率报告。
4. 本汇总保留调查时点证据；后续 Owner freeze 已将 D1-D6/OD-1..OD-8 记录为 `OWNER_APPROVED`，最终以 ADR-0031 §21 和 SPEC v1.1 §25 为准。
