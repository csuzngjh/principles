# PD Mock Reality Audit（Test Diet Phase 2.2-B3）

> 日期：2026-09-22 · 基线 commit：`e5e2b16b`（#1830 已并后 main）· 性质：**只读审计**，零代码/测试/fixture/CI 改动，未创建 PR
> 前序：#1813 / #1817 / #1820 / #1823 / #1828 / #1830；本报告与 `internalization-test-value-audit.md`（2.2-B 前置审计）互补：那份回答"哪些测试值得存在"，本份回答"存活的测试里哪些 mock 把真实系统风险模拟掉了"
> 原则：**不是删除所有 mock**。Safe Mock = 合理隔离外部依赖；Risky Mock = 隐藏真实行为；Production-like Test = 验证真实治理链路。

---

# Executive Summary

**1) Mock 总量**：四包合计 **836 个测试文件**，其中 **238 个（28%）使用至少一种 mock/双件机制**。模块级 `vi.mock` 共 **446 处**（core 46 / plugin 249 / console 22 / cli 129），`vi.fn` 至少 **2,479 处**（core 1,275 / plugin 1,007 / console 197 / cli 未逐计），`vi.stubGlobal` 集中在 pd-console（39 处，全部为 fetch/sessionStorage/localStorage 客户端边界）。手工双件均为对象字面量工厂或 `Memory*` 内存实现（core 9 个），无传统 `class Fake*`（plugin 0、core 命名类 3）。

**2) 最大风险区域**（按暴露面排序）：
1. **恒 valid validator stub 族**（core）：diag A/B runner（harness:456,508）、diag-chain-e2e（8 处）、internalization-consumer-product-path、dreamer 家族 4 处、rootcause-intent-tension——"畸形 LLM 输出在 runner 层被 schema 拒绝"这条防线在这些测试里是假的。唯一兜底是 `diag-*-output.test` / `default-validator.test` 的真实 TypeBox 矩阵（防线错位而非缺失）。
2. **gate rule-host 恒 allow 族**（plugin）：8 个 gate 测试文件 `vi.mock` rule-host 且 `_mockEvaluate` 默认 `undefined`=放行——PD 的 Owner 治理链（pain→gate→block）决策被脚本化。兜底：`gate-rule-host-real-pipeline` / `gate-real-io.e2e` 等明示 "no mocks" 的真链文件。
3. **名不副实的"生产路径"测试**（core）：`mainline-product-path.test.ts` 声称驱动 REAL production path，实际用 `PassThroughDreamerValidator`（恒 valid）+ artifactStore 硬编码 reject 持久化（:259-266, :272, :335）。
4. **Owner 授权门无 deny 测试**（pd-cli）：`runtime-activation-governance-audit.test.ts:16` 把 `authorizeGovernanceAction` stub 成无条件执行 mutation；全仓无该门的拒绝/挂起路径测试。
5. **接线被复制而非被驱动**（pd-cli, cli-7）：`candidate-show.test.ts` vi.mock 掉被测命令模块、自搭 commander 树，且测试副本的报错方式（throw）与生产（`process.exitCode=1`）**已经漂移**——错误路径两个 it 断言的是生产不存在的行为。

**3) 最大收益修复区域**：B3-A（diag A/B 校验层升级真实 Default validator）。证据链完整：harness 的 payload 直接展开 `MOCK_*.R6`（"cached real LLM data"），router 的真实 TypeBox 校验已在 EP-01 用例接受同一 payload；B2 的 `createWithRealValidator` 已示范接线。**小改动、把整个 diag 家族的 runner 层 schema 防线从假变真。**

---

# Mock Inventory

## 汇总

| Package | 测试文件 | 含 mock 文件 | vi.mock 处数 | vi.fn 处数 | stubGlobal | 备注 |
|---|---|---|---|---|---|---|
| principles-core | 397 | 86 (+1 fixture) | 46 / 25 文件 | 1,275 | 0 | 9 个 `Memory*` 生产内存实现；fake 类 3：TestDoubleRuntimeAdapter / PassThroughDreamerValidator / PassThroughValidator |
| openclaw-plugin | 204 | 90 | 249 / 66 文件 | 1,007 | 0 | 手工双件≈25 个对象字面量工厂；83 文件零 mock（真 fs/SQLite）；10 文件仅 fake timers |
| pd-console | 130 | ~35 | 22 / 12 文件 | 197 | 39 | 主流是 req/res 双面 + 真 tmpdir/SQLite；8 个 integration 全真；e2e 10 spec 零 page.route |
| pd-cli | 105 | 50 (48%) | 129 | — | — | `vi.mock` runtime-v2 barrel + resolve-workspace 是主导模式；7 文件直接 mock `fs`，1 文件 mock `better-sqlite3` |

