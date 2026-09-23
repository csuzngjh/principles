# PD Pain 路径测试资产清单（Pain Path Test Inventory）

> 日期：2026-09-21 · 基线 commit：`e91ad97a` · 性质：**只读调查**，未修改任何测试/源码/fixture/CI
> 上游：Test Archaeology Phase 1（`docs/testing/test-archaeology-report.md`）、PR #1813、PR #1817
> 本文是 Test Diet Phase 2-A 的第一阶段交付物；治理结论见 `docs/testing/pain-path-test-governance-report.md`

---

# 0. 方法与口径

- **关键词**：`pain / diagnos* / principle / activation / approval / owner / adherence / observation / correction / learning / trajectory / signal / evidence / governance / rule / receipt / internaliz`（文件名 + 内容双重命中）。
- **范围**：`principles-core`、`openclaw-plugin`、`pd-console`、`pd-cli`、`host-runtime`（`create-principles-disciple`/`website`/`pd-companion` 的命中均为安装器/UI 外围，不在 Pain 闭环上，已排除）。
- **过程**：7 个并行只读探查代理逐文件提取 `describe/it` 与 `vi.mock` 计数，关键文件全文精读；本人在主会话对关键断言（Gate A 零生产引用、`decideAutoPromotion` 零调用方、CI 不设 `LLM_E2E_ENABLED`、`.skip`/`it.todo` 清单）做了二次核验。
- **Stage 口径**（与生产链路一一对应）：
  `Pain-Ingress → Pain-Gate → Diagnosis → Candidate → Internalization → Approval → Activation → Observation / Correction-Learning`，另设 `Cross-cutting` / `Adjacent`（关键词命中但不在闭环上）。
- **Type 口径**：`unit` / `integration`（真实 SQLite/fs 跨模块）/ `bdd` / `property` / `static-guard`（grep 源码文本）/ `e2e`（真实进程/浏览器/真实 LLM）/ `contract`。

---

# 1. 真实业务闭环（Implementation Truth，Phase 2 还原）

生产代码核验后的当前真实链路（非文档叙事）：

```
宿主行为（OpenClaw hook / Codex observation / CLI 手动 / Owner 修正）
  │  acquire：各 host adapter 只做"采集"，不做解释
  ▼
pain-ingress.ts::evaluatePainIngress        ← 全 host 唯一语义权威（纯函数，SPEC §8）
  │  submit / degrade / refuse / observation_only 四决策；provenance 派生；rc-6 lineage 一致性
  ▼
PainSignalBridge（pain-signal-bridge.ts）
  │  空 evidence 短路（非 Owner 源）；提交诊断任务；重试/续跑语义
  ▼
Diagnostician 三段（router → rootcause → distiller，diagnostician/）
  │  产物写 pain-diagnosis store（store/pain-diagnosis/）+ pi_artifacts
  ▼
candidate-intake / intake-to-internalization bridge（pain→principle）
  │  admission gate（evidence-triage/trigger-controller = Gate B，唯一现役准入门）
  │  candidate → ledger probation 条目
  ▼
Internalization 管线（dreamer → philosopher → scribe → artificer → evaluator → rollout-reviewer）
  │  BasePeerRunner 租约状态机；产物链 lineage；修复环；verdict 仲裁
  ▼
Owner Approval（activation/approval-queue + owner-decision/）
  │  PRI-811 后：任何 rollout 推荐只入队，激活必须 Owner approve + verified approvalId
  ▼
Activation/Promotion（activation-dispatcher → writers → shadow → promote）
  │  prompt 通道注入 / rulecode 沙箱门 + shadow→live 原子晋阶
  ▼
Observation（observer/ + feedback/ + receipts + trajectory 回读）
  ▼
Correction-Learning（signal-collector 关键词/LLM 分级 + correction-observer 服务）
  └─→ 新的 Pain 证据（闭环回到顶部）
```

关键事实（已核验）：

1. **Gate A（plugin `pain-diagnostic-gate.ts`）已被 PRI-454/PRI-763 废弃**，模块头自述"ZERO production importers; only tests import it"，纯逻辑已迁至 core `pain-gate/pain-diagnostic-gate-policy.ts`，现役准入门是 Gate B（`evidence-triage/trigger-controller`）。但其测试仍在跑（见 §5 重复区）。
2. **`decideAutoPromotion` 零生产调用方**：`approval-queue.ts` 导出它，但 `ApprovalQueue` 类自身不调用，dispatcher（PRI-811）也不调用——`approval-queue.test.ts` 保护的是一条死路径。
3. **Pain ingress 单一权威有测试级身份证明**：`host-runtime/tests/pain-evidence-ingress.test.ts` 断言 `expect(evaluatePainIngress).toBe(evaluatePainIngressFromCore)`——廉价而有效。
4. **真实 LLM 全链路测试（4 个 `*-real-llm` 套件）在 CI 从不运行**：`describe.skipIf(!getLlmE2eConfig())`，需要 `LLM_E2E_ENABLED` + API key，全部 `.github/workflows/**` 无一设置。

---

# 2. 总量统计

| 包 | 测试文件总数 | Pain 路径相关（估） | 主要分布 |
|---|---|---|---|
| principles-core | 395 | ≈330 | `runtime-v2/__tests__`(136 文件/≈2,673 用例)、`internalization/__tests__`(74/≈1,149)、`activation/__tests__`(23/≈359)、`store`(28/≈399)、diagnostician/signal-collector/evidence-triage/prompt-builder 等 |
| openclaw-plugin | ~200 | ≈75 | `tests/core`(pain/gate/rulehost/principle-*)、`tests/hooks`(pain/gate/prompt/trajectory)、`tests/integration`、`tests/service`(correction-observer) |
| pd-console | 141 | ≈60 | `tests/integration`(approvals/governance)、`tests/server/routes`、`tests/models`、`tests/ui`、`tests/e2e`(10)、`tests/e2e-owner`、`tests/bdd`、`tests/ai-user` |
| pd-cli | 122 | ≈55 | `tests/commands`(diagnose/pain-*/candidate-*/runtime-*)、`tests/e2e`(cross-package-acceptance) |
| host-runtime | 27 | ≈9 | pain-evidence-ingress、production-pain-evidence、governance-observation/signal-admission、consumer-cycle 系列 |
| **合计** | ~1,045 | **≈520（约 50%）** | 文件名直接含 `pain` 的 51 个文件 ≈773 用例 |

> 阶段分布（按代理逐文件 Stage 标注汇总，近似值）：
> Pain-Ingress ≈40 · Pain-Gate ≈16 · Diagnosis ≈50 · Candidate ≈15 · **Internalization ≈105（最厚）** · Approval ≈35 · Activation ≈60 · Observation/Correction ≈55 · Cross-cutting/Adjacent ≈100

---

# 3. 分包清单

