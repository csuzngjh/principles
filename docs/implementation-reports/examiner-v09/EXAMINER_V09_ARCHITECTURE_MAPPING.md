# EXAMINER v0.9 — Architecture & Data Contract Mapping

SPEC-PD-EXAMINER-001 v0.9 逻辑对象 → 仓库真实实现映射（Phase 0 审计结论 + 实施后状态）。

## 1. 数据对象映射（SPEC §10.2 → 实现）

| SPEC 逻辑对象 | 实现载体 | 身份/Hash 绑定 |
|---|---|---|
| Study Manifest | `examiner-studies/<id>/examiner-manifest.json`（schema `examiner-study-manifest.v1`，lib/examiner-study.mjs `buildExaminerStudyManifest`） | `manifestHash`（自剥离 canonical sha256）；含 §4.1 全字段（targetPrinciple{version,contentHash}、五 manifest hash、primaryEndpoint{definitionHash,applicabilityRuleHash}、randomizationSeed、plannedPairs、analysisPlanHash、invalidationPolicyHash、armPayloadHashes） |
| Principle Snapshot (HEPS) | 同目录 `heps-principles.json` + 运行时重建（`buildHostEffectivePrincipleSet`） | `principleSetSnapshotHash` = manifest.principleSetSnapshotHash（漂移=冻结验证失败） |
| RuleCode Policy | `rulecode-baseline.json` + `buildRuleCodePolicy` | `ruleCodeSnapshotHash`（自校验） |
| Runtime Manifest | manifest 内 hostManifestHash/modelManifestHash/runtimeManifestHash | canonical sha256 |
| Challenge Suite | 既有冻结链（suite-manifest/judge-only/actor-visible，`compileSuite/compileCase`） | suiteHash + 逐 case inputHash/goldHash（未改动） |
| Preregistration | `preregistration.json`（challenge-preregistration.v1 + examiner 引用段） | hashes.json preregistrationHash |
| Pair Assignment | `pair-assignment.json`（schema `examiner-pair-assignment.v1`） | `assignmentHash` + 种子可复算校验（`verifyPairAssignment`） |
| Run Evidence | 既有 runner attempt 记录 + ledger（零格式改动） | attempt 原子写 + 事件流 |
| Injection Evidence | `runs/<case>/<arm>/r<rep>/injection-evidence-*.json`（schema `examiner-injection-evidence.v1`） | `chainHash`（canonical sha256，生产者白名单 runner-offline-stub/trusted-host-probe） |
| Adjudication | 既有 Scorer V3（`adjudicateClaimEvidence`）+ 逐 attempt 重放重评分 | graderHash + replay byte-compare |
| Behavior Report | 既有 Report V2 + 可选 `examiner` 区块 | REPORT_READY_V2 事件 + reportSha256 + 字节级修订保护 |

## 2. 六级注入证据 ↔ 生产契约映射

lab 层（本 SPEC，大写）：`CONFIGURED→SELECTED→SUBMITTED→HOST_ACCEPTED→CONTEXT_PRESENT→RUNTIME_LOADED`
生产层（`principles-core/runtime-v2/types/intervention-evidence-contract.ts`，小写）：`prepared→submitted→host_accepted→context_present→runtime_loaded`
映射：CONFIGURED+SELECTED ≈ prepared（规划态）；其余逐级对应。命名差异在 examiner-injection-evidence.mjs 头注释声明；宿主可证上限表 `HOST_MAX_PROVABLE_LEVEL` 与三宿主 evidence-recorder 事实一致。

## 3. 模块依赖图（新增部分加粗）

```text
Console UI (/examiner) ──► api.ts ──► server/index.ts ──► routes/examiner.ts
                                                   └─► routes/examiner-executor.ts ─┐
pd-cli/lab 脚本（run-examiner-v09-acceptance.mjs 等）────────────────────────────────┤
                                                                                     ▼
lib/examiner-study.mjs ──► challenge-freeze.mjs (hashOfCanonical) ─► fixture.mjs
        │──────────────► challenge-compile.mjs（套件编译复用）
        └──────────────► examiner-injection-evidence.mjs（recordCapacityCompetition）
lib/challenge-runner.mjs ──► examiner-injection-evidence.mjs（每单元离线链采集）
                           └► examiner-study.mjs（双模式臂验证 verifyExaminerArmConfigsFrozen）
lib/challenge-statistics.mjs ──► +computeITT / +computeTreatmentFidelity（纯增量）
lib/challenge-behavior-report.mjs ──► examiner-study/injection-evidence/statistics（可选 examiner 区块）
```

零新增数据库；零新增生产 schema；零生产 DAG 扩展。

## 4. Complex Delta

```text
New durable source of truth: NO   （研究侧新增 JSON 契约文件，属既有 lab 冻结资产模式）
New persisted schema/state:   NO   （无 DB 变更；study 目录=既有研究工件形态）
New subsystem/service:        NO   （全部挂接既有 lab 管线）
New public abstraction:       YES  ×3 —— examiner-study.mjs / examiner-injection-evidence.mjs /
                                        runner verifyExaminerArmConfigsFrozen+plan.unitOrder
                                        （各为 v0.9 SPEC 直接要求的契约面；闭式验证+测试钉死）
New runtime feature flag:     NO
New cross-package dependency: NO   （pd-console 经动态 import 消费 dev lab，dev-scope only，
                                     安装态 503 诚实降级——不进入生产依赖图）
New host/platform-specific:   NO
New external/network:         NO
```

## 5. 删除测试（Deletion test）

- 若删除 `examiner-injection-evidence.mjs`：六级证据链、chainHash 防篡改、fidelity 分子全部消失——v0.9 §7 核心能力无替代实现（生产五级契约是声明型元数据，非研究证据链）。保留。
- 若删除 `examiner-study.mjs`：双模式契约/HEPS/RuleCode 策略/预注册/配对随机化/预检全部消失，Console API 与验收脚本无载体。保留。
- Runner/统计/报告均为既有文件内增量函数，无新建平行引擎（SPEC §15 达成）。

## 6. 历史兼容声明

1. 无 examiner-manifest 的研究 → Report V2 输出与 v0.7 **字节一致**（examiner 区块条件展开）。
2. runner 无 `plan.unitOrder` → 确定性三层循环行为不变（41 新测试 + 155 既有 v07 测试 + CEB 冻结验证佐证）。
3. stub attempt 记录形状未变（注入证据为旁路 sidecar）。
4. EXM-MVP-001-v4 经 `rebind-exm-v4-freeze.mjs` 既有程序重绑：仅实现绑定与衍生 hash 移动，executionsHash `97e2d4e7…` 不变量保持，Owner 评审内容 hash 未动。
5. CEB-001/002/003-P（scoring v1，无实现钉）verify OK，零触碰。