## principles-core（按机制族；单文件路径省略 `packages/principles-core/` 前缀）

| Location | Mock Type | Target | Purpose |
|---|---|---|---|
| src/runtime-v2/adapter/__tests__/{artificer-l2,l2-agent-loop,pi-ai-runtime,runtime-config-contract,pd-stream-simple}.test.ts | vi.mock | `@earendil-works/pi-ai`（LLM provider）、event-emitter | 外部 LLM 隔离（Category A） |
| src/runtime-v2/adapter/__tests__/openclaw-cli-runtime-adapter*.test.ts ×3 | vi.mock | `cli-process-runner`（子进程） | 不真 spawn openclaw CLI（A） |
| src/runtime-v2/__tests__/{sqlite-connection-readonly,trajectory-store,schema-conformance-read-model,pruning-read-model,internalization-chain-integrity-read-model,candidate-audit,operator-health-*,pain-chain-read-model,build-l2-principle-reader}.test.ts | vi.mock | **better-sqlite3 + fs + loadLedger** | read-model/持久层——见 Risk §持久（B/C 边界） |
| src/runtime-v2/activation/__tests__/{sqlite-activation-state-store,activation-re-dispatch}.test.ts | vi.fn | `SqliteConnection.getDb/prepare/exec` | SQL 字符串形状断言，非查询行为 |
| src/runtime-v2/activation/__tests__/approval-queue.test.ts:126-232 | 有状态 fake | ApprovalQueueStore（10 方法） | 行为忠实的内存 fake（pending→approve 状态机在 fake 内成立）（B，低风险） |
| src/runtime-v2/__tests__/{artificer,evaluator,scribe,rollout-reviewer,dreamer,philosopher}-runner-vslice + base-peer-runner-* ×4 | vi.fn 面（106/89/48/40/63/22/30 fn） | stateManager/artifactStore/runtimeAdapter | runner 分支矩阵（retry/commit/write-fail）（B；write-fail 注入合理） |
| src/runtime-v2/internalization/__tests__/diag-{router,rootcause,distiller}-runner + diag-runner-contract | 共享 harness | 恒 valid validator（A/B 角色）| B2 收敛产物；见 Diag Validator Reality |
| src/runtime-v2/internalization/__tests__/diag-chain-e2e.test.ts:290,323,699,716,814,826,922,933 | inline 恒 valid stub | validator ×8 | "e2e"链上校验层为假 |
| src/runtime-v2/__tests__/mainline-product-path.test.ts:272,335 | PassThroughDreamerValidator + reject-store | validator + artifactStore | 见 Risk（名不副实） |
| src/runtime-v2/__tests__/internalization-consumer-product-path.test.ts:159-165 | createMockValidator 恒 valid | validator | "full cycle integration" 标题下校验为假 |
| src/runtime-v2/__tests__/{dreamer-runner-vslice:86,dreamer-runner:161-163,dreamer-source-pain-provenance:125-128} | 恒 valid | validator | dreamer 分支/时序（部分 B、provenance 属 C） |
| src/runtime-v2/internalization/__tests__/diag-rootcause-intent-tension.test.ts:187-188 | 恒 valid | validator | intent-tension 场景 |
| src/runtime-v2/__tests__/{rollout-rule-candidate-contract:174,evaluator-runner-vslice-v2:432,469,740,1001} | 脚本化 | fetchOutput→approve_rollout；sandbox gate 恒 pass | 决策预置（C，见治理族） |
| src/runtime-v2/internalization/__tests__/owner-override-resume.test.ts:102,218,319,371 | harness 工厂 | dispatchActivation/reopenRevisionTarget；`scribeValidated=true` 默认 | 治理默认通过（C） |
| src/runtime-v2/activation/__tests__/{promotion-readiness-reader:21,45,activation-dispatcher:421,618,646,rulecode-owner-decision-service} | async stub | validateProductionArtifact / canActivate 恒 ok；commitPromotion | 有缓解：真 Memory store + "未激活"负断言（B/C 边界） |
| src/runtime-v2/__tests__/pain-signal-runtime-factory-effectiveconfig-wiring.test.ts:44-50 | vi.mock ×3 | 三个 diag runner 类 | 只验 effectiveConfig 抵达 ctor——合理（A/B） |
| src/runtime-v2/{runner/__tests__/default-validator,tools/__tests__/dreamer-output-typebox,adapter/__tests__/{output-repair-contract,structured-output-repair,schema-prompt-adapter-semantic}} | **无 mock** | 真实 Default*Validator | 区域最硬 schema 防线（反证材料） |
| src/runtime-v2/__tests__/production-canary-fixture-gate.test.ts | **无 mock** | 真 SQLite 驱动同一批 read-model | read-model mock 族的真实兜底 |
| vi.mock('fs') 族：core config/init/migration/hygiene/focus-history 等 ~15 文件 | vi.mock | 文件系统 | 纯逻辑单测磁盘隔离（A，边界可接受） |
| src/runtime-v2/utils/cli-process-runner.test.ts:11、dreamer-runner.test.ts:219、pruning-mask.test.ts:265 | useFakeTimers | 时钟 | 计时逻辑（A）；cli-process-runner 是子进程+时钟双接缝（B） |