> 每行：文件（相对包根）｜Type｜Stage｜保护行为｜备注。已剔除 Adjacent 中与闭环无关的纯外围文件；`mocks:N` = 模块级 `vi.mock` 数（不含 `vi.fn` 手写替身）。

## 3.1 principles-core · runtime-v2/__tests__（A–L）

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| admission-gate.test.ts | unit | Pain-Gate | 置信/evidence/provenance fail-closed 准入；PRI-345 输入证据硬门；0.49/0.50/0.51 边界 |
| adversarial-loop.test.ts | integration | Internalization | PRI-428 两轮 Artificer↔Evaluator 上限；真实 SQLite SM；无 vi.mock |
| append-event-log-line.test.ts | integration | Pain-Ingress | PRI-750 每日 events_*.jsonl 追加格式 |
| architecture-regression.test.ts | static-guard | Cross-cutting | PRI-212 文件数基线(96)+桶面+边界规则；207KB 巨型守卫 |
| artificer-runner-vslice.test.ts | unit | Internalization | PRI-111/780/541 scribe 依赖门/工件提交序/回显对账；93KB；mock SM |
| attack-e2e-pipeline-smoke.test.ts | integration | Cross-cutting | ATTACK-1..15 畸形 LLM 输出全管线 fail-loud；并发 pain 不重复建任务 |
| bridge-result-shaper.test.ts | unit | Candidate | fresh/existing 路径 failed/degraded/succeeded 语义 |
| build-l2-principle-reader.test.ts | unit | Activation | PRI-431 活跃原则→reader；缺失/畸形 ledger 降级为 []；mocks:4 |
| candidate-audit.test.ts | unit | Candidate | 已消费候选必须有 ledger 条目；mocks:4（SQL 全假） |
| chain-integrity-attack.test.ts | integration | Internalization | PRI-209 缺失/血缘错配/重复工件检测+修复幂等（与 real-path 近重复） |
| chain-integrity-real-path.test.ts | integration | Internalization | 同一断链分类学，真实路径+PRI-225 元数据契约；手写 DDL |
| context-payload-validation.test.ts | contract | Diagnosis | 诊断上下文 payload schema 接受/拒绝 |
| correction-proposal.test.ts | unit | Correction-Learning | PRI-114 proposedParams 子集/可序列化/无原型污染/toolName 不可变 |
| diagnostician-output-schema.test.ts | contract | Diagnosis | PRI-518 recommendations minItem=1、五类 union（真实 TypeBox 校验，零 mock） |
| dreamer-output-validator.test.ts | unit | Internalization | PRI-87 候选边界 0..1/≤5/riskLevel 枚举 |
| dreamer-runner-real-llm.test.ts | e2e | Internalization | 真实 SenseNova 出 Schema 合法 DreamerOutput；env 门控（CI 永不跑） |
| dreamer-runner-vslice.test.ts | unit | Internalization | PRI-85/541 工件先写后 succeeded/幂等/血缘回显 |
| dreamer-runner.test.ts | unit | Internalization | 阶段排序/超时重试/lease_conflict 不变更/output_invalid 终态；含内嵌源码 grep 守卫 |
| dreamer-source-pain-provenance.test.ts | unit | Internalization | PRI-862 种子覆盖伪造 sourcePainId/回填/可观测丢弃 |
| evaluator-repair-loop.test.ts | unit | Internalization | PRI-509/718 修复种子门/迭代≥2→needs_human_review；25 个 vi.fn |
| evaluator-runner-vslice-v2.test.ts | unit | Internalization | PRI-426/427/423/485/490 对抗沙箱重放/规则工件组装/降级 |
| evaluator-runner-vslice.test.ts | unit | Internalization | V1 evaluator（与 v2 并存，64KB，疑似遗留） |
| evidence-chain-contract.test.ts | unit | Cross-cutting | PRI-385 task-id 归一/CJK 去重/状态机；golden dogfood fixtures |
| evidence-chain-host-kind.test.ts | unit | Pain-Ingress | host_kind 透传，unknown 不丢 |
| evidence-chain-intent-tension.test.ts | unit | Diagnosis | PRI-469 intentTension 提取/拒绝 confidence/可见降级 |
| evidence-guards.test.ts | unit | Pain-Gate | isOwnerExplicitManual 严格匹配；空证据短路矩阵（与 admission-gate 部分重叠） |
| evidence-sanitizer.test.ts | unit | Pain-Ingress | UNC/Windows 路径归一、token 脱敏（与 feedback/redact-sensitive 重复） |
| feedback/*.test.ts（5 个） | unit | Adjacent | 反馈报告/隐私预览/脱敏/URL/markdown 渲染 |
| full-chain-real-llm.test.ts | e2e | Internalization | 真实 LLM Dreamer→…→RolloutReviewer 全链+逐步 schema；env 门控（CI 永不跑） |
| full-trace-contract.test.ts | contract | Cross-cutting | FullTracePayloadV2 必填 sourcePainId/sourceTaskId/capturedAt |
| golden-path-diagnostician-e2e.test.ts | integration | Diagnosis | PRI-357 onPainDetected→assemble 真实 SQLite 往返；仅 runner/turn-reader mock（有反向验证注释） |
| golden-trace(-replay-validator).test.ts | unit/contract | Activation | GoldenTrace 正负例必备/false-positive 拦截/修复提示（两文件重叠） |
| governance-experience/projection(-contract)/timestamp | unit/contract | Approval | PRI-550/551/584/798 治理视图派生决策矩阵+fail-closed+UTC 格式 |
| intake-to-internalization-bridge.test.ts | unit | Candidate | PRI-142/355/395/720 candidateId 校验/路由→通道/机械证据降级 |
| internalization-chain-integrity-read-model.test.ts | unit | Internalization | 断链读模型全分类学；mocks:3（SQL 假） |
| internalization-consumer-product-path.test.ts | unit | Internalization | wakeOnce→run→commit 循环；**全 mock 但名字叫 product-path**（命名失真） |
| internalization-contracts.test.ts | contract+static | Internalization | PRI-42 桶面/冻结 helper |
| internalization-failure-persistence.test.ts | integration | Internalization | PRI-384 失败原因真实落 SQLite |
| internalization-integrity-remediation.test.ts | integration | Internalization | 修复 dry-run/confirm/隔离/幂等；48KB 真实 better-sqlite3 |
| internalization-orchestrator.test.ts | unit | Internalization | wakeOnce 租约选择/no_ready_tasks 分类学/PRI-88 提案提交 |
| internalization-peer-runner-contracts.test.ts | unit+contract | Internalization | 枚举/记录有效性/任务图合法边 |
| internalization-queue-read-model.test.ts | unit | Internalization | 快照计数/水合失败主导/抑制不污染计数 |
| internalization-route.test.ts | unit | Candidate | decideInternalizationRoute 纯路由 |
| internalization-state-machine.test.ts | unit | Internalization | 租约/依赖/状态迁移含 P0-D 重开规则 |
| io-deletion / barrel-io-cleanup / ledger-store | static-guard | Cross-cutting | PRI-443 I/O 清理守卫（桶面/常量/零 fs import） |
| l1-hard-cap.test.ts | unit | Activation | 活跃原则 ≤12 上限+确定性驱逐 |
| language-directive.test.ts | unit | Cross-cutting | PRI-336 输出语言指令解析/警告 |
| ledger-codec.test.ts | unit | Cross-cutting | 混合 ledger 解析/序列化/legacy 钳制 |

## 3.2 principles-core · runtime-v2/__tests__（M–Z）+ 小目录

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| mainline-contract.test.ts | unit/contract | Cross-cutting | 主线契约违规（lineage/config/diagnosis/consumption）带 reason+nextAction |
| mainline-product-path.test.ts | integration | Cross-cutting | 真实 SQLite pain→诊断→候选→dreamer 种子→上下文契约 ok；**含 3 个 it.todo（PRI-C 等，注释自述 RED until convergence）** |
| operator-health(-cold-start/-gfi/-gfi-degraded).test.ts | unit/integration | Observation | 冷启动 HEALTHY/GFI 阈值/清理建议仅 degraded（与 canary gate 部分重叠） |
| owner-identity.test.ts | integration | Approval | ADR-0022 env>file 身份、fail-closed 部分环境变量 |
| owner-retry.test.ts | integration | Approval | needs_human_review 重试重置、fail-closed 元数据 |
| pain-chain-read-model.test.ts | unit | Observation | 按 painId 追踪断链/延迟/降级 |
| pain-correction-evidence.test.ts | unit | Correction-Learning | PRI-844 Owner 修正原文 2000 字符上限内逐字保留 |
| pain-diagnosis-persistence.test.ts | integration | Diagnosis | 诊断行按 painId 落库/幂等重放/可观测降级（真实 SM+SQLite） |
| pain-evidence-contract.test.ts | unit | Pain-Ingress | PRI-255/277 provenance 推断/严重度入 diagnosticJson；**钉死 MAX_EVIDENCE_ENTRIES=8 等字面量** |
| pain-flood-simulation.test.ts | unit | Pain-Gate | PRI-208 洪峰汇总纯 helper（nextIssue 返回字面量 "PRI-208"） |
| pain-ingress-persistence.test.ts | integration | Pain-Ingress | painIngress.v1 嵌套+legacy 双写一致；重入篡改拒绝；T1–T7 不变量 |
| pain-ingress-shared-semantics.test.ts | unit | Pain-Ingress | CLI/OpenClaw 共用同一 evaluatePainIngress 权威（Cases A–E） |
| pain-outcome-convergence.test.ts | unit | Candidate | 混合候选决策各自可观测/furthestStage 诚实（PRI-642 §10） |
| pain-signal-bridge-execute-pending.test.ts | unit | Diagnosis | worker 单步推进不重置重试；payload 重入预校验 |
| pain-signal-bridge-result-shaping.test.ts | unit | Candidate | 各 outcome 结果塑形（PRI-456 characterization） |
| pain-signal-bridge-retried.test.ts | unit | Diagnosis | retried 状态返回空候选、不查库 |
| pain-signal-bridge-short-circuit.test.ts | unit | Pain-Gate | 空 evidence+非 Owner 源预 LLM 短路；Owner 路径永不（PRI-345/311） |
| pain-signal-bridge-workspace-dir.test.ts | unit | Pain-Ingress | workspaceDir 传播/null（PRI-349） |
| pain-signal-observability.test.ts | integration | Observation | pain_events upsert/脱敏/host_kind/修正文本；**跨包 DDL 同步唯一守卫（PRI-788 G2）** |
| pain-signal-runtime-factory-edge-cases.test.ts | unit | Diagnosis | 能力缺失/配置拒绝矩阵（与 runtime-config-boundary 近重复） |
| pain-signal-runtime-factory-effectiveconfig-wiring.test.ts | unit | Diagnosis | 三诊断 runner 共享同一 effectiveConfig（PRI-818 R-08）；纯接线 |
| pain-to-principle-service.test.ts | unit | Pain-Ingress | 桥结果→failureCategory 映射/asyncMode durable-first；parity 断言近同义反复 |
| philosopher-runner-real-llm / scribe-runner-real-llm | e2e | Internalization | 真实 LLM schema 合法；env 门控（CI 永不跑） |
| pi-artifact-store.test.ts | integration | Internalization | 工件 CRUD/幂等/血缘/重启存活（Memory+Sqlite 双实现） |
| pitask-metadata.test.ts | unit | Internalization | PI 元数据 fail-closed 解析 |
| pri638-diagnostician-capability-characterization.test.ts | integration | Diagnosis | 诊断器禁用：durable pending、零 provider 调用、重启用恢复（真实工厂+SQLite） |
| pri638-p1d-error-classification.test.ts | unit | Diagnosis | 真实错误不被 capability_disabled 掩盖（D1–D4） |
| principle-compiler-core.test.ts | unit | Activation | 生成规则码过禁用模式/返回字段静态检查 |
| product-telemetry-contract.test.ts | unit/contract | Observation | 日 ID 不可链接/快照严格/密钥永不序列化 |
| production-canary-fixture-gate.test.ts | integration | Cross-cutting | 合成工作区金丝雀健康/降级判定；只读命令零写（与 GFI/retry_wait 部分重叠） |
| proven-channel-baseline.test.ts | contract | Activation | 3 MVP 通道产生可观测激活证据或 fail loud（与 story-a-demo 通道集重复） |
| pruning-mask/-read-model/-review-log | unit/integration | Observation | LWW 修剪掩码/jsonl 审查日志 |
| recovery-actions-log / recovery-sweep-service | integration/unit | Cross-cutting | 恢复动作日志 SPEC §10/租约失败任务清扫 |
| replay-production-parity.test.ts | contract | Activation | 重放输入===生产动作（10 工具 fixture；生成的 code 从不执行——注释自认） |
| rollout-reviewer-runner-vslice / -verdict-paths | unit | Internalization | 评审 verdict 语义/出边 fail-loud |
| rollout-rule-candidate-contract.test.ts | unit | Activation | 伪规则候选拒绝进人审（PRI-634） |
| rule-host-evaluator.test.ts | unit | Activation | block 短路>auto_correct>approvals 合并决策（PRI-114） |
| rulehost-oob-defense-simulation.test.ts | unit | Activation | 越界写（遍历/UNC/自改）全部拒绝（PRI-210） |
| runtime-config-boundary.test.ts | unit | Cross-cutting | validateRuntimeConfig 矩阵（与 factory-edge-cases 近重复） |
| schema-conformance-read-model / schema-float-precision / schema-orphan-detection / schema-version | unit/integration/static | Observation | 缺表缺列报告/REAL 精度(PRI-476)/每表有写路径(P3-12)/版本字面量钉死 |
| sqlite-connection-readonly.test.ts | unit | Cross-cutting | 只读模式零副作用——**却全靠 mock better-sqlite3+fs（名实不符）** |
| stalled-diagnostician-task.test.ts | integration | Diagnosis | 停滞判定 pending+attempt0+无 runs+超阈 |
| status-contract.test.ts | contract | Cross-cutting | PrincipleStatus 5 态/PDTaskStatus 6 态三方一致 |
| story-a-demo.test.ts | unit | Adjacent | Demo 通道/叙事 helper（与 proven-channel-baseline 通道集重复） |
| system-prompt-merge.test.ts | unit | Internalization | 分层合并丢空串/字节级保留（PRI-633） |
| task-state-semantics.test.ts | unit | Cross-cutting | 租约/就绪/retry_wait/终态语义（与 bridge-execute-pending、canary 三处钉同一规则） |
| task-three-strikes.test.ts | unit | Internalization | rejectionCount 单调；≥3 升级不纠正（PRI-141） |
| telemetry-event.test.ts | unit | Observation | runner 遥测事件注册完备 |
| trajectory-schema / trajectory-store | integration/unit | Observation/Correction | 规范 schema==新库（PRI-774）/修正样本列表（db 打开 mock） |
| v2-adversarial-cases.test.ts | unit | Activation | 恰好 5 个对抗 ruleContext 用例稳定（钉数量） |
| workflow-funnel-loader / workspace-leak-guard | integration/unit | Cross-cutting/Adjacent | workflows.yaml 加载/测试基建自检 |
| **diagnostician/**（6 文件） | unit | Diagnosis | router/rootcause/distiller schema+validator（taskId 再注入、ERR-008、BUG-007c）；3 个 prompt-builder 字节级断言 |
| **signal-collector/**（5 文件） | unit | Correction-Learning | 关键词高精度→STRONG 免 LLM/LLM 分级严格解析/payload 三方反漂移 |
| **evidence-triage/**（5 文件） | unit | Pain-Gate | Gate B：triage-policy 决策矩阵/trigger-controller Owner 手动绕过冷却/13 描述符（与 source-descriptors 互重复）/观察→SourceKind 映射 |
| **feedback/**（8 文件） | unit | Adjacent | 草稿合并/指纹/mailto/safe-stringify/typed fields |
| **detection/** detection-funnel-policy | unit | Pain-Ingress | L1 精确>中毒 L2；L3 队列上限+LRU |
| **pain-gate/** pain-diagnostic-gate-policy | unit | Pain-Gate | 源/分数/GFI/重复失败审批矩阵（纯逻辑正主） |
| **observer/** agent-scheduler / correction-observer | unit | Observation/Correction | 注册表分发/修正观察者 prompt+超时 |
| **gfi/** gfi-kernel / gfi-read-model | unit | Pain-Ingress/Observation | 摩擦 apply/decay/乘数上限 D1/活跃会话选择 |
| **risk/** risk-calculator-policy | unit | Activation | 每工具行变更风险估算 |

## 3.3 principles-core · internalization + activation + owner-decision

> 该区域 **零 vi.mock、零 .skip**（全靠 DI 注入内存替身），是闭环上最健康的测试区。

**Internalization（75+4 文件，核心节选）**

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| mvp-core-loop-journeys.test.ts | integration | Approval+Activation | J5–J8：needs_revision 不可绕过；NHR 零副作用；**approve_rollout ⇒ 1 pending approval、0 activations** |
| verdict-drift-regressions.test.ts | integration | Approval | 终态后 LLM verdict 不可漂移（T1–T8b，含激活后迟到 reject） |
| restart-safety.e2e.test.ts | e2e | Approval | 各阶段 worker 重启零重复任务/审批/激活；rollout-approve ⇒ approvals=1, activations=0 |
| owner-override-resume.test.ts | integration | Approval+Activation | Owner accept 高危路径只入队不直接激活（INV-08）；reject 不派发 |
| owner-decision-review.test.ts | unit | Approval | Owner 审查清单；**对抗硬门失败时禁止 accept** |
| owner-decision.test.ts | unit | Approval | ownerResolutions 元数据 fail-closed 往返（PRI-629） |
| owner-decision-architecture.test.ts | static-guard | Approval | 单一 resolver/无第二 owner-decision 存储（源码树行走） |
| evaluator-gate-authority.test.ts | integration | Activation | code-bearing+approved 必过确定性沙箱门；缺 gateDeps fail loud（PRI-634 R1–R4） |
| evaluator-formation-context.test.ts | integration | Approval | 形成证据不匹配 ⇒ needs_human_review，Owner 决定（PRI-843） |
| evaluator-pain-reason-echo.test.ts | integration | Approval | painReasonSummary 钳位回显进规则工件+审批卡（PRI-861） |
| evaluator-artificer-repair-replay.test.ts | integration | Internalization | FAIL→证据→修复→PASS 自愈走**真实重放门**（PRI-634 PR-A） |
| evaluator-chinese-feedback-contract.test.ts | integration | Internalization | 中文反馈过修复环+账本收敛（PRI-714） |
| internalization-transition-decision.test.ts | unit | Internalization | verdict→迁移仲裁；BLOCKED_MISSING_VERDICT fail-closed（P0-D/E） |
| crash-liveness-regressions / a-liveness-reconciliation | integration | Internalization | 崩溃窗口记录优先/跨重启孤儿回收 |
| diag-chain-e2e.test.ts | integration | Internalization | 诊断 A→B→C schema 链+committer；flag 无运行时权威（42 个 vi.fn 脚本化 LLM） |
| diag-{router,rootcause,distiller}-runner.test.ts | unit | Internalization | 三段 runner 生命周期模板（近同构三连）；**validator 被 stub 成恒 valid** |
| dreamer/philosopher/scribe/evaluator/rollout *-prompt-builder*（7 文件） | unit | Internalization | prompt 字段映射/JSON-only 约束（样板断言互抄） |
| rule-activation-contract.test.ts | unit | Activation | evaluator 工件契约与 RuleHostWriter.canActivate **反漂移 parity** |
| rule-code-dialect.test.ts | unit | Activation | 禁用规则方言（export/async/Math.random）（与 production-gate-deps 重叠） |
| refiner-sandbox-wrapper / refiner-rulehost-gate | unit | Activation | 沙箱分类/门决策映射 |
| job-graph / c2-live-runner-chain / philosopher-toggle | unit | Internalization | 拓扑边三处钉（重复族） |
| legacy-rule-contract-scanner | unit | Adjacent | 退役 RuleContext 符号检测 |
| 其余（formation-context、artifact-summary/freshness property、peer-runner-lineage、split-runner-retry、queue-actionability、runnerkind-seam 等约 40 文件） | unit/property | Internalization | 工件摘要/新鲜度性质、血缘注入、拆分重试、队列可行动性等 |

**Activation（23+1 文件）**

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| activation-dispatcher.test.ts | unit+integration | Approval+Activation | **PRI-811 权威：任何 rollout 推荐只入队；无 Owner approve 不产生 activation 行；dispatch 需 verified approvalId**（含字节级重复的两个同体测试） |
| approval-completion-service.test.ts | integration | Approval | pending/rejected 永不激活零变更；**安全边界：假/pending/错配 approvalId 拒绝** |
| approval-queue.test.ts | unit | Approval | decideAutoPromotion 阈值——**保护零生产调用方的死路径** |
| approval-store-extended / edit-then-approve | unit | Approval | 内存审批存储扩展字段/edit 重置 pending（SQLite 无 edit 错误分支覆盖） |
| rulecode-owner-decision-service.test.ts | unit | Activation | Owner 晋阶权威：flag-off/safety-off/break-glass/无备注/readiness blocked 全部拒绝且不 commit |
| sqlite-activation-safety-store.test.ts | integration | Activation | **shadow→live 原子晋阶+证据+决策；陈旧版本/插入失败回滚（触发器注入）** |
| sqlite-approval-store(+fk) / sqlite-activation-state-store(+fk) | integration | Approval/Activation | 入队/审批/拒绝/幂等；FK 校验（后者断言 SQL 文本） |
| memory-activation-state-store / memory-approval-store | unit | Activation/Approval | 内存实现（与 SQLite 版互为双实现） |
| activation-re-dispatch.test.ts | unit | Activation | 停用后可重派发（Bug-Q） |
| low-risk-writers.test.ts | unit | Activation | extractPrincipleId 优先级（与 dispatcher 内 describe 重复） |
| openclaw-promotion-checks / promotion-readiness-evaluator/-reader | integration/unit | Activation | 中立探针+组合失败阻断晋阶；硬检查缺一不可；shadow 不健康不可覆盖 |
| promotion-evidence-snapshot.test.ts | unit | Activation | 摘要绑定激活/评估/血缘/Owner 身份 |
| production-gate-deps.test.ts | unit | Activation | vm 门编译/拒绝/输出形状 |
| story-a-acceptance.test.ts | e2e | 全链 | **PRI-408 生产闭环：pain→approve→activate→observe→rollback；reject/edit/畸形零激活（"unsplippable"）** |
| writers/rule-host-writer.test.ts | unit+integration | Approval+Activation | canActivate 契约；**shadow-first：审批后 writer 也绝不直接返回 live**（gateDeps 多数 stub，2 例真实门） |
| activation-compatibility-read-model（见 §3.1） | integration | Activation | 升级阻断退役读法 |
| owner-decision/owner-decision-view.test.ts | unit | Approval | Owner 视图语义选择器 golden |

## 3.4 principles-core · store/adapter/runner/config 等

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| store/pain/__tests__/sqlite-dead-letter-store.test.ts | integration | Pain-Ingress | 失败 pain→死信行；rc-9 不可序列化封套；重试标记 |
| store/pain-diagnosis/** | — | Diagnosis | **无专属测试目录**（仅被 pain-diagnosis-persistence / flag 注册测试间接覆盖） |
| store/diagnostician-committer.test.ts | integration | Candidate | 工件+commit+候选原子事务；空 recommendations 拒绝；幂等重放；断言内部键格式 `${commitId}:0` |
| store/context/sqlite-context-assembler(+resilient) | integration/unit | Diagnosis | 诊断上下文组装/确定性 contextHash/降级遥测 |
| store/trajectory/{source-trace-locator,sqlite-trajectory-locator} | integration | Observation | 按 sourcePainId/painId/taskId/runId 定位血缘 |
| store/candidate/recommendation-kind-resolver | unit | Candidate | kind 白名单回退 'principle' |
| store/sqlite-task-store(+cas+failed-tasks) / sqlite-run-store | integration | Diagnosis | 任务/run CRUD；PRI-629 CAS 证据内容守卫；失败任务可观测 |
| store/lifecycle/{lease-manager,recovery-sweep,retry-policy,concurrent-lease,idempotent-transitions} | integration | Diagnosis | 租约/回收/退避/幂等迁移（recovery-sweep 与 idempotent-transitions 部分重叠） |
| store/runtime-state-manager.integration(+malformed-run) | integration | Diagnosis | 任务/run 真相对齐/畸形容忍 |
| store/workspace-isolation.test.ts | integration | Cross-cutting | 任务/run/trajectory/history/context 不跨工作区泄漏 |
| store/history/{sqlite,resilient}-history-query | integration/unit | Diagnosis | 历史条目映射/降级 |
| store/schema-conformance.test.ts | integration | Diagnosis | 存储记录过 schema；断言 artifacts 列清单（schema 镜像） |
| store/intent/sqlite-intent-decision-store | integration | Approval | IntentDecision 幂等（painId+docHash+ownerAction）/快照不可变 |
| runner/pain-signal-bridge(-admission).test.ts | unit | Candidate/Pain-Gate | P8/HG-4 门语义（fake SM；与 __tests__ 下真实库版本重叠） |
| runner/base-peer-runner-{agent-draft,failure-details,rate-limit-degradation,trust-boundary} | integration/unit | Diagnosis | 永久失败草稿/验证错误落库/限流降级/不可信 payload 不达后段 |
| runner/diagnose.test.ts | unit | Diagnosis | CLI diagnose 委托/F10-1 悬空 sourceRunId 警告 |
| adapter/principle-tree-ledger-adapter.test.ts | integration | Activation | activatePrinciple 磁盘生效/{ok:false} 不抛 |
| adapter/{chaos-json-repair,structured-output-repair,output-repair-contract,json-extractor} | unit | Diagnosis | LLM JSON 提取/修复混沌用例（PRI-621/707） |
| adapter/schema-prompt-adapter(+semantic) | unit | Diagnosis | 合成示例过生产 validator（PRI-817） |
| adapter/{pi-ai-runtime-adapter,pi-ai-http-transport,pd-stream-simple} | unit | Diagnosis | pi-ai 适配能力/健康/流（vi.mock pi-ai） |
| adapter/openclaw-cli-runtime-adapter*(3) | unit | Diagnosis | CLI 参数构造/systemprompt 折叠（mock cli-process-runner） |
| adapter/{l2-agent-loop,artificer-l2,test-double-runtime-adapter} | unit | Diagnosis | L2 代理捕获/maxTurns/白名单 |
| core-principles/{registry,core-axiom-block,strip-fabricated-ids} | static/unit | Cross-cutting/Candidate | 恰好 T-01..T-10 注册锁/`<core_principles>` 块/剥离伪造 pri-unknown |
| prompt-builder/{correction-cue,empathy-keyword-matching,principle-selection,prompt-builder-core,attitude-directive} | unit | Correction/Pain-Ingress | 修正线索中英检测/共情关键词/P0>P1>P2 注入+4000 字符预算/GFI 态度阈值（core 与 attitude-directive 互重复） |
| principle-tree-ledger.{crud,roundtrip,lock,atomic-write,atomic-write-security,lifecycle} | integration/static | Cross-cutting | 账本 CRUD/防丢写/锁/原子写无残留×2（PRI-459 与 PRI-1179 重复族） |
| ledger-schema-diff.test.ts | static-guard | Cross-cutting | 插件账本=纯 re-export；类型/编解码单源 |
| src/trajectory-store.test.ts / src/evolution-store.test.ts | integration | Correction-Learning | 修正样本审批/演化任务列表——**手工建 schema fixture（漂移风险）+ cwd 相对临时目录** |
| feature-flags/__tests__（12 文件） | unit/static | Cross-cutting | 注册/分类/默认值/生命周期普查（含 pain_diagnosis_persistence 默认 off）；模板高度重复 |
| config/__tests__（14 文件） | unit | Cross-cutting | 配置解析/agent 绑定/PRI-638 cutover 绝不静默激活 LLM |
| tools/__tests__（4） | unit | Adjacent | L2 工具契约 |
| tests/bdd/story-a.steps.ts | bdd | Approval | 唯一可执行 BDD 绑定：owner-approve-prompt.feature（真实 SQLite+生产服务） |
| tests/bdd/__tests__（3） | unit | Cross-cutting | BDD 基建自测 |
| tests/pain-signal.test.ts | unit | Pain-Ingress | PainSignal schema+严重度阈值 40/70/90 |
| tests/candidate-intake.test.ts / tests/runtime-v2/candidate-intake-service.test.ts | unit | Candidate | 输入输出 schema/试用期账本写入幂等（E-02/D-10） |
| src/utils/cli-process-runner.test.ts | unit | Cross-cutting | **describe.skip('Windows command resolution')——在本仓库开发 OS 上跳过** |

## 3.5 openclaw-plugin（≈75 相关文件，节选）

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| tests/integration/pain-id-chain-e2e.test.ts | e2e | Pain→Activation | **包内最佳链覆盖：pain 事件→principle→compile→RuleHost 拦截，真实 SQLite**（源 #338 bug 修复） |
| tests/integration/principle-compiler-e2e / principle-lifecycle.e2e / trajectory-lifecycle.e2e / runtime-v2-trajectory-context.e2e / gate-real-io.e2e | e2e | Activation/Observation/Diagnosis | 编译→晋阶→拦截；三存储一致性(#204)；轨迹不变量；Owner 修正进诊断上下文；真实 EventLog 门写 |
| tests/core/pain.test.ts | unit | Pain-Gate | computePainScore 加法罚分封顶 100——**14 行、1 断言，近空洞** |
| tests/core/pain-diagnostic-gate.test.ts | unit | Pain-Gate | **Gate A 适配器 615 行大测试——被测模块零生产引用（已废弃）** |
| tests/core/pain-score.property.test.ts | property | Pain-Gate | **死文件：describe.skip + fast-check 从未安装（2026-04-15 出生即死）** |
| tests/core/correction-cue-learner.test.ts | unit | Correction-Learning | 关键词学习 TP/FP 记录/原子写（fs 全 mock，原子性=调用序） |
| tests/core/correction-learning-static-guard.test.ts | static-guard | Correction-Learning | 死能力（match/recordHits/hitCount）保持死 |
| tests/core/signal-collector-host(+edge-cases).test.ts | integration | Correction-Learning | detectSync 真实临时库写 user_turns/不双写（1070 行） |
| tests/core/trajectory.test.ts / trajectory-store-round-trip | integration | Observation | 真实轨迹库 bootstrap/blob 溢出/修正样本；写读 parity+fail-loud（PRI-753） |
| tests/core/trajectory-schema-equivalence.test.ts | contract | Cross-cutting | 插件 schema==core 规范 schema；迁移保行（PRI-774） |
| tests/core/principle-compiler(+compiler-replay-gate) | integration/unit | Activation | 真实库编译/重放门失败→降级不注册 |
| tests/core/principle-injection.test.ts | unit | Activation | 注入优先级/预算/P0 保证 |
| tests/core/principle-application-ledger.test.ts | unit | Observation | alignActivationIds 配对/自报对照注入集（PRI-755） |
| tests/core/principle-receipt-metadata.test.ts | unit | Observation | 回执元数据回退链（真实 sqlite fixture） |
| tests/core/principle-lifecycle-service 等 principle-internalization/(4) | unit | Internalization | 单服务 metrics+路由/稀疏证据=0/仅行为重放 |
| tests/core/rule-host-*(10 文件) | unit/integration | Activation | SQLite RuleHost 恰好一次/对抗输出/自动纠正 VM/缓存失效/5×5 矩阵/资源界限/legacy 契约 |
| tests/core/rulecode-safety-circuit / rulecode-replay-live-parity | integration/contract | Activation | 活规则隔离 fail-open/重放==生产决策 parity（PRI-809） |
| tests/core/j10-rule-governance-states.test.ts | e2e | Approval→Activation | SHADOW→LIVE→DEACTIVATE 状态+activationId 血缘 |
| tests/commands/pain.test.ts | unit | Pain-Ingress | /pain 报告格式/GFI 状态（PainToPrincipleService mock） |
| tests/hooks/pain.test.ts | unit | Pain-Ingress | 工具失败分类/准入（重复/危险）/手动 pain/PEAT triage；**43 处 mock 引用** |
| tests/hooks/pain-funnel-ingress / pain-continuation / pain-dead-letter / pain-emission-characterization | unit | Pain-Ingress | PRI-642 逐 emitter 证据诚实/延迟续跑排空/死信 rc-9/emitter 调用形状安全网 |
| tests/hooks/single-gate-pain-admission / trigger-cooldown-tracker / triage-adapter / raw-observation-adapter | unit | Pain-Gate/Pain-Ingress | 准入范围/共享冷却 Map/resolveSourceKind（**三文件重复测同一函数**） |
| tests/hooks/gate-*(13 文件) | unit/e2e | Activation | auto-correct 决策/PROFILE 韧性/轨迹落库/回执/v2 路由/性能预算/真实管线 |
| tests/hooks/runtime-v2-prompt-activation.test.ts | integration | Activation | Owner 批准→prompt 注入；停用回滚；flag 无法关闭（1121 行，17 commits 活跃维护） |
| tests/hooks/runtime-v2-prompt-triple-proof.test.ts | e2e | Activation | 三重证明+重启恢复（PRI-519） |
| tests/hooks/runtime-v2-activations-injected-pairing | integration | Activation | 预算截断配对事件索引对齐（PRI-537） |
| tests/bdd/{principle-application-ledger,receipt-self-report,pd-context-receipt,principle-receipt-block-copy}.steps.test | bdd | Observation | 真实门+真实回执行（RuleHost/event-log mock） |
| tests/integration/auto-entry-gate.test.ts | unit（误置） | Pain-Gate | 与 hooks/pain 同场景副本（全 mock，TC1–TC4） |
| tests/integration/pain-pipeline-roundtrip.test.ts | static-guard | Pain-Ingress | 名为 roundtrip 实为 hook 源码 grep |
| tests/integration/runtime-v2-pain-guard / gate-b-only-runtime-guard | static-guard | Pain-Ingress/Gate | 无 .pain_flag 写者/V2 运行时 hook 不调 Gate A（PRI-651-B1） |
| tests/service/correction-observer-{service,batch-confirm,registry} | unit/contract | Correction-Learning | 独立服务生命周期/FP-only 投递/10 会话窗/批量确认终态/注册表一致（PRI-293/788/812/823） |
| tests/service/earned-high-demotion-roundtrip.test.ts | integration | Correction-Learning | TP 晋升/FP 降级真实存储文件往返（PRI-812） |
| tests/service/auto-consumer-governance-wiring.test.ts | integration | Approval | 评估工件→审批队列而非直接激活（PRI-811 接线） |
| tests/{internalization-auto-consumer-gate, internalization-auto-consumer-service, service/internalization-auto-consumer-service} | unit | Internalization | **同名文件两处+flag 逻辑三处重复** |
| tests/host-runtime-pain-readiness / templates/pd-pain-skill-contract | contract | Pain-Ingress | 共享 pain 就绪边界/技能模板契约 |

## 3.6 pd-console / pd-cli / host-runtime（≈120 相关文件，节选）

**pd-console**

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| tests/integration/governance-approve-activation.test.ts | integration | Approval→Activation | approve 写激活/重复 approve 409/账本 candidate→active（真实 http+SQLite） |
| tests/integration/approvals-api.test.ts | integration | Approval | proven-channel 限制/过滤器拒绝（1520 行最大审批套件） |
| tests/integration/approvals-nextaction.test.ts | integration | Approval | activation_failed→nextAction/回滚→pending/重批不 409（PRI-438） |
| tests/integration/evidence-chain-cross-source.test.ts | integration | Cross-cutting | canonical_pain_id 串起 pain→task→candidate→principle 全血缘 |
| tests/server/routes/owner-decision-routes.test.ts | integration | Approval | 决策视图 T1/T2/T5/T15；flag-off 403 且零文件创建；GET 后账本+state.db 字节不变 |
| tests/server/routes/{principles-governance,governance-experience,owner-decisions,intent-decisions,activations-*} | integration/unit/contract | Approval/Activation | flag 先于读短路/降级不 500/决策列表/幂等重放/CLI↔Console 字段 parity |
| tests/models/{evidence-chain-console-model,governance-*,activations-*,principle-id-resolution}.test.ts | unit | Approval/Activation/Observation | 数值 pain id 联接/治理态派生/降级/候选↔账本 id 解析（evidence-chain 2215 行真实 better-sqlite3） |
| tests/models/activations-shadow-telemetry.test.ts | unit | Observation | 双目录 shadow 遥测合并去重——**与 pd-cli 同名近拷贝** |
| tests/ui/{pain-card-logic,pain-evidence-validators,approval-edit-action,owner-decision-*,activation-page}.test.ts | unit | Pain/Approval/Activation UI | 卡片三层可读性/编辑拒绝原因/信封校验/i18n |
| tests/ui/principle-review.test.ts | static-guard | Adjacent | "文件存在且非空/调用 fetchApprovalsGrouped"——源码扫描型 |
| tests/e2e/focus-approve-flow.spec.ts | e2e | Approval→Activation | 队列加载→API 批准→pending 减少+激活出现；FocusPage 无 5xx（含已修复的静默通过 bug，注释在案） |
| tests/e2e/{focus-governance-clicks,governance-experience,pain-intent-flow,principle-detail-flow,rule-host-writer-golden-trace,rulecode-owner-live-decision}.spec.ts | e2e | Approval/Activation/Pain | 深链/快照服务/种子 pain 渲染/详情 API/审批失败回滚 pending/break-glass 紧急停用 |
| tests/e2e-owner/rulecode-owner-governance.spec.ts | e2e | Activation | **认证 Owner 晋阶/拒绝精确 shadow 激活——仅 `npm run test:e2e:owner` 手动跑，不在默认 e2e** |
| tests/bdd/rulecode-owner-live-decision.steps.test.ts | bdd | Activation | 17 个 Gherkin 场景保持可执行（源码串扫描型断言） |
| tests/ai-user/*（5 文件） | unit/e2e | Cross-cutting | PRI-754 AI 用户 QA：场景 schema/同源导航/LLM baseUrl 安全/零决策才算基建失败（需 OPENAI_API_KEY，不在 CI） |

**pd-cli**

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| tests/e2e/cross-package-acceptance.test.ts | integration | **全链** | pain→管线→自动入队→edit→approve→activate→observe→promote→live 拦截→deactivate→恢复；无 approvalId 拒绝派发（**pain 直接种子注入、LLM=ScriptedAdapter、晋阶走底层 stateStore.promoteActivation**） |
| tests/commands/diagnose.test.ts | unit | Diagnosis | --runtime 路由/flag 冲突/JSON 错误契约——**34 处 vi.mock 含整个 runtime-v2 桶** |
| tests/commands/pain-record(-async/-session-parser).test.ts | unit/integration | Pain-Ingress | 校验/JSON 输出/异步等待/--host codex 血缘必填（session-parser 用真实 Commander+trajectory.db；pain-record mock 了 fs+recordPain） |
| tests/commands/pain-list / pain-retry / pain-evidence / runtime-pain-flood-simulation | unit | Pain-Ingress/Diagnosis/Gate | host 过滤不猜测/重试拒绝不变更/TRIGGER_DECISION 解析/洪峰句柄 |
| tests/commands/candidate-{intake,internalize,lineage,backfill,route,show,audit-repair}.test.ts | unit | Candidate/Internalization | 摄入幂等/dreamer 种子/血缘 fail-loud（PRI-435）/路由/绕过准入防（PRI-442） |
| tests/commands/runtime-internalization-{queue,run-once,retry-owner-authority,integrity,enqueue-successors,wake-once}(12) | unit/integration | Internalization | 队列可见性/test-double 拒绝/--confirm 原子权威重置/后继幂等（run-once 23 mock 含整个 host-runtime） |
| tests/commands/runtime-activation.test.ts | unit | Activation | dispatch flag 接线/高危拒绝/dry-run——**17 mock，审批存储全假：该层"无审批激活"回归不可见** |
| tests/commands/runtime-activation-{approve,promote,dispatch,deactivate,list}-flag-wiring(5) | unit | Activation | Commander 选项注册断言（实现细节） |
| tests/commands/runtime-activation-governance-audit / -shadow-telemetry / nextaction | unit | Activation/Observation | 审计先于变更落盘（PRI-566）/双目录遥测（与 console 重复）/nextAction 活态省 --confirm（bug #1367） |
| tests/e2e/candidate-intake-e2e / tests/services/rulehost-pipeline-e2e | integration | Candidate/Diagnosis | 真实 CLI 摄入→账本→幂等/生产接线 code_rule_capability |

**host-runtime**

| Test | Type | Stage | Protected Behavior |
|---|---|---|---|
| tests/pain-evidence-ingress.test.ts | contract | Pain-Gate | SPEC §8.2 全矩阵+Codex 血缘不完整拒绝+**单权威身份断言 toBe(core fn)** |
| tests/production-pain-evidence.test.ts | integration | Pain-Ingress | 生产 after-tool 内核：血缘工具失败+准入 pain/冷却驱逐/并发去重/回滚/无 bootstrap |
| tests/governance-observation-store.test.ts | integration | Observation | 幂等摄取/直播+转录收敛/冲突检查点停止/32 轮有界保留 |
| tests/governance-signal-admission.test.ts | integration | Correction-Learning | STRONG 修正高精度/限流桶/canonical pain 恰好一次/学习关键词 TP≥3/0FP |
| tests/governance-quarantine / internalization-consumer-cycle-{language,evaluator-telemetry,per-agent-profile} / evaluator-gate-wiring-guard / rule-implementation-runtime | unit/integration/static | Correction/Internalization/Activation | 隔离零变更/输出语言达 adapter/逐工作区遥测隔离/门注入点唯一/vm 沙箱边界 |

---

# 4. Fixture 清单（Pain 路径）

| 路径 | 类型 | 引用方 | 分类 |
|---|---|---|---|
| core `internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.ts` | 真实 LLM 缓存输出（Qwen3.6-27b router/rootcause/distiller） | 6+ 诊断 runner 测试 + test-double adapter | **canonical（回归级）** |
| core `internalization/__tests__/__fixtures__/intent-tension-cases.ts` | PRI-468 十例 A/B 评估数据 | 3 文件 9 引用 | canonical |
| core `internalization/golden-dogfood-fixtures.ts` | dogfood 管线状态数据集（PRI-385） | evidence-chain-contract + **公共桶导出（fixture-as-API）** | canonical（导出面待审视） |
| core `__tests__/fixtures/{core-barrel-surface,runtime-v2-barrel-surface}.json` | 冻结公共导出面 | architecture-regression 等 | canonical（回归） |
| core `__tests__/fixtures/llm-e2e-config.ts` | LLM E2E env 门 | 4 个 real-llm 套件（16 引用）；含 @deprecated getMiniMaxConfig 别名 | canonical |
| plugin `tests/hooks/__fixtures__/prompt-*.txt`（3） | golden prompt 快照 | prompt-golden（UPDATE_GOLDEN 自再生） | canonical |
| plugin `tests/fixtures/legacy-queue-v1.json` | 旧版 evolution 队列捕获 | **零引用 → 死 fixture** | **dead** |
| plugin `tests/fixtures/production-mock-generator.ts` + `production-compatibility.test.ts` | 从 ~/.openclaw 生产数据生成 | 仅互相引用；skipIf 无生产数据即跳过 | **semi-dead** |
| codex-adapter `tests/fixtures/g1-contract/` | 冻结 hook payload 契约捕获 | g1 契约测试（防手改） | canonical |
| 根 `tests/e2e-fixtures/trap-{00,01,03}-*` | 故意破坏的迷你仓 | e2e-story-a 脚本 | canonical（注意 trap-02 缺号） |
| 根 `tests/feature-testing/framework/test-scenarios/*.json` | 特性测试场景 | 仅手动 shell harness，无 CI/脚本引用；报告停在 2026-03 | **dormant** |
| 内联工厂（无独立文件） | makePainEvent/makeCandidate/makeDreamerCandidate/fakeDiagnosis 等 ~20 个 | 各自测试 | 分散但活跃 |

**命名污染扫描**（final/new/old/backup/temp/copy/draft/latest）：源码树几乎干净，仅根目录 `tests/final-okr-test.sh`、`tests/e2e-loop-fixed.sh` 两个一次性脚本命中；其余命中均在 `dist/` 构建副本与 `.kilo/worktrees/` 快照中（非源资产）。

---

# 5. skip / 死信号清单（Pain 路径相关）

| 文件 | 信号 | 状态 |
|---|---|---|
| plugin `tests/core/pain-score.property.test.ts` | `describe.skip`，fast-check 从未安装 | **出生即死（2026-04-15 #323/#326 后零改动）** |
| plugin `tests/hooks/prompt-size-guard.test.ts` | 2 个 `describe.skip`（M8 移除行为的"回归守卫"，永不运行） | 死块 |
| plugin `tests/hooks/gate-rule-host-pipeline.test.ts:86` | `it.skip`（注释：单跑过、全套挂——顺序依赖腐烂，从未修） | 死块 |
| plugin `tests/fixtures/production-compatibility.test.ts` | skipIf 无生产数据 | CI 等效跳过 |
| core `__tests__/mainline-product-path.test.ts` | 3 个 `it.todo`（PRI-C 配置 parity/真实 pain 行过诊断/候选血缘）——注释自述"RED until convergence" | **旗舰产品路径测试部分未实现（已文档化）** |
| core 4 个 `*-real-llm.test.ts` | skipIf 无 LLM_E2E_ENABLED；CI 全部 workflow 均不设置 | **真实 LLM 层在 CI 永不运行** |
| core `utils/cli-process-runner.test.ts:73` | describe.skip Windows 命令解析 | 在本仓库开发 OS（win32）上跳过 |
| plugin `tests/core/signal-stage2-real-adapter.e2e.test.ts` | skipIf 门 | 条件运行 |

（其余 skip 分布在 create-principles-disciple 安装器测试与 pd-console/console-open IPv6 等，均不在 Pain 闭环上。）

---

# 6. BDD 覆盖现状

- `.feature` 文件 21 个（`docs/specs/features/**`），**可执行 step 绑定仅 1 个**：core `tests/bdd/story-a.steps.ts` → `story-a/owner-approve-prompt.feature`。plugin 另有 4 个 `.steps.test.ts`（自含场景）。console `bdd/rulecode-owner-live-decision.steps.test.ts` 以源码串扫描保活 17 个场景。
- **纯文档型（无任何可执行绑定）的 Pain 路径 feature**：`owner-approve-prompt-ui`、`principle-governance-projection`、`rulecode-owner-live-decision`(console 版有绑定、core 无)、`codex-signal-admission`、`codex-owner-loop`、`principle-application-ledger`(plugin 版有)、`principle-receipt-block-copy`(plugin 版有)、`receipt-self-report`(plugin 版有)——其中 codex-governance 三例完全无绑定。
