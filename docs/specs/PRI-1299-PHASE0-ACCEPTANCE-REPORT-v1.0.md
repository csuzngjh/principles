# PRI-1299 Phase 0 Acceptance Report v1.0

**Status：** Phase 0 documentation completed — **PASS_WITH_LIMITATIONS / PENDING_OWNER_DECISION**
**Date：** 2026-11-27
**Branch：** `ai/PRI-1299-phase0-architecture-decisions`
**Latest `origin/main` baseline：** `e3ddf901d0be93b10713beff8165c7008e64d2d6`
**Boundary：** documentation only；未修改 production code、测试、schema、package config、lockfile 或 CI。

---

## 1. 交付物

| 交付物 | 路径 | 状态 |
|---|---|---|
| Architecture Decision Record | `docs/adr/0031-pri-1299-lifecycle-unification.md` | completed |
| SPEC v1.1 | `docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.1.md` | completed |
| Subagent investigation summary | `docs/specs/PRI-1299-PHASE0-SUBAGENT-INVESTIGATION-SUMMARY-v1.0.md` | completed |
| Phase 0 acceptance report | `docs/specs/PRI-1299-PHASE0-ACCEPTANCE-REPORT-v1.0.md` | completed |
| SPEC v1.0 | `docs/specs/PRI-1299-ROOT-CAUSE-ANALYSIS-LIFECYCLE-UNIFICATION-SPEC-v1.0.md` | preserved unchanged |
| Architecture documentation index | `docs/architecture/README.md` | added ADR-0031 index row |

`docs/architecture/README.md` 含有 ADR 查阅表，因此已登记 ADR-0031；未改动其他历史 ADR 缺口。

---

## 2. A. PR #2805 合并后已经解决的问题

| 问题 | 状态 | 限制 |
|---|---|---|
| ordinary successor lookup/conflict/malformed adjudication | RESOLVED | scoped to ordinary successor authority |
| RuleHost ordinary successor 与 orchestrator 创建职责不一致 | RESOLVED | ordinary only |
| adversarial ordinary successor 绕过统一 authority | RESOLVED | ordinary only |
| orchestrator 内 successor create + parent-edge backfill | RESOLVED | scoped；不覆盖 standalone multi-edge generic backfill |
| preview/confirm implementation fork | RESOLVED | 并发漂移仍需测试，但不再是 implementation fork |
| repair lineage validation/backfill 复制实现 | RESOLVED | shared helper 已 uplift；creation authority 未解决 |
| TaskStore 自身 CRUD/CAS write capture | RESOLVED | 仅 TaskStore scoped；不是 connection-level authority |

关键 merge audit：`aaccb6b4^{tree}` 与 `e3ddf901^{tree}` 完全相同，因此 v1.0 production evidence 没有因 merge 失效。

---

## 3. B. 仍然存在的原始根因

| PRC | 当前状态 | 摘要 |
|---|---|---|
| PRC-1 identity contract incomplete | CONFIRMED | repair iteration/source identity仍未进入统一 logical contract |
| PRC-2 creation authority not converged | CONFIRMED | repair host/pd-cli direct seeders仍未统一 |
| PRC-3 multi-stage persistence recovery contract | CONFIRMED | correctness依赖分布式evidence protocol |
| PRC-4 transaction ownership vs connection ownership | CONFIRMED | write admission仍非connection/database-level |
| PRC-5 implicit downstream invalidation | CONFIRMED（精确表述） | evaluator局部防线强，但缺跨模块统一evidence-validity contract |

---

## 4. C. 六项架构决策及证据