## openclaw-plugin（路径省略 `packages/openclaw-plugin/`）

| Location | Mock Type | Target | Purpose |
|---|---|---|---|
| tests/hooks/gate-{auto-correct,auto-correct-shadow,receipt-integration,no-path-write-tool,rule-host-pipeline,rule-context-v2,rule-context-v2.e2e}.test.ts + tests/bdd/principle-application-ledger.steps.test.ts | vi.mock(rule-host) | `_mockEvaluate` 默认 undefined=**allow** | gate 决策脚本化 ×8（C 最大族） |
| tests/hooks/{core-principles-injection(15),prompt-golden(14),prompt-characterization(11),prompt-diet(10),prompt-size-guard(10),prompt-intent-injection(18),runtime-v2-prompt-activation(10)}.test.ts | vi.mock 军团 | workspace-context、pain gate(`shouldDiagnose:false`)、triage(`triaged:false`)、activation-reader 等 | prompt 渲染隔离全部协作者（B；pain gate 属 C） |
| tests/hooks/pain-{funnel-ingress,dead-letter}.test.ts + commands/pain.test.ts | vi.mock | PainToPrincipleService.recordPain 恒成功/恒失败/空 ctor | 失败注入合理，恒成功路径为假（B/C） |
| tests/core/pd-task-reconciler.test.ts:21,28-29 | vi.mock | pd-task-store 全自动 mock；`withLockAsync`→**裸调用（无锁）** | 并发/锁语义缺席（C） |
| tests/hooks/gate-block-trajectory-persistence.test.ts | vi.spyOn ×7 | trajectory getter、recordGateBlock | 持久化失败注入（B，合理） |
| tests/internalization-auto-consumer-service.test.ts:107-436 | vi.spyOn 原型 | DreamerRunner.run、PhilosopherRunner.run、recoverySweep | 编排不跑 LLM worker（B；兜底=真 worker e2e 链） |
| tests/host-runtime-registration.test.ts:65-67,107-108 | vi.mock ×12 + fake API | hooks/prompt·gate·pain 全替换；registerCommand/Tool/HttpRoute 为未消费 vi.fn | "routing works"≠"handler works"（B/C） |
| tests/index.test.ts:13-34 | fake OpenClawPluginApi | rootDir:'/mock'，/pd-pain handler 打空工作区只断 Promise 形态 | 注册 smoke（C：命令 handler 从未真跑） |
| tests/service/correction-observer-service.test.ts:120-140 | vi.mock | PiAiRuntimeAdapter/CorrectionObserver/AgentScheduler 空壳 + mockDispatch | 观察者循环（B，外部 LLM 隔离合理） |
| tests/fixtures/production-mock-generator.ts:12-14 | — | **读开发者真机 `~/.openclaw/workspace-main/.state`** | fixture 非确定、跨机器漂移（C，环境耦合） |
| tests/utils/isolate-pd-canonical.ts:31-37 | vi.mock('os') | homedir→temp dir | 刻意 hermetic（A，注明掩盖真实配置交互） |
| src/core/principle-compiler/__tests__/compiler-replay-gate.test.ts:17-19,86 | vi.mock | validateGeneratedCode 恒 `{valid:true}` | replay 分支（B；`code-validator.test.ts` 真测兜底） |
| tests/integration/*（a2-reconciliation、rulehost-seed-mvp 等）| `runtimeKind:'test-double'` 字符串 | 租约身份枚举 | **非 mock**，生产枚举值，勿误判 |
| 83 个零-mock 文件（gate-real-io.e2e、gate-rule-host-real-pipeline:11、feedback-pipeline、principle-lifecycle.e2e…） | 无 | 真 fs/SQLite/host | 反证材料：真链覆盖存在且承重 |

## pd-console（路径省略 `packages/pd-console/`）

| Location | Mock Type | Target | Purpose |
|---|---|---|---|
| tests/server/routes/*（约 19 文件） | vi.fn（req/res 为主） | IncomingMessage/ServerResponse | HTTP 路由契约——**真 tmpdir/SQLite 后端**（A/B，健康主体） |
| tests/server/routes/failed-tasks.test.ts:86-91, workspaces.test.ts:120-180 | 手写 fake store | SqliteTaskStore / WorkspaceConfigStore | 状态映射/CRUD 路由（B） |
| tests/server/routes/onboarding.test.ts:12-14 | vi.mock | child_process.spawn | 断 argv，DB 不碰（A） |
| tests/server/routes/config.test.ts | vi.mock('fs') **无操作**（importActual 原样展开） | fs | 死 mock，候选清理（B3-C） |
| tests/server/routes/health-codex-governance.test.ts:22-33 | vi.mock | Health/CodexGovernance Model | 显式声明不测 CLI 子进程（A） |
| tests/server/update/*（4 文件） + utils/gateway.test.ts:18-45 | vi.mock | release-manager authority、os.homedir、spawn、execFileSync、FakeSocket | 注入面/命令注入回归（gateway 测试目标就是 argv 构造——合理） |
| tests/ui/*（9 文件） | vi.stubGlobal('fetch') / sessionStorage | 全局 fetch | API client 形态测试（A，正确边界） |
| tests/ui/focus-page.test.ts:22-26 | vi.mock | **整个 src/ui/api.js** | 渲染测试桩掉全部 API 层（B） |
| tests/models/activations-console-model.test.ts:332-335 | vi.spyOn | getOwnerReview（promote readiness gate） | 治理事件覆盖桩掉 readiness——(C，单点) |
| tests/bdd/principle-governance-projection.steps.ts:38-63 | page.route fulfill | 服务端 endpoint | 浏览器侧 stub（B）；同目录 focus-page.steps 打 127.0.0.1:3100 真服务 |
| tests/integration/* ×8、tests/e2e/* ×10、e2e-owner | **无 mock** | 真 SQLite+HTTP+浏览器；e2e 零 page.route | 反证材料：Owner 旅程端到端为真 |

## pd-cli（路径省略 `packages/pd-cli/`）

| Location | Mock Type | Target | Purpose |
|---|---|---|---|
| 主导模式：约 40 文件 | vi.mock | `@principles/core/runtime-v2` barrel + resolve-workspace | 命令 handler 单测（B；批量遮蔽 ctor 面） |
| tests/commands/candidate-show.test.ts:12,23-47 | vi.mock(被测模块) + **自建 commander 树** | src/commands/candidate.js 全 handler | 断言的是测试副本行为；副本 throw vs 生产 exitCode **已漂移**（C, cli-7 违反实锤） |
| 同 pattern（自建树引真 handler 不引真注册）：pain-retry.test.ts:878(缺 `--maxTokens` 漂移)、diagnose.test.ts:993、pain-evidence.test.ts:319、candidate-internalization-backfill.test.ts:96、runtime-internalization-{integrity-repair:37,enqueue-successors:126,run-once:1720} | 手写 program | 生产注册未参与 | cli-7 灰区（B/C） |
| vi.mock 兄弟命令模块 ×5：candidate-show:12、diagnose:212、pain-record:23、pain-record-async:28、runtime-diagnostics-export:42(→canary 恒 healthy) | vi.mock | src/commands/*.js 互相引用面 | 跨命令依赖隔离（runtime-diagnostics-export 属 C：健康判定被写死） |
| tests/commands/health.test.ts:31,78,85,89 | vi.mock | runtime-v2 read-models + host-runtime + **fs** + **better-sqlite3** | `pd health` 的 DB 读面仅在此全 mock 文件中存在（C，覆盖缺口） |
| tests/commands/runtime-activation-governance-audit.test.ts:16 | async stub | `authorizeGovernanceAction`→无条件执行 mutation | **Owner 授权门无 deny 测试**（C 最高危单点） |
| tests/commands/candidate-intake.test.ts:74-86、candidate-audit-repair.test.ts:101-109、backfill（同型） | 镜像重实现 | evaluateCandidateAdmissionFromRecord "Mirror the real implementation" | 准入门决策被复制而非被调用（C：真实现漂移不报红） |
| tests/commands/{health-codex:154-163,runtime-activation:944} | mockReturnValue | ingestion consent 默认 granted；promoteActivation 恒 true | 治理默认通过（C；health-codex 有 revoke/stale 变体 :297,:305） |
| tests/commands/runtime-internalization-wake-once.test.ts:53,69 | 字面量 | gateResult 恒 proceed/ready | 门放行预置（B：wake 逻辑是主体） |
| 真实反证：tests/e2e/cli-full-flow.test.ts（spawn 真 `dist/index.js`，含 `.pd/` 真 DB 引导）、pd-cli-smoke、cli-command-tree、cli-help-snapshot、health-host-wiring、runtime-activation-*-flag-wiring（真 `register…Command`+`program.parseAsync`，零 vi.mock） | 无 | 真解析器/真注册 | cli-7 部分达标：注册与 help 为真；action 级多数为假 |

---

# Mock 分类（A / B / C）

| 类别 | 定义 | 代表 | 判定 |
|---|---|---|---|
| **A Safe Isolation** | 外部系统（LLM provider、子进程、时钟、真机 home 配置）不是被测对象 | pi-ai mock 族、cli-process-runner、os.homedir 隔离、UI fetch stub、fake timers 计测族、pd-console req/res | **保留**。数量主体 |
| **B Behavior Simulation** | 模拟了真实接口的派生行为，但有状态忠实性或别处真实兜底 | Memory*Store×9、approval-queue 忠实 fake、runner V-slice 面、gateResult proceed、TestDouble 脚本化 LLM 输出 | **保留 + 记录兜底**。逐条对照兜底测试是否存在 |
| **C Risky Mock** | 被 mock 掉的正是测试名义上要保证的行为 | 恒 valid validator 族、rule-host 恒 allow 族、mainline-product-path、authorizeGovernanceAction 恒批、admission 镜像重实现、candidate-show 复制接线、withLockAsync 无锁、health 全 mock、production-mock-generator 真机耦合 | **见 Risk Matrix 与 Roadmap**。不是全删，是选择性切 production-like path |

---

# Diag Validator Reality（重点章节）

## 现状矩阵

| Runner | Current Validation（main `e5e2b16b` 实况） | Risk | Recommendation |
|---|---|---|---|
| Router | **真实 TypeBox**：无 validator 注入面；失败经 `fetchOutput` 畸形 payload 命中 runner 内 `Value.Check`（contract:59-66；harness 头注 :7-11） | Low | **Keep** |
| Rootcause | **恒 valid mock**（harness:455-457）；失败经 seam 注入（contract:73-78；stage 文件 :62-84；intent-tension:187 另有独立 stub） | **High**：runner 层"schema 拒绝畸形输出→不写工件"从未为真 | Selective migration（见下表） |
| Distiller | **恒 valid mock**（harness:506-509）；但 stage:73 与 contract:151-154 已有 2 处真 `DefaultDiagDistillerValidator` 探针对 | **High**（同上） | Selective migration |

## 关键证据（为何说防线"错位"而非"缺失"）

1. 真实 schema 防线在 `diag-rootcause-output.test`(39 it) / `diag-distiller-output.test`(9 it) / `default-validator.test`(60+ 真实例)——TypeBox 从未被 mock（全包 `vi.mock` typebox/Value = 0 命中，已验证）。
2. B2 已证明可迁移性：harness 输出工厂 = `MOCK_*.R6`（注释言明 cached real LLM data），同一 payload 在 router 真实校验下 valid（EP-01 用例 valid/corrupt 双向为证）；`createWithRealValidator`（contract:143-154）演示了真 validator 接入 harness 的完整接线。
3. 残余不确定性（如实申报，不推断）：`diag-chain-e2e` 与 consumer-product-path 的 payload 是否有**全部**能通过真 schema 的形态，审计阶段无法在不跑测试的前提下断言——列为 B3-A 实施第 0 步验证项，不满足则保持 mock 并降级为 follow-up。

---

# Validator Migration Plan（只设计，不改动）

| Test | Current | Proposed | Reason |
|---|---|---|---|
| harness rootcause/distiller **默认 validator**（:456,:508） | 恒 valid mock | `new DefaultDiagRootCauseValidator()` / `DefaultDiagDistillerValidator()` 为默认；恒 valid 降级为 opt-in override | 让每个走默认面的成功用例顺带钉住"fixture 过真 schema"；protects schema |
| contract "Failed after validation failure"（A/B，:73-91） | mock seam 注入 invalid | **Keep Mock** | 测试目标是"validator 返回失败→runner 走 fail 路径"，seam 即正当隔离 |
| contract "missing taskId re-injected"（:159-182） | mock + 落库内容补偿断言 | 真 validator；补偿断言保留 | 恒 valid mock 才需要"钉注入值"补偿；真 schema 下 missing taskId 直接不可过 |
| **新增**（当前 0 个）："runner 对 schema-invalid payload 判 failed、零写入" A/B | 不存在 | 真 validator + 畸形 payload（router 已有对等物） | 补齐 A/B 与 router 的对称防线 |
| rootcause stage "lease→fail→no artifact"（:62-84） | mock reject | **Keep Mock**（或改真+畸形 payload，二选一不强行） | 失败注入正当；改动只为统一，不增加信号 |
| distiller stage :65-69（已含真 validator 用例旁的 mock 用例） | 混用 | 统一走真 validator 一个即可 | 同型防线不重复付两份 |
| diag-chain-e2e 8 处恒 valid（:290-:933） | mock | **条件迁移**：先跑 payload 真 schema 预演（第 0 步），全过→切真；个别不过→该处留 mock 并在测试内注释注明原因 | "e2e" 名义链路的校验层为真是本审计最大单点收益 |
| internalization-consumer-product-path :159-165 | createMockValidator | 同上条件迁移 | "full cycle integration" 标题承诺 ≥ 实际 |
| mainline-product-path :272,:335 | PassThroughDreamerValidator | `DefaultDreamerValidator`（payload 预演后）；若 fixture 不过 strict→先修 fixture，再不行则把文件标题的 "REAL production path" 声明改掉 | 名实一致比多一个绿灯重要；:259-266 的 reject-store 同步处理（见 Risk） |
| dreamer 家族（vslice:86 / runner:161 / provenance:125） | 恒 valid | **Keep Mock**（vslice 分支矩阵、backoff 时序）；provenance 视预演结果迁移 | V-slice 的被测对象是分支覆盖不是 schema |
| intent-tension rootcause:187 | 恒 valid | Keep Mock，**但** intent-tension 语义判定本就在 validator 之外，加一行注释声明该面不测 schema | 消除"看起来在测校验"的误读 |
| plugin rule-host 恒 allow ×8 | vi.mock 默认 allow | 不在 B3（属 plugin 包）；候选：默认改为"未注册=报错"的忠实 stub + 保住 `gate-rule-host-real-pipeline` 兜底 | 登记 follow-up，勿混车 |

**规模**：迁移主体集中在 1 个 fixture 文件 + 4 个测试文件 + diag-chain-e2e；预计断言数不降、新增 2-4 个 schema-rejection 用例。

---

# Fixture Dependency（重点章节）

## 全仓生产→测试 import 方向审计结果

`rg` 全包 `from '.../__tests__|__fixtures__|/tests/'`，非测试文件的命中**有且仅有一处**：

```
BEFORE（现状）：
  pd-cli 生产命令(diagnose/pain-retry/run-once/synthetic-baseline/pain-flood)
        │ new TestDoubleRuntimeAdapter()   ← --runtime test-double 是产品功能
        ▼
  core/src/runtime-v2/adapter/test-double-runtime-adapter.ts   [生产代码]
        │ import MOCK_ROOT_CAUSE/DISTILLER/ROUTER_OUTPUTS       ← 唯一 src→__tests__ 反向边
        ▼                                                     (test-double-runtime-adapter.ts:25, PRI-401 ba90cbe8c)
  core/src/runtime-v2/internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.ts  [测试资产]
        ▲
  4 个测试文件正常方向消费（diag-chain-e2e、两个 intent-tension、harness:47-51）
```

**放大事实（新发现，前审计未记录）**：`tsconfig.json` `include: ["src/**/*"]` → `__tests__` 与 fixture 一并编译进 `dist`，`package.json` `"files": ["dist"]` → 实测 `dist/runtime-v2/internalization/__tests__/__fixtures__/split-pipeline-mock-outputs.js` 存在，**dist 内含 386 个 `*.test.js`**。即：这条反向边不只是结构性异味，它已把测试源码发布进了 npm 产品面。fixture 变更 → 生产 test-double 行为变更 → 发布物变更，三者已无隔离。

次级发现（非反向、同族治理）：
- `golden-dogfood-fixtures.ts` 的 `GOLDEN_FIXTURES`/`FixtureDataSet` 经 `runtime-v2/index.ts:948-949` 进公共 barrel——fixture 数据在公开 API 面上（涉公共 API，处置需 Owner）。
- `tests/bdd/story-a.steps.ts:26` 伸手进 `activation/__tests__/helpers.js`（tests→tests 跨目录，无生产风险，登记即可）。
- 跨包 `tests/bdd/support/vitest-bdd.js` 复用 ×8 文件——BDD 共享 harness，方向正常，保留。

```
AFTER（提案，本阶段不动文件）：
  core/src/runtime-v2/adapter/split-pipeline-fixtures.ts   ← 数据字面量迁到生产目录，生产自持
        ▲                    ▲
  adapter 本地 import      测试(4 文件+harness)改从这里 import（方向恢复 tests→src）
```

搬移要点：`git mv` 保留历史；导出名不变减少 diff；`__tests__/__fixtures__/split-pipeline-mock-outputs.ts` 删除或留薄 re-export（倾向删除，避免双层）。dist 卫生（tsconfig exclude `**/__tests__/**` + 重新核对 386 个测试文件是否进发布物）**超出 Test Diet 边界**，作为独立发现报 Owner——它动构建/发布面。