| 决策 | 状态 | 核心证据 |
|---|---|---|
| D1 Logical Identity Contract | PENDING_OWNER_DECISION | `successor-lookup.ts:1-25`、`repair-task-identity.ts:50-140`、`pitask-metadata.ts:155-157`、`sqlite-connection.ts:306-325` |
| D2 Repair Round Policy | PENDING_OWNER_DECISION | `pitask-metadata.ts:947-1002`、`evaluator-runner.ts:2770-2783` |
| D3 Task Identity Classes | PENDING_OWNER_DECISION | SPEC v1.1 §5 的 14类创建入口与直接源码调用链 |
| D4 Memory Store Contract | PENDING_OWNER_DECISION | `memory-task-store.ts:67-190`、`sqlite-task-store.ts:63-113` |
| D5 Transaction Architecture | PENDING_OWNER_DECISION | TaskStore scoped FIFO/ALS、raw connection escape hatch、direct writer inventory、better-sqlite3 13.0.3 capture probe |
| D6 Owner Stale Resolution | PENDING_OWNER_DECISION | `owner-resolution-service.ts:323-445`、`evaluator-runner.ts:1006-1059,2155-2166` |

重要细化：channel 被保留在书面 `RepairSuccessorIdentity` 中，但不是独立 uniqueness degree of freedom；它是 mandatory consistency dimension。channel mismatch 必须 fail closed，不得产生第二行 repair。

---

## 5. D. 仍需 Owner 确认的决策

| ID | Owner decision | 推荐 |
|---|---|---|
| OD-1 | 批准 logical identity contract（含 channel clarification） | approve |
| OD-2 | 保留当前两轮自动 repair 作为近期产品治理策略 | approve；不写成永久 identity invariant |
| OD-3 | 批准五类 task identity classes | approve |
| OD-4 | 批准 Memory store = Non-Transactional Test Double | approve |
| OD-5 | 批准 Phase 4 独立 transaction architecture | approve |
| OD-6 | 批准 Phase 3 关闭 Owner submission-time exact-input gap | approve |
| OD-7 | 批准启动 Phase 1 | only after OD-1/OD-3/OD-8 |
| OD-8 | 显式确认 synchronous RuleHost dual-role repair 兼容语义 | recommend preserve + explicit contract |

Owner 尚未批准任何一项；文档没有伪造批准状态。

---

## 6. E. Phase 1 是否具备实施条件

**CONDITIONALLY READY。**

技术调查和边界冻结已经足够支持 Phase 1 设计/实施，但必须等待 Owner 批准 OD-1、OD-3、OD-7、OD-8，并显式确认 repair-aware lookup / synchronous dual-role semantics。未批准前不应修改生产代码。

---

## 7. F. Phase 1 具体预计修改文件

允许目标区域：

- `packages/principles-core/src/runtime/internalization/successor-lookup.ts`
- `packages/principles-core/src/runtime/internalization/successor-create.ts` 或相邻新增 repair creation module
- `packages/principles-core/src/runtime/internalization/repair-task-identity.ts`
- `packages/principles-core/src/runtime/internalization/repair-lineage-backfill.ts`（限 authority 集成）
- `packages/host-runtime/src/internalization-consumer-governance.ts`
- `packages/pd-cli/src/services/rulehost-pipeline-runner.ts`
- 必要 type definitions / runner seed outcome adapter
- 对应测试文件

是否新增独立 `repair-create` module 应在 Phase 1 实施设计时按 deep-module/minimal-change原则决定；Phase 0 不预支文件级实现细节。

---

## 8. G. Phase 1 禁止修改边界

- schema/migrations；
- SQLite connection/store transaction architecture；
- run/artifact/approval/candidate stores；
- owner-resolution service；
- broad evaluator/artificer runner refactoring；
- repair round policy expansion beyond two rounds；
- channel topology/product routing；
- activation/approval product semantics；
- CI/package/lockfile，除非 Phase 1 实施另有明确必要并单独审批。

关键冻结：Phase 4 transaction redesign 不得提前混入 Phase 1。

---

## 9. H. Phase 1 必须增加的测试

最低要求：

1. Repair R1 creation；
2. Repair R2 legal coexistence；
3. same repair duplicate creation → structured reuse；
4. host-runtime / pd-cli concurrent same-repair seeding → winner created / loser adopted；
5. deterministic id/payload mismatch → fail closed；
6. channel mismatch → conflict，不创建第二行；
7. parent/correlation missing deterministic legacy repair → strict proof backfill；
8. arbitrary/malformed repair payload → structured malformed/conflict；
9. terminal valid repair classification；
10. pd-cli `pipelineMode` inheritance parity；
11. repair-aware lookup不得把 R2误判为 R1 duplicate；
12. real SQLite coverage for persistence/atomic claims。