---

# PassThroughDreamerValidator 审计与决策

## 考古（git log -S / --follow）

| 事实 | 证据 |
|---|---|
| 出生 | `8dc3822df`（PRI-67, PR #497）"Dreamer peer runner via PDRuntimeAdapter"——**feature 时代产物**，非 migration、非临时 workaround；诞生即测试用 |
| 定性 | `dreamer-output.ts:108` "test-only and must not be used in production paths"；`@deprecated` :176-181；实现无条件 `{valid:true}` :182-187 |
| 生产使用 | **无**。`architecture-regression.test.ts:1813-1820` 负守卫钉死 run-once CLI 不得 `new PassThroughDreamerValidator()`（该守卫本身是生产防线） |

## 使用面分类（git grep 全仓，逐处核对）

- **Production usage**：0。
- **Test-only usage**：`mainline-product-path.test.ts:272,:335`（×2，且在活 it 内非 todo）；pd-cli `runtime-internalization-run-once.test.ts:99` 仅 vi.fn ctor 占位名。
- **Barrel-only residue**：`runtime-v2/index.ts:960` + `internalization/index.ts:199` 双 barrel re-export；PRI-775 冻结快照 `runtime-v2-barrel-surface.json:851`；`architecture-regression.test.ts:1794` 的**正向** BARREL_EXPORTS 钉（退休时需同步反转）。

## 决策：**MOVE →（Owner 批准后）DELETE export**

1. MOVE：类实现移入测试可达的本地模块（或并入 mainline-product-path 的局部 fixture），消除生产源内的恒 valid validator。
2. DELETE 公共导出：从双 barrel + 冻结快照摘除，:1794 正钉改负钉（"barrel MUST NOT export"）。**此为公共 API 收缩 → 触发 Stop Condition 3，需 Owner 裁决，不列入 B3-C 自动清单。**
3. 前置依赖：Migration Plan 中 mainline-product-path 先改用 `DefaultDreamerValidator`，否则 MOVE 无从谈起。

## 附送发现：`PassThroughValidator`（monolithic diag 家族）——**纯死代码**

`runner/diagnostician-validator.ts:61-66`，恒 valid；生于 M4 时代 `e113548b7`（PR #395），被 `DefaultDiagnosticianValidator` 取代；**零消费者、零 barrel 导出、不在冻结快照**。与 PassThroughDreamerValidator 不同，它不触公共面（外部从不可见），仅随 dist 被动发布。→ **B3-C 直接 DELETE，无需 Owner**。

---

# Mock Risk Ranking

评分规则：+3 保护真实用户行为 / +2 保护状态迁移 / +1 隔离外部依赖 / −2 隐藏 persistence / −3 隐藏 schema validation / −3 绕过 Owner decision。