Memory store 可用于非事务业务分支，但不能作为 SQLite correctness evidence。

---

## 10. I. 尚未动态验证的技术风险

| 风险 | 状态 |
|---|---|
| direct-writer capture production matrix | mechanism CONFIRMED；production frequency UNVERIFIED |
| cross-instance FIFO/ALS deadlock | static high risk；dynamic UNVERIFIED |
| true multi-process successor/repair creation | UNVERIFIED |
| rollback failure connection poisoning | high risk；dynamic UNVERIFIED |
| dirty-read semantics | contract gap / UNVERIFIED |
| standalone multi-edge lineage partial completion | contract gap；dynamic extent UNVERIFIED |
| arbitrary UUID legacy repair rows in production | UNVERIFIED |
| full R1/R2 crash/restart lifecycle | test coverage missing |
| final owner approval/activation full PRI lifecycle | only partial activation coverage；needs integration |

---

## 11. 文档质量检查记录

已执行检查：

1. ADR 22个必需章节存在；
2. SPEC v1.1 保留完整1-26章结构，并含 `2.4 Change Log`；
3. v1.0文件未被覆盖；
4. 28个唯一 `docs/`/`packages/` 文件引用存在；
5. 自动检查的行号引用均在目标文件有效行范围内；
6. 关键行号由子代理在当前 main tree逐项复核；
7. 术语已统一：`OrdinarySuccessorIdentity`、`RepairSuccessorIdentity`、`RevisionEpoch`、`RunIdentity`、`ArtifactVersion`、`EvaluatorEvidenceKey`、`RepairCreationAuthority`、`LifecycleTransitionAuthority`、`TransactionOwner`、`WriteAdmission`、`LegacyLineageProof`；
8. 未发现把 PR #2805 错误描述为当前 OPEN 的陈述；唯一“open/work-in-progress”字样是 Change Log 对历史状态的说明；
9. 未发现把 `aaccb6b4` 描述为当前 main 的陈述；
10. `npm run check:docs-structure` 在 Windows shell 下通过；
11. 未发现虚构 Owner approval；所有六项决策均为 `PENDING_OWNER_DECISION`。

限制：仓库未发现专门 Markdown lint/link checker脚本；已运行现有 `check:docs-structure`。行号检查是静态范围检查加人工/子代理抽查，不是语义级 AST 验证。

### 11.1 Error-context routing reconciliation

按仓库要求在 handoff 前运行了：

```text
npm run error:context -- --base e3ddf901d0be93b10713beff8165c7008e64d2d6
```

结果：EP-05 HIGH，EP-02/EP-03/EP-14 MEDIUM，EP-01/EP-04/EP-06/EP-07/EP-10/EP-12 LOW。

解释与处置：

- 本 diff 是文档-only，不包含生产实现、测试实现、重试逻辑或错误处理逻辑；
- EP-05 HIGH 是由文档中 `attempt/retry/repair/iteration` 等术语触发的语义路由，不代表已存在代码回归；
- SPEC v1.1 已把 EP-05 类风险转化为 Phase 1/3/6 测试要求：R1/R2、乱序 completion、crash recovery、stale intent/resolution、真实 SQLite/multi-process evidence；
- 文档没有宣称这些动态测试已经通过，因此不需要虚构 per-iteration runtime evidence；
- 后续实施 PR 若修改生产代码，必须重新运行 diff-mode error:context，并把当时 HIGH/MEDIUM 命中转化为真实代码验证。

---

## 12. 最终 Phase 0 状态

**PASS_WITH_LIMITATIONS。**

理由：

- 文档交付、merge audit、子代理交叉整合、决策证据和边界冻结完成；
- 没有修改生产/测试代码；
- v1.0历史快照保留；
- 但 Owner 决策未完成，动态并发/故障验证未完成，因此不能给无限制 PASS，也不能宣称 Phase 1 已获授权。

**Phase 1 是否可以启动：CONDITIONALLY YES — 仅在 Owner 批准 OD-1/OD-3/OD-7/OD-8 后。**