| Rank | Mock 点 | 分 | 依据 |
|---|---|---|---|
| 1 | pd-cli `authorizeGovernanceAction` 恒批且全仓无 deny 测试（runtime-activation-governance-audit.test.ts:16） | **−3** | Owner 授权门是 PD 核心；唯一触及该门的测试把它抹平 |
| 2 | mainline-product-path：PassThrough validator + artifactStore 硬 reject（:259-266,272,335） | **−3 −2** | "REAL production path" 名义下 schema 与持久化双假 |
| 3 | plugin rule-host 恒 allow ×8（gate 家族） | **−3** | gate 决策=Owner 治理的执行端；真链兜底存在但同名 e2e 文件（rule-context-v2.e2e）实为 mock 链 |
| 4 | diag A/B + chain-e2e + consumer-product-path + provenance 恒 valid validator（共 15+ 处） | **−3** | runner 层 schema 防线假（错位到独立 output 测试——缓解但未消除） |
| 5 | pd-cli admission-gate "Mirror the real implementation" ×3 文件 | **−2** | 决策被复制：真实现漂移时测试不红（比 stub 更糟的静默） |
| 6 | candidate-show.test.ts 复制接线 + throw/exitCode 已漂移；pain-retry 缺 --maxTokens | **−2** | 测的是副本；错误路径断言 = 生产不存在行为（cli-7） |
| 7 | `pd health` DB 读面仅存在于 fs+better-sqlite3 全 mock 文件（health.test.ts:85,89；真 DB 变体不触 DB 段） | **−2** | 覆盖缺口型：真实环境该面在 CLI 测试层零保护 |
| 8 | read-model better-sqlite3 mock 族（pruning SQL 子串路由、schema-conformance 自指、activation-store 字符串形状） | **−2**（canary 兜底降为 −1） | production-canary-fixture-gate 真 SQLite 驱动同批 read-model |
| 9 | pd-task-reconciler `withLockAsync` 裸调用 | **−2** | 锁语义缺席；reconciler 生产承重即锁 |
| 10 | production-mock-generator 读真机 `.state` | **−2** | 非确定 + 机器耦合 |
| 11 | console activations-model getOwnerReview spy（:332-335） | −1 | 单点、有 approvals-api 真链 |
| 12 | dreamer/runner V-slice stateManager 面、gateResult proceed、fake timers 族、pi-ai mock、os 隔离、UI fetch stub、req/res | **+1** | 外部依赖/边界正确 |
| 13 | approval-queue 有状态忠实 fake、Memory*Store×9、TestDouble 脚本 LLM、split-retry 矩阵 | **+2** | 状态迁移在双件内真实成立 |
| 14 | default-validator/diag-*-output 真 TypeBox 矩阵、mvp-core-loop-journeys 真 SQLite、e2e/cli-full-flow 真二进制、flag-wiring 真注册+parseAsync、83 个 plugin 零-mock 文件、console 8 真 integration | **+3** | 本审计的承重墙：真实治理链证据 |

---

# Implementation Roadmap（提案，实施需逐项 Owner 放行）

## B3-A — Validator selective migration（1 PR，core 包，零生产代码改动）
1. 第 0 步（实施者跑，非本审计）：diag-chain-e2e / consumer-product-path / mainline 的 payload 过真 schema 预演。
2. harness 默认 validator 切实例（override 保留恒 valid）→ contract 两个 taskId 用例随动 + 新增 A/B schema-rejection 对称用例。
3. chain-e2e / consumer-product-path / mainline 按预演结果迁移；不过则维持 mock + 注释声明该面不测 schema。
4. 验收：runner 层 schema-rejection 用例数 >0；既有断言零削弱；`npm run verify:merge` 绿。
   风险：低（B2 harness 就是为此预留的 seam）。

## B3-B — Fixture dependency inversion（1 PR，core + 少量 pd-cli import 行）
1. `split-pipeline-mock-outputs.ts` → `src/runtime-v2/adapter/split-pipeline-fixtures.ts`（git mv）；5 个消费方改 import。
2. 验收：`rg "__tests__/__fixtures__" packages/*/src --glob '!**/__tests__/**'` = 0 命中；adapter 单测 + chain-e2e 绿。
3. **拆出不动**：dist 卫生（tsconfig exclude）→ 独立发现报 Owner，涉构建面。

## B3-C — Dead test helper cleanup（1 PR）
1. DELETE `PassThroughValidator`（runner/diagnostician-validator.ts:61-66，零公共面）。
2. DELETE pd-console `routes/config.test.ts` 的无操作 `vi.mock('fs')`。
3. （前置 B3-A 完成后）PassThroughDreamerValidator MOVE + barrel 摘除——**公共 API 收缩，等 Owner 批**；同步 :1794 正钉转负钉 + 冻结快照。
4. mainline-product-path 的 reject-store（:259-266）与文件标题名实修正。

## 登记不实施（Follow-ups，各归各线）
- plugin gate rule-host 恒 allow 默认改造（−3 第 3 名，量大，属 plugin 包测试治理下一棒）；
- pd-cli：authorizeGovernanceAction deny/pending 路径测试（−3 第 1 名，建议单独立票，优先级最高）；
- `pd health` 真 temp-DB 覆盖；candidate-show 改走真 `registerCandidateCommand`（漂移即 bug 信号）；admission 镜像重实现改为调用真实现；withLockAsync 锁语义保真；production-mock-generator 去真机耦合；golden-dogfood-fixtures 公共面裁决（涉 API）。

---

# Stop Conditions 处置

未触发停机。四项边界如实申报为"实施期验证项"而非推断结论：① chain-e2e payload 真 schema 通过性（B3-A 第 0 步实测）；② barrel 摘除涉公共 API（移交 Owner）；③ dist 卫生涉构建面（移交 Owner）；④ rule-host 改造涉 runtime 测试架构（出 B3 范围，票化）。

# Definition of Done 回执

- ✅ 零代码/测试/fixture/CI 修改，未建 PR（本报告为唯一新增文件，untracked）
- ✅ Inventory：836 测试文件 / 238 含 mock / vi.mock 446 处 / vi.fn 2,479+ 处，全部到文件粒度
- ✅ 分类 A/B/C + Diag Validator Reality Matrix + Migration Plan + Fixture Graph + PassThrough 决策（MOVE→DELETE，Owner gate）+ Risk Ranking（14 行计分）
- ✅ 所有结论带 file:line；反证材料（真实兜底链）单列，防止"见 mock 就砍"
- ✅ 实施优先级：B3-A → B3-B → B3-C；pd-cli 授权门 deny 测试建议独立优先立票
