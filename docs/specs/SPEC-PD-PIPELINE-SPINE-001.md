# SPEC-PD-PIPELINE-SPINE-001 — PD 核心管道主干收敛规范

- **版本**：v0.14
- **日期**：2026-11-28
- **状态**：Draft for Owner Review（未批准；v0.10 为实施期评审驱动的规范回填，v0.11/v0.12/v0.13 为事实勘误与评审增补，仍待 Owner 决策与批准）
- **修订记录**：
  - **v0.13（第六轮评审：四项行为规范增补 + 一项勘误）**：① R4-5 勘误——`consumedRevisionCauseIds` 为无淘汰追加历史（非上限 32 FIFO）；② R4-6 增补——多后继声明同一 parent/kind/channel 必须 fail-closed `successor_integrity_conflict`；③ R4-9 增补——repair reopen 失败结构化传播 + consumer 完整遥测；④ 新增 R4-11 历史血缘回填——dependencyTaskIds≠因果血缘，Adversarial round N>1 真实父为上一轮唯一 needs_revision Evaluator，孤儿任务保持 canonical 错误分类。规范条文详见 TECH 文档。
  - **v0.14（第七轮评审：数据完整性 / 并发安全 / 状态机一致性）**：① 新增 R4-12——Repair 身份完整验证：确定性任务 id 不证明 repairPayload 身份，两个 Seeder 复用路径与 REOPEN_SOURCE_EVALUATOR 完成路径共享核心同一验证器，身份冲突 fail-closed 且零写入，缺失血缘经全快照 CAS 回填；② 新增 R4-13——Reopen 快照生命周期：血缘回填后重读权威快照，merge 与终写 CAS 均以第二快照为准；③ 新增 R4-14——只读 lineage planner 统一 dry-run/confirm/Seeder 判定，dry-run 零写入；④ 新增 R4-15——reconciliation 完整投影 reopenedTaskId/successorTaskId/successorKind；⑤ 新增 R4-16——全部 CAS 前提含 leaseGeneration；⑥ 新增 R4-17——run-once 决策映射编译期穷尽。规范条文详见 TECH 文档。
  - **v0.12（第五轮评审：一项事实勘误 + 三项行为规范增补）**：① R4-1 勘误——根身份双源缺失时仍接受**链一致的根自身 `correlationId`** 作第三佐证（v0.5 实现设计，原"双缺失即拒绝"与代码不符）；② R4-5 增补——`revisionCauseId` 单槽覆写缺陷修复：幂等判定读有界消费历史 `consumedRevisionCauseIds`（上限 32 FIFO），写不变量驻留 `mergePITaskMetadata` 单一重建点；③ R4-6 改写——父子扫描为唯一后继权威（直查快路径废除，修复跨链派生 id 碰撞导致的错链级联），创建路径 bounded 收敛循环（UNIQUE 重扫 → 父派生 fallback id → fail-closed `successor_id_conflict`）；④ R4-8 增补——预览复用共享只读级联判定 `planExistingSuccessorTransition`，将被级联重开的终态后继报告 `would_reopen_successor` 而非 `successor_exists`。规范条文与回归证据详见 TECH 文档。
  - **v0.11（v0.10 事实勘误，无规范行为变更）**：评审指出 v0.10 回填条文与代码存在字段/类型名不一致，逐项核实后于 TECH 文档勘误：① R4-1 拒绝 reason 实为 `conflicting_root_identity_sources`；② R4-4 CAS 前提集修正为 `taskId` + `diagnosticJson` 逐字节 + 六项显式快照前提（含 `maxAttempts`/`leaseGeneration`，v0.10 漏列且误标 lease 字段为恒 null），`revisionCount`/`revisionCauseId` 由 `diagnosticJson` 字节相等覆盖而非独立前提；③ R4-4 幂等重放返回实为 `{ ok: true, reason: 'idempotent_replay_same_revision' }`（无 `outcome` 字段）；④ R4-6 状态枚举修正（`running` 非 `PDTaskStatus`，非终态命中含 `failed`）；⑤ R4-9 consumer cycle 机制修正（即时路径 `successorDecision` 遥测透出 + reconciliation 计 `blocked`，不存在"计入 `skipped`"的机制）；⑥ R4-10 类型名修正（实为 `SelectedInternalizationTaskRunResult`）并补全白名单精确枚举。规范意图与代码行为均未变，仅事实描述与实施对齐。
  - **v0.10（PR #2803 实施期评审回填修订）**：
    1. **Phase 2B/3 运行时规则回填**：实施与多轮评审确认 v0.9 未规定的 10 项内化链运行时规则（root correlationId 权威身份、parentTaskId 血缘完整性、最大父链深度 10 与**创建前**新增边检查、reopen 全快照 CAS 前提集与并发失败语义、revisionCauseId 幂等、历史终态后继按 `(parentTaskId, kind, channel)` 复用、RuleHost 时间戳 id 链与 enqueue-successors 的统一幂等、dry-run/confirm 判定逐点一致、`concurrent_modification` 独立结构化透出且不计入 already-materialized、host-runtime barrel 显式导出白名单）。规范性条文见 TECH 文档「Round 4 implementation amendment」（R4-1 至 R4-10），代码已落地并经真实持久化生产路径回归验证。
    2. **D1/D3/D4/D5/D6 逐项核对**：全部已实施且无偏差；D6 涉及的 `executeSelectedInternalizationTask` 导出边界本轮收紧为白名单制（详见 TECH 文档核对表）。
    3. **待 Owner 决策**：(a) RuleHost 时间戳任务 id 是否远期收敛为确定性 id（当前工程结论：无必要）；(b) 本修正案整体批准。未经 Owner 批准，Draft 状态不变。
  - **v0.9（PR #2763 第七轮独立复核修订）**：
    1. **修正 §2.3 消费者描述**：v0.8 已将桶消费者收紧为仅 `pd-cli`，§2.3 残留 "pd-cli/host-runtime" 旧表述，统一为 `pd-cli`（`diagnose.ts`/`candidate.ts`）。
    2. **闭环 `diagnose` 拒绝结果终端可观察性**：核实 `diagnose.ts` TTY 输出循环（`:1049-1079`）无 `status:'refused'` 分支，且全候选被拒时 `internalizeNextAction` 落到 `'No candidates were generated from this diagnosis.'` 误报——要求 TTY 输出 `DREAMER SEED REFUSED` + 结构化 `reason`，全部被拒时 `nextAction` 明确报告拒绝原因（不误报"未生成候选"），补 TTY 回归测试。
    3. **跨文档 Complexity Delta 同步**：跨包导出 3→4（第 4 个是既有 `validateRecommendationKind` 入桶非新抽象）须同步至 Linear `PRI-1289` 与 PR 描述 §5；修正 PR Review Convergence 中第五轮误标 `v0.8` 为 `v0.7`。
  - **v0.8（PR #2763 第六轮独立复核修订）**：
    1. **闭环 `diagnose` 拒绝结果与 `nextAction`**：核实 `diagnose.ts:975-976` 的 `internalizableCandidateIds` 仅排除 `reviewRequired`/`seedSuppressed`/`admissionRefused` 三类，seed 闸新增的 `status:'refused'` 记录不在排除集内——被拒候选仍会在 `nextAction`/控制台（`:1107` `parkedResults` 仅过滤 `review_required`）收到 `pd candidate internalize` 指令。Phase 1B 必须新增 `seedRefusedIds` 排除集（两条输出路径同步）、`intakeResults` 类型扩展结构化 `reason` 字段、JSON 回归测试断言 `consumed`+`refused` 共存且被拒候选不出现于 `nextAction`。
    2. **收紧 Validator 消费者范围**：`@principles/core/runtime` 桶导出的实际消费者仅为 `pd-cli`（`diagnose.ts`、`candidate.ts`）；`PainSignalBridge` 在 core 内模块内部导入不计桶消费者；`host-runtime` 无 `validateRecommendationKind` 调用点（`internalization-consumer-cycle.ts` 已直接传 `rawRecommendationKind`），不得为凑名单列入 `export-admissions.json`。
  - **v0.7（PR #2763 第五轮独立复核修订）**：
    1. **补跨包 Validator 导出契约（实施阻塞）**：`validateRecommendationKind` 已存在于 `recommendation-kind-resolver.ts` 但 `runtime/index.ts:268` 仅导出 `isPrincipleLedgerEligibleKind`，`pd-cli`/`host-runtime` 经 `@principles/core/runtime` 桶无法调用——Phase 1B 须先从桶正式导出该既有纯函数（同步 `runtime-barrel-surface.json`/`export-surface-baseline.json`/`export-admissions.json`，Complexity Delta 跨包导出 3→4）；**禁止** pd-cli 复制 `VALID_RECOMMENDATION_KINDS` 白名单或深导入 core 内部路径；`isPrincipleLedgerEligibleKind` 不可替代（只判 `principle`）。
    2. **Phase 1A 红灯清单补两入口零播种测试**：`PainSignalBridge` 与 `diagnose` 各补非法/缺失 `rawRecommendationKind` 零 Dreamer 用例与合法 `rule`/`prompt` 路由不变用例，必须先红后绿（既有 `candidate-seed-suppression.test.ts` 夹具将 raw 与 normalized 设同值，不覆盖本缺陷）。
    3. **明确 `diagnose` 结构化拒绝表达**：seed 闸拒绝以**新增** `intakeResults` 记录（参照 `dreamer_seed_suppressed` 模式，`status: 'refused'`+`reason:'candidate_kind_invalid'`）表达，**不覆盖**既有 `'consumed'` + `ledgerWriteRefused` 记录，保住既有 CLI/批处理语义。
  - **v0.6（PR #2763 第四轮独立复核修订）**：
    1. **两自动入口归一化 kind 隐患升级为 Phase 1B 强制项**：核实 `diagnose.ts` 存在真实执行窗口——Intake 拒绝（非异常）路径仍记录 `status: 'consumed'`（附 `ledgerWriteRefused`），而 Dreamer seed 循环仅以 `status === 'consumed'` 为闸且用归一化 `candidate.recommendationKind` 做身份解析与路由，被 Intake 拒绝的非法原始 kind 可经 `'principle'` 折叠完成播种；`pain-signal-bridge.ts:1766/1792` 同类。两入口修正（`rawRecommendationKind` + `validateRecommendationKind`、非法零播种、保留合法 `rule`/`prompt` 路由、双入口零播种测试）由"实施期可选"升为 `PRI-1291` 强制验收；`admissionDoc.ok` 折叠写法维持可选项。
    2. **Phase 0 阈值校准条款**：≤5s / ≤60s 为建议值未经实证校准；校准完成前超窗缺失报告为 `skew_window_candidate`（标注阈值未校准），不判定确定流失。
    3. **`stageWalSnapshot` 改造约束**：当前生产实现为私有函数返回 `{ ok: true, root }`；`dispose()` 改造必须保留 `ok` 成败判别语义。
  - **v0.5（PR #2763 第三轮独立复核修订）**：
    1. **修正 D4 候选类型数据源**：`candidate.recommendationKind` 是 `candidate-store.ts` 明文标注的 fail-open 归一化读视图（非法值折叠为 `'principle'`，"DO NOT use this field for write-boundary decisions"），改用原始持久化字段 `candidate.rawRecommendationKind`——非法 kind 才能被 `resolveCandidatePrincipleIdentity` 正确判为 `candidate_kind_invalid` fail-closed，`rule` 放行亦以验证后的原始类型为准；同时登记 `pain-signal-bridge.ts:1766` 与 `diagnose.ts` 现存传归一化 kind 的同类隐患为实施期可选修复。
    2. **修正 Phase 0 数据库路径**：`state.db` 真实位置为 `.pd/state.db`（`PD_CONFIG='.pd'`，`storage-paths.ts:48`），非 `.state/state.db`；脚本复用 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath`，不硬编码路径。
    3. **细化 Phase 0 偏斜窗口语义**：`capturedAt` 对应 T1 线性化点；快照偏差与跨库写入允许延迟分别定义；跨库关联缺失以**记录自身时间戳 vs 对方快照 T1** 判定；窗口内数据可延迟复查；`dispose()` 前必须先关闭所有 SQLite 连接（Windows 文件占用）。
    4. **补齐 Phase 3 根全盲边界**：根 `dreamer` 三个身份来源（`taskId`、`diagnosticJson`、自身 `correlationId`）全部无法佐证时，仅后代携带的 `correlationId` 不得采纳，fail-closed；测试矩阵 11→12 场景。
  - **v0.4（PR #2763 第二轮独立复核修订）**：
    1. **补齐 D1 类型联合的调用方条件构造要求**：`pain-record.ts:450` 的 `asyncMode` 是运行时 `boolean`，无法直接满足 `asyncMode: true | (asyncMode?: false)` 可辨识联合；明确各构造点必须用条件对象字面量分支构造（同步分支以字面量 `false` 收窄并强制携带 `trajectoryTurnReader` + `sourceMaterialAuthorization`），禁止用类型断言掩盖依赖缺失。
    2. **加固 Phase 3 根身份双源交叉校验与悬空父引用**：`candidateIdFromDreamerSeed(diagnosticJson)` 与 `candidateIdFromDreamerTaskId(taskId)` 是两个独立持久化事实，`??` 链只信前者会放过 `taskId=A / seed=B` 的冲突根；改为双源必须一致才可采纳（`A+A` 通过、`A+B` 拒绝、单边缺失用单边、双缺失拒绝）；子任务有 `correlationId` 但 `parentTaskId` 悬空（`getTask` 返回 `null`）时 fail-closed。测试矩阵由 7 个扩至 11 个场景。
    3. **修正 D4 门禁执行顺序与 `ok:false` fail-closed**：`getAdmissionDocument` 的 `{ ok: false }` 按 `candidate-store.ts` 契约**不得**折叠为“无文档”；门禁读取遇 `ok:false` 一律 `refused`（优先复用 `enforceFullAdmissionForWrite` 已验证的文档快照避免二次读取）；同时把 `findExistingDreamerTask` 去重明确前移到身份门禁之前（已存在任务返回 `existing`，不被账本身份变化误报为拒绝）。
    4. **明确 Phase 0 双库快照非原子性与受控清理接口**：`stageWalSnapshot` 每次只处理单个数据库，`state.db` 与 `trajectory.db` 两次调用不构成跨库原子快照；要求记录各自快照时间与指纹、限定两快照最大时间偏差、跨库关联缺失按时间窗口判定而非直接记为断线；清理能力改为快照 API 返回的受控 `dispose()` 闭包，不导出通用目录删除函数 `removeStagingRoot`。
  - **v0.3（PR #2763 独立技术评审修订）**：
    1. **撤销原 D3 误诊**：核实 `resolveExecutionTiming()` 已提供默认 `leaseTtlMs = 120_000`、`heartbeatIntervalMs = 40_000`，`BasePeerRunner` 与 `SplitDiagnosticianRunner` 在未显式传参时均已启动 `LeaseHeartbeat`；现存确认断线修正为 **3 项（D1、D2、D4）**，`createDiagnosticianRunnerBundle` 保留但定位为消除重复装配与防协作者漂移。
    2. **补全 D1 全仓 5 处 `PainToPrincipleService` 构造点盘点**：补入 v0.2 遗漏的同步入口 `packages/openclaw-plugin/src/commands/pain.ts:333`；同步模式在类型层要求显式注入授权与轨迹依赖，并将 `new PainToPrincipleService(` 纳入架构回归守卫。
    3. **修正 D2 测试入口幻觉**：移除当前 CLI 不存在的 `--deviated-principle` 表述，改为覆盖真实的 `evaluatePainIngress({ painType: 'principle_deviation', deviationAnchor })` 与历史仅含 `deviationAnchor` 的任务恢复。
    4. **重构 D4 账本门禁与 `nextAction`**：正式确定采用**严格拒绝**策略；修正 `nextAction` 为真实 CLI 签名 `pd candidate intake --candidate-id <id> --workspace "<path>"`（无 `--confirm`）；门禁移至可内化路由判定之后，改用单次文件快照权威 `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression`，同时保留 `rule` 候选先跑 Dreamer/Philosopher、在 `ScribeRunner` 预检等待 `owner_rule_binding` 的既有生产语义，并拦截 `principle_reuse` 候选重复播种。
    5. **重设计 Phase 3 血缘收紧**：严格限定于 `PeerRunnerKind` 内化阶段（绝不套用到 `DiagnosticianStageKind` 子任务）；改为带 `getTask` 的有界父链回溯校验器，同时满足父子一致性校验与历史无 `correlationId` 在途后代链恢复。
    6. **加固 Phase 0 快照与 Phase 1 测试包边界**：Phase 0 复用 `pain-recall-read-model.ts` 的 `stageWalSnapshot`（WAL 双文件前后指纹校验暂存快照），消除裸拷贝竞争风险；Phase 1 探针测试按单向包依赖拆分为 `host-runtime`（分 `prompt` 与 `code_tool_hook` 两文件）、`pd-cli`、`openclaw-plugin` 三层；统一 Complexity Delta（3 个跨包内部导出函数）并同步基线至 `origin/main@679dcc93f`。
  - **v0.2（对抗式自审修订）**：修正 `runtimeKind` / `hostKind` 混淆；按 P2.1 删除 `createPipelineRuntime` 大门面；用探针值端到端测试替代静态字段清单；删除 `PITaskMetadata` 三分组重排。
- **范围**：Pain → 诊断 → 候选准入与账本入库 → 内化 → 激活 → 注入/拦截 → 行为证据 这条核心链路的协作者装配、跨跳数据连通性与有效性闭环
- **事实基线**：`origin/main@679dcc93f`。§3 的全部数字与代码锚点均在该基线上实测，复跑命令见附录 A。
- **配套技术设计**：[SPEC-PD-PIPELINE-SPINE-001 — 配套技术设计与实施方案（v0.12）](./SPEC-PD-PIPELINE-SPINE-001-TECHNICAL-DESIGN.md)
- **不改变**：Pain 语义、诊断/内化业务规则、Owner 审批权、任务状态机（`MVP_CORE_LOOP_CONTRACT` INV-01..08）、物理数据库布局、Workspace 数据归属
- **关联**：
  - `docs/architecture/MVP_CORE_LOOP_CONTRACT.md`（语义基线，本 SPEC 不修改）
  - `docs/plans/2026-11-10-architecture-complexity-remediation-plan.md`（存储端口 / 配置 / 判定原因；本 SPEC 不重复）
  - `docs/architecture/principle-identity-reconciliation.md`（I2/I3 已落地，本 SPEC 堵住 `candidate internalize` 旁路并收紧内化后继血缘）
  - `docs/specs/SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001-v1.0.md`（租约与心跳默认契约已生效，本 SPEC 收编绕过工厂的 CLI 重复装配）
  - `docs/specs/SPEC-PD-SERVICE-HOST-001.md`（后台生命周期调度；Phase 2–4 已合入 `pd-cli/src/services/service-host/`，本 SPEC 不触碰调度所有权）

> **一句话结论**
>
> PD 核心管道的业务阶段、序列化器、默认租约心跳与身份盖章主体都已存在；真正让维护困难、让断线反复发生的，是**各入口各自拼装可选协作者**、**3 个 CLI 命令绕过共享组装手搓 Runner**、以及**缺少按生产组合根分层的探针值端到端测试**。本 SPEC 不新建顶层门面、不重排表结构，通过“WAL 安全漏斗基线 → 分层探针测试先红 → 修复已核实的 3 处现存断线（D1/D2/D4）→ 收口协作者与手搓入口 → 收紧内化链血缘”使主干可机械验证。

---

## 1. 背景与问题

Owner 当前面临两个核心痛点：

1. **改动成本高**：从痛苦信号采集、诊断、原则生成、RuleCode 对抗验证到激活与适应性检查，链路跨包多、入口多、开关多，改一处要翻十几个文件。
2. **连通性无把握**：无法确定管道各跳之间还有没有“写了没读”或“某条入口漏传依赖导致静默降级”的数据和字段。

仓库历史证明第 2 点无法靠人工审计根治：`docs/audit` 与 `docs/reports` 已积累百余份审计报告，PRI-835（formation context 未进提示）、PRI-1265（CLI/worker 漏传 `trajectoryTurnReader`）、配置字段被校验器漏拷等事故，本质都是同一类结构问题——**协作者与跨跳字段靠各入口自觉传递，漏传时降级为“看似正常运行”**。

---

## 2. 目标、非目标与 Complexity Delta

### 2.1 目标

| ID | 目标 | 可验证的验收结果 |
|---|---|---|
| G1 | “有没有漏接字段/依赖”由 CI 自动回答 | 分层探针测试（`host-runtime` 双渠道主干 + `pd-cli` 命令入口 + `openclaw-plugin` hook/command 双入口）覆盖真实生产组合根；任一必达探针未进入下游模型请求体或落库记录，CI 立即变红 |
| G2 | 止住当前已核实的 3 处真实断线 | §3.2 的 D1、D2、D4 全部先红后绿修复 |
| G3 | 宿主协作者只在一处组装，同步路径编译期防漏 | `host-runtime` 提供单一 `resolveWorkspacePipelineHostDeps`（5 字段全必填）；`PainToPrincipleService` 同步路径要求显式传入授权与轨迹依赖；全仓构造点由架构回归测试守卫 |
| G4 | 消除生产代码中的野生 Runner 组装 | `diagnose.ts`、`pain-retry.ts`、`runtime-internalization-run-once.ts` 不再手搓 Runner；CI 守卫锁死构造点白名单 |
| G5 | 消除跨跳双轨字段与无身份/重复播种旁路 | `deviationAnchor` 收敛到单一 `anchor`；`pd candidate internalize` 接入 `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression`；内化链（`PeerRunnerKind`）后继强制校验父链 `correlationId` 一致性 |
| G6 | 闭合“原则是否有效”的观测回路（远期门控） | 每条已激活原则一个只读派生读模型：注入次数、遵循/偏离证据数、激活后同锚点 Pain 复发数（证据不足报 `insufficient_evidence`） |

### 2.2 非目标

- 不重写管道，不新增业务阶段，不新增顶层门面类（复用 `PainToPrincipleService`、`createPainSignalBridge`、`runPendingDiagnosticianOnce`、`runInternalizationConsumerCycle`）。
- 不把 `PITaskMetadata` 的 28 个字段拆成嵌套子对象（`serializePITaskMetadata` 与 `mergePITaskMetadata` 已集中收口，改形状只制造测试夹具噪音）。
- 不新增 CLI 命令行参数（例如不为 D2 额外发明 `--deviated-principle`）。
- 不合并 `state.db` 与 `trajectory.db`，不做存量物理表迁移。
- 不按行数拆大文件（如 `evaluator-runner.ts` 4104 行）。
- 不新增特性开关（`mvp-q-3-how-disabled`）。
- 不重复 11-10 整改计划已覆盖的存储端口、配置校验与 UI 校验器生成化。

### 2.3 Complexity Delta（AGENTS §13）

> 注：提交本 SPEC 的文档 PR（#2763）自身运行时 Complexity Delta 全项为 `NO`。下表评估的是**按本 SPEC 全量落地 Phase 0–3 后的目标系统复杂度变化**。

```text
Complexity Delta (Target Architecture across Phase 0–3)

New durable source of truth: NO
New persisted schema/state: NO
New subsystem/service/background process: NO
New public abstraction/interface: YES (4 internal cross-package exports:
  1. `@principles/host-runtime`: `resolveWorkspacePipelineHostDeps`
  2. `@principles/host-runtime`: `executeSelectedInternalizationTask`
  3. `@principles/core/runtime`: `createDiagnosticianRunnerBundle`
  4. `@principles/core/runtime`: `validateRecommendationKind`（既有纯函数公开导出，
     非新抽象——供 pd-cli（`diagnose.ts`/`candidate.ts`）的 D4/seed 闸经正式包接口调用）
  plus reusing existing WAL snapshot logic via exported read-only helper for Phase 0;
  net removes 3 hand-rolled Runner assembly switches and 8 ad-hoc collaborator wiring blocks)
New runtime feature flag: NO
New cross-package dependency: NO (`pd-cli`, `openclaw-plugin`, `codex-adapter`, `workbuddy-adapter` already depend on `@principles/host-runtime` and `@principles/core`)
New host/platform-specific behavior: NO
New external/network capability: NO
```

对唯一一项 `YES` 的必要性说明：
1. **`resolveWorkspacePipelineHostDeps`**：把 5 个宿主协作者按同一 `workspaceDir` 与同一 `sourceMaterialAuthorization` 实例打包为全必填返回结构，替代 8 处分散拼装（已造成 PRI-1230/1233、PRI-1265 与本次 D1）。
2. **`createDiagnosticianRunnerBundle`**：从 `createPainSignalBridge` 内部原位抽出**不写 `bridgeCache`** 的诊断 Runner 组装器，供缓存版 Bridge 与带 `--runtime test-double` / `--no-intake` 覆盖需求的 `diagnose.ts`、`pain-retry.ts` 共用，删除约 100 行重复 Runner 构造且不污染进程级缓存。
3. **`executeSelectedInternalizationTask`**：从 `runInternalizationConsumerCycle` 内部原位抽出单步 Peer Runner 执行器，供后台周期与 `runtime-internalization-run-once.ts` 共用，删除 CLI 中约 135 行 6 分支 Runner switch。

---

## 3. 当前事实（`origin/main@679dcc93f` 实测）

### 3.1 装配面全量盘点

1. **`new PainToPrincipleService(` 全仓共 5 处生产调用点**：
   - **同步可达路径（3 处，执行诊断，必须具备完整宿主协作者）**：
     1. `packages/pd-cli/src/commands/pain-record.ts:452`（`--wait` 或 `diagnostician_async_cli=false` 时同步执行；当前漏 `trajectoryTurnReader`、`sourceMaterialAuthorization`）
     2. `packages/openclaw-plugin/src/hooks/pain.ts:57`（`diagnostician_async_hook=false` 时同步执行；当前已传进程内 `trajectoryTurnReader`，漏 `sourceMaterialAuthorization`、`telemetrySink`）
     3. `packages/openclaw-plugin/src/commands/pain.ts:333`（未传 `asyncMode`，**恒为同步执行**；当前漏 `trajectoryTurnReader`、`sourceMaterialAuthorization`、`telemetrySink`）
   - **纯异步落库路径（2 处，`asyncMode: true` 仅写 `tasks` 表，不构造 `SqliteContextAssembler`）**：
     4. `packages/host-runtime/src/governance-signal-admission.ts:2589`（治理信号恢复入库）
     5. `packages/principles-core/src/runtime/pain-submit-capability.ts:620`（MCP 提交入库，位于 `core` 内，不依赖 `host-runtime`）
2. **后台与 CLI 诊断执行点**：
   - 共享工厂：`packages/principles-core/src/runtime/pain-signal-runtime-factory.ts:808-835`（被 `diagnostician-auto-run.ts`、`codex` worker 2 处、`workbuddy` worker、`PainToPrincipleService` 同步路径调用）。
   - 绕过工厂的手搓 CLI：`packages/pd-cli/src/commands/diagnose.ts:557-584`、`packages/pd-cli/src/commands/pain-retry.ts:695-725`（另有 2 个实验 runner：`synthetic-baseline-runner.ts`、`pain-flood-simulation-runner.ts`）。
3. **内化单轮消费点**：
   - 权威入口：`packages/host-runtime/src/internalization-consumer-cycle.ts:941-1068`。
   - 重复手搓点：`packages/pd-cli/src/commands/runtime-internalization-run-once.ts:720-855`（6 分支手搓 Runner）；另有显式同步对抗算子 `packages/pd-cli/src/services/rulehost-pipeline-runner.ts:338-508`。

### 3.2 本次源码核查确认的 3 个现存断线缺陷（及 1 项已撤销误诊）

| ID | 状态 | 位置 | 事实证据 | 实际影响 |
|---|---|---|---|---|
| **D1** | **已确认（P1）** | `pain-to-principle-service.ts:42-78, 276-290`；`pain-record.ts:452`；`openclaw-plugin/src/hooks/pain.ts:57`；`openclaw-plugin/src/commands/pain.ts:333` | `PainToPrincipleServiceOptions` 未声明 PRI-1283 R2 的 `sourceMaterialAuthorization`，调 `createPainSignalBridge` 时未传（默认回退 `denyAllSourceMaterialAuthorization`）；同时 `pain-record.ts`（`--wait`）与 `openclaw-plugin/src/commands/pain.ts`（恒同步）均未传 `trajectoryTurnReader` | 经 `PainToPrincipleService` 同步跑诊断的 3 条入口会把已获授权的 `governance_observation:` 证据按“未授权”过滤；`pain record --wait` 与 OpenClaw `/pd` 命令绑定的会话原文无法进入诊断 |
| **D2** | **已确认（P2）** | 写：`pain-ingress.ts:141`、`pain-signal-bridge.ts:484`；读：`sqlite-context-assembler.ts:663-684` | MCP 提交（`pain-submit-capability.ts:583-592`）同时写 `anchor` 与 `deviationAnchor`；但 `evaluatePainIngress` 的 `buildLegacy`（`pain-ingress.ts:141`）在 `painType === 'principle_deviation'` 时只写 `deviationAnchor`，而 `reconstructDiagnosticianRecord` 只读 `parsed.anchor` | 经 `pain-ingress` 提交的原则偏离信号及历史仅含 `deviationAnchor` 的任务无法在 Stage A 恢复原则锚点 |
| ~~**D3**~~ | **v0.3 已撤销（误诊）** | `execution-timing.ts:49-54`、`base-peer-runner.ts:133`、`split-diagnostician-runner.ts:244` | v0.2 误认为 `diagnose.ts` / `pain-retry.ts` 未显式传 `leaseTtlMs` 会退回无心跳状态；核实 `resolveExecutionTiming()` 默认即提供 `120_000ms` 租约与 `40_000ms` 心跳，子阶段与父任务均已自动启动 `LeaseHeartbeat` | 无现存心跳缺失故障；两个 CLI 的手搓 Runner 归入 Phase 2A 纯架构去重收编 |
| **D4** | **已确认（P1）** | `pd-cli/src/commands/candidate.ts:394-524` | PRI-1267 已为 `handleCandidateInternalize` 补上准入检查，但它既未调用 `resolveCandidatePrincipleIdentity` 校验账本身份（对 `--no-intake` 留下的未入账本 `principle` 候选仍直接创建 `dreamer` 任务），也未接入同文件其他子命令已有的 `evaluateDreamerSeedSuppression`（对已复用 `principle_reuse` 或待 Owner 裁决候选仍会重复创建 `dreamer` 任务） | 未入账本 `principle` 候选空耗多轮 LLM 后在激活边界失败；已复用既有原则或待 Owner 裁决的候选通过该命令会被重复播种 |

### 3.3 已就位、无需重造的机制（防止过度设计）

1. **WAL 安全只读暂存快照已就位**：`pain-recall-read-model.ts:475-529` 的 `stageWalSnapshot` 已实现 `main + -wal` 双文件 T0/T1（`main → wal → main` 线性化点）SHA-256 指纹校验暂存拷贝，并有 `pain-recall-readonly.test.ts` 全套竞态注入测试保护，Phase 0 直接复用。
2. **元数据序列化已集中**：`pitask-metadata.ts:778-857` 的 `serializePITaskMetadata` 与 `mergePITaskMetadata` 已统一管理全部 28 个字段（其中 23 个可选）。
3. **账本身份单快照权威与播种抑制已就位**：`PrincipleTreeLedgerAdapter.resolveCandidatePrincipleIdentity`（`principle-tree-ledger-adapter.ts:145-190`）与 `evaluateDreamerSeedSuppression`（`candidate-seed-suppression.ts:39-77`）已在 `PainSignalBridge` 与 `diagnose.ts` 上线，D4 直接复用，绝不另写 `isAvailable() + listForCandidate()` 双读逻辑。
4. **Scribe 身份预检与盖章已就位**：`ScribeRunner`（`scribe-runner.ts:232-278, 695-744`）对 `rule` 候选在生成前执行 `preflight_before_generation`（未绑定时停靠 `needs_human_review / awaiting_owner_binding`，0 次模型调用），对 `principle` 候选执行 I2 链式盖章与 `ledger-identity.ts` 激活边界校验。
5. **规模与开关基线**：特性开关注册 55 个（`feature-flag-contract.ts`）；`internalization/` 非测试源码 94 个文件；建表定义 44 张唯一表；引用原则账本的非测试源码 77 个文件。

---

## 4. 架构设计

### 4.1 四项收敛原则

| # | 原则 | 具体做法 |
|---|---|---|
| C1 | **按真实包边界分层探针先行** | 不维护脱离代码的静态字段表，也不跨包反向引用测试；按 `host-runtime`、`pd-cli`、`openclaw-plugin` 三层真实生产入口注入非默认探针值，在假模型请求体与落盘记录上直接断言 |
| C2 | **补齐既有门面，同步路径类型防漏** | 写入与同步诊断走 `PainToPrincipleService`（同步模式类型级要求授权与轨迹依赖）；后台周期走 `runPendingDiagnosticianOnce` 与 `runInternalizationConsumerCycle`；宿主协作者统一由 `resolveWorkspacePipelineHostDeps` 全必填打包 |
| C3 | **复用单一身份与抑制权威** | 锚点统一为 `anchor`（读侧兼容历史 `deviationAnchor`）；`candidate internalize` 直接复用 `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression`，严格与 `PainSignalBridge` / `diagnose.ts` 播种语义对齐 |
| C4 | **内化血缘有界回溯、隔离诊断子链** | `correlationId = candidateId` 严格限定为 `PeerRunnerKind` 内化任务不变量（不触碰 `DiagnosticianStageKind`），通过有界父链回溯校验父子一致性并兼容历史在途链 |

### 4.2 宿主协作者单一打包与同步入口类型约束（消除漏传）

1. 在 `@principles/host-runtime` 提供唯一协作者构造函数 `resolveWorkspacePipelineHostDeps`（返回对象的 `intentDocReader`、`trajectoryTurnReader`、`sourceMaterialAuthorization`、`telemetrySink`、`isAutoPainSubmissionAuthorized` **5 个属性全部必填、无 `?`**，且内部保证默认 `trajectoryTurnReader` 与返回给调用方的 `sourceMaterialAuthorization` 绑定同一授权实例）。
2. **`PainToPrincipleServiceOptions` 区分同步与异步契约**：
   - 当 `asyncMode: true` 时：仅持久化待诊断任务，`trajectoryTurnReader` 与 `sourceMaterialAuthorization` 可选；
   - 当同步模式（`asyncMode?: false`）时：`sourceMaterialAuthorization` 与 `trajectoryTurnReader` 在生产构造接口上设为**必填**（单测辅助构造可显式传入 `denyAllSourceMaterialAuthorization` 或空读取器，禁止生产代码用 `undefined` 隐式滑落）；
   - **调用方条件构造硬约束**：运行期算出的 `asyncMode: boolean`（如 `pain-record.ts:450` 的 `asyncFlagEnabled && !opts.wait`）不能直接传给该联合类型——必须分支构造两个对象字面量：异步分支 `{...base, asyncMode: true as const}`；同步分支 `{...base, asyncMode: false as const, trajectoryTurnReader, sourceMaterialAuthorization}`。禁止用类型断言绕过必填检查。
3. **OpenClaw 插件双入口收口**：`openclaw-plugin/src/hooks/pain.ts` 与 `openclaw-plugin/src/commands/pain.ts` 共用同一个插件内工厂函数 `createPluginPainToPrincipleService(wctx)`，内部统一调用 `resolveWorkspacePipelineHostDeps`（以 `wctx.trajectory` 作为 `trajectoryTurnReaderOverride`），消除两处配置不一致。
4. `hostKind` 保持按真实来源可选传入（`GovernanceHostKind | undefined`）：无会话手动 CLI 录入合法状态即为 `undefined`，绝不伪造（`rc-9`）。

### 4.3 收编 3 个手搓 Runner 的 CLI 入口

1. **`pd diagnose` 与 `pd pain retry`**：从 `pain-signal-runtime-factory.ts` 抽出**不进 `bridgeCache`** 的 `createDiagnosticianRunnerBundle`，明确资源所有权契约（外部传入 `stateManager` 时 `dispose()` 绝不重复关闭连接；内部自建时负责关闭），收编两个 CLI 中约 100 行手搓 `Diag*Runner + SplitDiagnosticianRunner` 代码，完整保留 `--no-intake`、`--runtime test-double` 与死信重放语义。
2. **`pd runtime internalization run-once`**：从 `host-runtime/src/internalization-consumer-cycle.ts` 抽出 `executeSelectedInternalizationTask(...)`，收编 CLI 中 6 分支 Runner switch，并补齐 6 种 Runner（尤其 `ArtificerRunner` 的宿主工具目录、语义注册表、`trustedFacts`、`artificerEvidence`）的行为等价测试。
3. **全仓构造点架构守卫**：在 `architecture-regression.test.ts` 同时守卫 `new *Runner(`、`new PainSignalBridge(` 与 **`new PainToPrincipleService(`** 的全部生产文件白名单；未列入白名单的新入口在 CI 直接失败。

### 4.4 单轨字段、权威身份播种门禁与内化父链血缘

1. **`deviationAnchor` 收敛为 `anchor`（修 D2）**：
   - 写侧（`pain-ingress.ts`、`pain-signal-bridge.ts`）：当存在合法 `deviationAnchor` 时，同步经 `deviationAnchorToPainAnchor` 产出规范 `anchor: { type: 'established_principle', ref: '<id>@<ver>' }`。
   - 读侧（`SqliteContextAssembler.reconstructDiagnosticianRecord`）：当 `parsed.anchor` 缺失且存在 `deviationAnchor` 时兼容还原；格式非法时写入 `ambiguityNotes`（`rc-9`）。
2. **`handleCandidateInternalize` 权威身份与抑制门禁（修 D4，采用严格拒绝策略）**：
   - 门禁置于准入检查与 `decideInternalizationRoute` / 可生成 Dreamer seed 判定**之后**、`findExistingDreamerTask` 既有任务去重**之后**、`createTask` **之前**。去重必须先于身份门禁执行：已存在 `dreamer` 任务的候选一律返回既有 `status: 'existing'`（账本后续身份变化不得把存量任务误报为拒绝）；`defer` / `implementation` 等本来不可内化的候选维持既有 `no_task_created` 返回。
   - **Admission 文档 `ok:false` fail-closed**：按 `candidate-store.ts` 契约，`{ ok: false }` 是损坏/不可读文档，**不得**折叠为“无历史文档”。优先复用 `enforceFullAdmissionForWrite` 已验证的文档快照避免二次读取；若必须二次读取，遇 `ok:false` 一律结构化 `refused`（`admission_document_unreadable`），绝不放行。
   - 单次快照调用 `identity = ledgerAdapter.resolveCandidatePrincipleIdentity(candidateId, candidate.rawRecommendationKind)`——**必须传原始持久化字段**（`recommendationKind` 是 fail-open 归一化读视图，非法值折叠为 `'principle'` 会绕过 `candidate_kind_invalid`；`candidate-store.ts` 明文禁止用于写边界判定），并调用 `evaluateDreamerSeedSuppression({ identity, processing, pendingOwnerDecision })`：
     - 若命中抑制（`reuse_resolved_to_existing_principle` / `reuse_park_pending_owner` / `owner_decision_pending`）：结构化 `refused` 并给出对应 `nextAction`，禁止重复创建 Dreamer 任务；
     - 若 `identity.status === 'unresolved'`：
       - `ledger_unavailable` / `ledger_corrupt` / `ambiguous` / `conflicting_authorities` / `binding_revoked` / `target_missing` / `target_ineligible` / `candidate_kind_invalid` → 一律 fail-closed `refused`；
       - `reason === 'candidate_kind_invalid'`（原始 `rawRecommendationKind` 非法，已被归一化视图掩盖）→ 与其他 `unresolved` 原因一致 fail-closed 拒绝；
       - `reason === 'missing'` 且原始 `rawRecommendationKind` 不是 `'rule'`（例如 `--no-intake` 留下的 `principle` 候选）→ **严格拒绝**（不做隐式账本写入），返回 `reason: 'candidate_not_in_ledger'` 与真实可执行命令：`pd candidate intake --candidate-id <id> --workspace "<workspaceDir>"`；
       - `reason === 'missing'` 且原始 `rawRecommendationKind === 'rule'` → 与 `PainSignalBridge` / `diagnose.ts` 自动主干保持一致，允许创建 `dreamer` 任务，由下游 `ScribeRunner` 预检停靠 `awaiting_owner_binding` 等待 Owner 绑定。
3. **内化链 `correlationId` 父子一致性与历史恢复（Phase 3）**：
   - **作用域隔离**：严格限定在 `isPeerRunnerKind(taskKind)` 内化任务（`dreamer → philosopher → scribe → artificer → evaluator → rollout_reviewer` 及其修订/修复循环）；**`DiagnosticianStageKind`（`diag_rootcause → diag_distiller → diag_router`）保持既有 `parentTaskId + dependencyTaskIds` 机制，绝不套用 `correlationId` 门禁**。
   - **有界父链回溯校验**：通过 `resolveAuthoritativeCorrelationId(piTask, getTask)` 沿 `parentTaskId` 有界向上回溯（上限 10 跳，带环检测）：
     - **悬空父引用 fail-closed**：回溯中任一节点声明了 `parentTaskId` 但 `getTask(parentTaskId)` 返回 `null`，即使该节点自身带 `correlationId` 也一律拒绝——父链已断，无法证明血缘来源；
     - 若链上任意父子节点的非空 `correlationId` 互相冲突（如父为 `cand-A`、子为 `cand-B`），立即返回 `conflict` 并 fail-closed 拒绝生成后继；
     - **根身份双源交叉校验**：根 `dreamer` 任务的 `candidateIdFromDreamerTaskId(taskId)` 与 `candidateIdFromDreamerSeed(diagnosticJson)` 是两个独立持久化事实，必须一致才可采纳——`A+A` 通过、`A+B` 返回 `conflict` 拒绝、单边缺失采纳单边、双缺失拒绝；禁止 `??` 链静默偏向其中一个；
     - 若历史在途链（含已走到 `philosopher` / `scribe` 的后代任务）全链未写 `correlationId`，但可沿 `parentTaskId` 唯一追溯到根 `dreamer` 任务并经上述双源交叉校验恢复出 `candidateId`，则采纳该根身份并写入新后继任务；
     - **根全盲佐证要求（v0.5）**：链上唯一非空 `correlationId` 必须获得根侧佐证（`rootSeedId` 一致，或根任务自身携带同一 `correlationId`）；若根 `dreamer` 的 `taskId`、`diagnosticJson` 与自身 `correlationId` 三个身份来源全部无法佐证，仅后代携带的 `correlationId` 不得采纳，fail-closed 拒绝；
     - 无法唯一定位根身份或超出跳数上限时 fail-closed 拒绝（`rc-6`）。

### 4.5 分层 Canary Spine 与入口组合根测试架构（遵守单向包依赖）

为严格遵守 `pd-cli / openclaw-plugin → host-runtime → principles-core` 单向依赖并覆盖真实入口 wiring（EP-02），测试拆分为三层：

1. **Layer A — `packages/host-runtime/tests/` 核心主干端到端探针（2 个独立文件）**：
   - `pipeline-spine-prompt-canary.e2e.test.ts`（轻量常驻主干）：真实临时工作区 SQLite + `resolveWorkspacePipelineHostDeps` + 满足各阶段业务校验器与准入规则的录制型 Fake Runtime Adapter。注入非默认探针包（`CANARY_REASON_9f3a`、`CANARY_OWNER_CORRECTION_7b2c`、`evaluatePainIngress` 产出的 `principle_deviation` 锚点 `P_CANARY_ANCHOR_4d1e@1`、已授权 `codex` 会话原文 `CANARY_TURN_TEXT_8e5f`、`INTENT.md` 的 `CANARY_INTENT_2a6d`），跑穿 `PainToPrincipleService.recordPain`（同步）→ Stage A/B/C → 准入与账本 Intake → `runInternalizationConsumerCycle`（`prompt` 短链）→ 自动激活 → `prompt-injection-projection`；并含**撤回 `codex` 授权负向用例**（断言 `CANARY_TURN_TEXT_8e5f` 消失且 `ambiguityNotes` 含 `consent_revoked`）。
   - `pipeline-spine-rulecode-canary.e2e.test.ts`（高风险渠道集成探针）：覆盖 `code_tool_hook` 全链（Owner 规则绑定 → Scribe → Artificer → Evaluator 沙箱重放 → RolloutReviewer → 审批 → Shadow/Live → `production-rulehost-gate` 拦截回执），断言 `pi_artifacts.source_principle_id`、`activations.target_ref`、`principle_applications.principle_id` 与账本原则 UUID 完全一致。
2. **Layer B — `packages/pd-cli/tests/commands/` CLI 组合根与 D4 门禁测试**：
   - 覆盖真实 CLI 处理器：`pain-record --wait`（证明接入 `trajectoryTurnReader` + `sourceMaterialAuthorization`）、`diagnose`（**v0.7**：含 `rawRecommendationKind` 非法/缺失候选零 Dreamer 红灯用例，先红后绿；拒绝结果以新增 `intakeResults` 记录表达、不覆盖既有 `'consumed'` 记录；**v0.8**：JSON 回归断言 `consumed`+`refused` 共存且被拒候选不出现于 `nextAction`/`internalizableCandidateIds` 与控制台 `internalize` 指令中；**v0.9**：TTY 回归断言 `DREAMER SEED REFUSED` 分支与全拒 `nextAction` 不误报"未生成候选"）、`pain-retry`、`candidate internalize`（证明未入账本 `principle` 候选被严格拒绝、已复用候选被抑制、未绑定 `rule` 候选不被误杀、`defer` 候选维持 `no_task_created`）。
3. **Layer C — `packages/openclaw-plugin/tests/` 插件双入口协作者测试**：
   - 同时覆盖 `src/hooks/pain.ts` 与 `src/commands/pain.ts` 两条入口，验证二者均注入同一工作区 `sourceMaterialAuthorization` 与 `WorkspaceContext.trajectory` 读取器。
4. **Core 侧自动入口红灯单测（v0.7）**：`packages/principles-core` 内为 `PainSignalBridge` 播种路径补 `rawRecommendationKind` 非法/缺失候选**零 Dreamer** 红灯用例与合法 `rule`/`prompt` 路由不变用例（与 `diagnose` 侧 Layer B 用例同属 Phase 1A 先红清单；既有 `candidate-seed-suppression.test.ts` 夹具将 raw 与 normalized 设为同值，不覆盖本缺陷，须用异值夹具）。

---

## 5. 核心跨跳契约核对表（`origin/main@679dcc93f`）

| 跳点 | 关键数据 / 字段 | 权威载体 | 当前状态 |
|---|---|---|---|
| 入口 → 诊断任务 | `sourcePainId`、`provenance`、`hostKind`、`sessionIdHint`、`evidence[]`、`correctionEvidence`、`painIngress`、`recovery` | `tasks.diagnostic_json`（`buildDiagnosticJson`） | **同步路径断线（D1）**：`PainToPrincipleService` 缺 `sourceMaterialAuthorization`，`pain-record --wait` 与 OpenClaw `commands/pain.ts` 缺 `trajectoryTurnReader` + `sourceMaterialAuthorization` |
| 入口 → 诊断上下文 | `anchor` vs `deviationAnchor` | `tasks.diagnostic_json` → `SqliteContextAssembler` | **断线（D2）**：`pain-ingress` 的 `principle_deviation` 仅写 `deviationAnchor`，装配器仅读 `anchor` |
| 诊断执行租约与心跳 | `stageTimeoutMs`、`leaseTtlMs`、`heartbeatIntervalMs` | `resolveExecutionTiming` → `BasePeerRunner` / `SplitDiagnosticianRunner` | **已接通**（默认 120s TTL / 40s 心跳均已生效；CLI 重复 Runner 构造归 Phase 2A 去重） |
| 诊断 → 候选准入 | `recommendation_kind`、`confidence`、`trigger_pattern`、`action`、`admission_json` | `principle_candidates` | **已接通**（PRI-1267 已补齐写入与申领侧准入门） |
| 候选 → 账本/抑制 → 播种 | `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression` | `ledger.json` + `admission_json` + `tasks.diagnostic_json` | **旁路缺口（D4）**：`handleCandidateInternalize` 未接权威身份与复用抑制门 |
| 内化链跨跳血缘 | `correlationId`（= `candidateId`）跨 `PeerRunnerKind` 传递 | `tasks.diagnostic_json`（`PITaskMetadata`） | **待收紧（Phase 3）**：播种已写，需补有界父链一致性校验与历史在途链恢复（隔离 `DiagnosticianStageKind`） |
| 内化 → 激活身份 | `pi_artifacts.source_principle_id` → `activations.target_ref` → `principle_applications.principle_id` | `scribe-runner.ts`（预检 + I2）+ `ledger-identity.ts`（I3） | **已接通** |
| 激活 → 有效性反馈 | 注入回执、RuleHost 拦截、干预证据、同锚点 Pain 复发 | `principle_applications`、`gate_blocks`、`intervention_evidence_records`、`pain_events` | **分散未聚合**（归 Phase 5 只读派生读模型） |

---

## 6. 实施阶段

各阶段按顺序推进；每个阶段独立成小型 PR，按逆序回退。

### Phase 0 — 生产工作区 WAL 安全快照漏斗基线（零生产运行时改动）

- **做什么**：新增只读开发分析脚本 `scripts/dev/pipeline-funnel-snapshot.mjs`，经 canonical `resolveStateDbPath` / `resolveTrajectoryDbPath` 定位两库（`state.db` 在 `.pd/`、`trajectory.db` 在 `.state/`，不硬编码），直接复用 `pain-recall-read-model.ts` 的 `stageWalSnapshot`（对两库及其活跃 `-wal` 执行 T0/T1 双端 SHA-256 指纹校验暂存拷贝到系统临时隔离目录；若检测到并发写入/checkpoint 竞争则拒绝失真快照并安全重试），在暂存副本上统计全量与近 30 天各阶段数量、转化率与失败/拒绝 `reasonCode` 分布。
- **跨库非原子性约束（v0.5 细化语义）**：`stageWalSnapshot` 每次只处理**单个**数据库，`state.db`（`.pd/state.db`）与 `trajectory.db`（`.state/trajectory.db`）是两个独立线性化点。快照 `capturedAt` 一律取该库快照的 **T1 线性化点**；报告必须：① 分别记录两库的 T1 快照时间与文件指纹；② **快照偏差窗口**（两 T1 之差，建议 ≤5s）与**跨库写入允许延迟**（关联写入允许晚于先快照库的时长，建议 ≤60s）分开定义；③ 跨库关联缺失以**现存记录自身时间戳 vs 对方库 T1** 判定——缺失方数据可能尚未落盘的窗口内一律标 `skew_window_candidate`（可延迟复查），超出写入允许延迟才判定为流失。**阈值校准条款（v0.6）**：≤5s / ≤60s 为建议值，尚未有生产写入链路实证依据；校准完成前，报告须逐条记录所依据的表/时间字段与两库 T1，超窗缺失标注"阈值未校准"并按 `skew_window_candidate` 输出，不得直接判定为确定流失。
- **受控清理接口**：不导出通用目录删除能力；`stageWalSnapshot` 返回值携带受控 `dispose()` 闭包负责清理暂存目录；**`dispose()` 前必须先关闭所有 SQLite 连接**（Windows 下未关闭连接会导致临时文件占用、清理失败）。
- **硬边界**：严禁直接打开 `<workspace>/.pd/`、`~/.pd/runtime/` 原位数据库，严禁在源目录产生 `-shm` 副作用（AGENTS §1.1）。
- **产出**：漏斗基线报告落盘至 `docs/reports/`，指导后续瓶颈排序。

### Phase 1A — 分层探针与入口测试落地（先红）

- **做什么**：按 §4.5 建立 `host-runtime`（`prompt` + `code_tool_hook`）、`pd-cli`、`openclaw-plugin` 三层测试，在未改生产代码前精确复现 D1、D2、D4 红灯并留存终端摘要证据。

### Phase 1B — 修复现存 3 处断线（D1 / D2 / D4 转绿）

- **做什么**：
  1. **修 D1**：`PainToPrincipleServiceOptions` 补齐 `sourceMaterialAuthorization` 并按同步/异步模式收紧类型；补齐 `pain-record.ts`、`openclaw-plugin/src/hooks/pain.ts`、`openclaw-plugin/src/commands/pain.ts` 的授权与轨迹读取器接线。
  2. **修 D2**：`context-payload.ts` 增加 `deviationAnchorToPainAnchor`；`pain-ingress.ts` / `pain-signal-bridge.ts` 同步产出规范 `anchor`；`SqliteContextAssembler` 兼容读取历史 `deviationAnchor`（损坏值写入 `ambiguityNotes`）。
  3. **修 D4（含两自动入口，v0.6 强制）**：`handleCandidateInternalize` 在可内化路由判定与**既有任务去重**之后接入 `resolveCandidatePrincipleIdentity` + `evaluateDreamerSeedSuppression`，严格拒绝未入账本 `principle` 候选（正确提示 `pd candidate intake --candidate-id <id> --workspace "<path>"`）与已复用/待裁决候选，保留未绑定 `rule` 候选的合法播种；Admission 文档 `ok:false` 一律 fail-closed。**同步修复两条自动入口的归一化 kind 缺口**：`diagnose.ts` Dreamer seed 循环与 `pain-signal-bridge.ts` 播种路径必须改用 `validateRecommendationKind(candidate.rawRecommendationKind)`——非法原始 kind 一律零播种（fail-closed：`diagnose` 以**新增** `intakeResults` 记录表达结构化 `refused`、`reason: 'candidate_kind_invalid'`，**不覆盖**既有 `'consumed'` + `ledgerWriteRefused` 记录；bridge 发 telemetry），身份解析与放行判定均传原始字段；合法 `rule`/`prompt` 候选路由行为不变；**不得**把所有 Intake 拒绝粗暴改为停止处理（`consumed` + `ledgerWriteRefused` 的账本语义保持，仅在 seed 闸前增加原始 kind 校验）。**跨包接口前置（v0.7）**：`validateRecommendationKind` 须先从 `@principles/core/runtime` 公开桶正式导出（同步 `runtime-barrel-surface.json`/`export-surface-baseline.json`/`export-admissions.json`）——禁止在 pd-cli 复制白名单或深导入 core 内部路径。**消费者范围（v0.8 收紧）**：桶消费者仅 `pd-cli`（`diagnose.ts`、`candidate.ts`）；`PainSignalBridge` 用 core 内模块导入不计桶消费者；`host-runtime` 无调用点不得列入 `export-admissions.json`。**`nextAction` 闭环（v0.8）**：`diagnose.ts` 须新增 `seedRefusedIds` 排除集——`status:'refused'` 候选从 `internalizableCandidateIds`（`diagnose.ts:975-976`）与控制台输出路径（`:1107` `parkedResults`）同步剔除，不得再向其打印 `pd candidate internalize` 指令；`intakeResults` 类型扩展结构化 `reason` 字段。**拒绝可观察性（v0.9）**：TTY 输出循环须新增 `status:'refused'` 分支打印 `DREAMER SEED REFUSED` + 结构化 `reason`；全部候选被拒时 `nextAction` 明确报告拒绝原因与修复指引，**不得**落到 `'No candidates were generated from this diagnosis.'` 误报（`diagnose.ts:987` 尾部分支现状如此）；补 TTY 回归测试。
- **验收**：Phase 1A 三层测试与 CLI 契约测试（`cli-1..cli-7`）全部由红转绿；`diagnose` 与 `PainSignalBridge` 两条自动入口各自增加**非法原始 kind 零播种测试**（`rawRecommendationKind` 为非法值/缺失时不得创建 `dreamer` 任务，合法 `rule`/`prompt` 候选路由不受影响）。

### Phase 2 — 协作者打包、CLI 手搓 Runner 收编与构造点守卫

- **Phase 2A（协作者收口 + 诊断 CLI 收编）**：
  - 落地 `resolveWorkspacePipelineHostDeps`，迁移全部同步 `PainToPrincipleService` 入口与 3 个宿主诊断 worker（共 8 处调用点）；
  - 落地无缓存 `createDiagnosticianRunnerBundle`（严格校验外部 `stateManager` 不重复关闭、自建资源必释放），收编 `diagnose.ts` 与 `pain-retry.ts`。
- **Phase 2B（内化单步执行收编 + 全仓构造点守卫）**：
  - 抽出 `executeSelectedInternalizationTask` 收编 `runtime-internalization-run-once.ts`，补齐 6 种 Peer Runner（含 Artificer 预检与宿主工具语义）等价性测试；
  - 在 `architecture-regression.test.ts` 落地 `new *Runner(`、`new PainSignalBridge(`、`new PainToPrincipleService(` 生产白名单守卫。

### Phase 3 — 内化链 `correlationId` 有界父链校验与历史恢复

- **做什么**：在 `InternalizationOrchestrator` 的 `PeerRunnerKind` 后继提议、提交、Evaluator 修复任务与 `reopenTaskForRevision` 路径接入 `resolveAuthoritativeCorrelationId(piTask, getTask)`，隔离 `DiagnosticianStageKind` 子任务，跑通全部 12 类正负向与历史兼容场景测试（含根任务 `taskId`/`diagnosticJson` 双源冲突、有 `correlationId` 但父任务缺失、父链环、深度 10/11 边界、根全盲仅后代带 `correlationId`）。

### Phase 4 — 开关退役与阶段合并评估（远期门控，须 Owner 逐项拍板）

- **前置条件**：Phase 0 漏斗基线与 Phase 1–3 全部完成（`antipattern-prep-next-phase`）。
- **内容**：4a 清理经 Owner 确认的纯死开关分支；4b 若漏斗证明中段跳数是真实瓶颈，按 `docs/process/PD-LAB-USAGE.md`（AGENTS §25A）完成离线对照实验后方可合并阶段。

### Phase 5 — 原则有效性只读派生读模型（远期门控，独立评审）

- **内容**：聚合 `principle_applications`、`gate_blocks`、`intervention_evidence_records`、`pain_events` 输出只读有效性视图；严格遵守相对评价规范，证据不足一律标 `insufficient_evidence`；若进入 Console 主界面须先经 Owner 批准 MVP-Core 范围。

---

## 7. MVP 契约核对（AGENTS §4）

| ID | 回答 |
|---|---|
| `mvp-q-1-what-if-skip` | D1、D2、D4 三处已核实断线继续在生产路径静默生效（3 个同步入口过滤授权证据、`principle_deviation` 锚点丢失、`candidate internalize` 允许无账本/已复用候选空跑 LLM）；新增协作者或入口时仍靠人工审计防漏 |
| `mvp-q-2-how-observed` | Phase 0：WAL 一致性漏斗报告；Phase 1：三层探针测试由红转绿 + CLI 结构化拒绝输出；Phase 2：重复 Runner 代码净删除与架构回归守卫；Phase 5：按原则查询有效性证据 |
| `mvp-q-3-how-disabled` | 零新增开关；不改数据库表结构，按 PR 逆序可安全 revert |
| `mvp-q-4-emotional-value` | Phase 0–4：`N/A — no direct Owner-facing behavior.` Phase 5：立项前按 `$PD_PRIVATE_DOCS_DIR/product/emotional-value.md` 单独核对 |

---

## 8. 风险与并行冲突控制

| 风险 | 影响 | 缓解 |
|---|---|---|
| 收编 `diagnose.ts` / `pain-retry.ts` 误关外部传入的 `stateManager` 或改变 CLI 退出码 | 连接提前关闭 / 违反 §10 CLI 契约 | `createDiagnosticianRunnerBundle` 用 `ownsStateManager` 布尔位严格区分资源所有权；保留 CLI 外层输出整形，跑全量 CLI 契约测试 |
| D4 门禁误伤 `rule` 候选、`defer` 候选或存量任务 | 阻断合法规则内化、改变 CLI 返回码或把已存在任务误报为拒绝 | 先跑路由判定过滤非内化候选；`findExistingDreamerTask` 去重前置于身份门禁；`ok:false` 损坏文档 fail-closed；`rule` 候选 `reason === 'missing'` 显式放行，单测逐类锁死 |
| Phase 3 门禁误伤 `diag_*` 子任务、历史在途链或冲突根 | 诊断链中断、存量任务卡死或冲突根误通过 | 严格限定 `isPeerRunnerKind` 分支；根 `taskId`/`diagnosticJson` 双源交叉校验（`A+B` 拒绝）；悬空父引用 fail-closed；历史链从根 `dreamer` 恢复 |
| 与在途分支冲突（`PRI-1278` Service Host、`PRI-1272` Feedback Resilience） | 合并冲突 | 不触碰 `pd-cli/src/services/service-host/**` 与 `pd-mcp-server/src/submit-assembly.ts` |

---

## 9. Owner 决策记录与待确认项

1. **D4 处置策略（已采用严格拒绝）**：`pd candidate internalize` 对未完成账本入库的 `principle` 候选执行**严格拒绝**并提示 `pd candidate intake --candidate-id <id> --workspace "<path>"`，绝不在 `internalize` 命令内隐式执行正式账本写入。
2. **启动确认**：批准 v0.9 后，并行启动 **Phase 0（`PRI-1290`）** 与 **Phase 1A/1B（`PRI-1291`）**；Phase 4（`PRI-1294`）与 Phase 5（`PRI-1295`）保持 `Backlog` 条件门控，未经漏斗数据与 Owner 单独批准不启动。

---

## 附录 A：可复跑实测命令（`origin/main@679dcc93f`）

```bash
# 1. PainToPrincipleService 全仓 5 处生产构造点
rg -n "new PainToPrincipleService\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 2. PainSignalBridge 生产构造点
rg -n "new PainSignalBridge\(|await createPainSignalBridge\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 3. 诊断阶段 Runner 生产构造点（共享工厂 1 处 + CLI 手搓 2 处 + lab 2 处）
rg -n "new (SplitDiagnostician|DiagRootCause|DiagDistiller|DiagRouter)Runner\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 4. 内化阶段 Runner 生产构造点（3 个文件）
rg -l "new (Dreamer|Philosopher|Scribe|Artificer|Evaluator|RolloutReviewer)Runner\(" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 5. D1 核验：PainToPrincipleService 与 OpenClaw commands/pain.ts 缺失授权/轨迹注入
rg -n "sourceMaterialAuthorization" packages/principles-core/src/runtime/pain-to-principle-service.ts || echo "MISSING"
rg -n "trajectoryTurnReader|sourceMaterialAuthorization" packages/openclaw-plugin/src/commands/pain.ts || echo "MISSING"

# 6. D2 核验：deviationAnchor 的非测试读写点（对比 sqlite-context-assembler.ts 无命中）
rg -n "deviationAnchor" packages \
  -g "*.ts" -g "!*.test.ts" -g "!**/dist/**" -g "!**/tests/**" -g "!**/__tests__/**"

# 7. PITaskMetadata 字段总数与可选字段数（28 / 23）及特性开关注册数（55）
sed -n '/^export interface PITaskMetadata/,/^}/p' \
  packages/principles-core/src/runtime/internalization/pitask-metadata.ts | rg -c "^  \w+\??:"
sed -n '/^export interface PITaskMetadata/,/^}/p' \
  packages/principles-core/src/runtime/internalization/pitask-metadata.ts | rg -c "^  \w+\?:"
rg -c "^\s*id: '" packages/principles-core/src/runtime/feature-flags/feature-flag-contract.ts
```

## 附录 B：与既有规范的职责边界

| 主题 | 归属文档 |
|---|---|
| 存储访问端口、空结果与错误的区分 | `docs/plans/2026-11-10-architecture-complexity-remediation-plan.md` |
| 配置字段覆盖校验、Console `validators.ts` 生成化 | 同上 + `docs/reports/PD_MAINTENANCE_GOALS_20261110.md` |
| 租约续期、阶段预算与父任务心跳默认契约 | `docs/specs/SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001-v1.0.md` |
| 后台触发所有权与 OS Scheduler | `docs/specs/SPEC-PD-SERVICE-HOST-001.md` |
| 提交身份预绑定、回执兜底与授权撤回清理 | `docs/specs/SPEC-PD-FEEDBACK-RESILIENCE-001.md` |
| **协作者防漏装配、手搓入口收编、分层探针测试、D1/D2/D4 止血与内化父链血缘** | **本 SPEC（v0.9）** |

## Round 3 implementation amendment — OpenClaw effective config compatibility (2026-11-25)

This amendment records the narrow config-compatibility correction without reopening the approved Pipeline Spine architecture.

- `@principles/install-layout` owns path resolution only. `resolveOpenClawConfigPath` mirrors OpenClaw 2026.11.5 precedence: `OPENCLAW_CONFIG_PATH` > `OPENCLAW_STATE_DIR` > validated `OPENCLAW_PROFILE` state dir > default state dir, with `OPENCLAW_HOME` acting as the host HOME substitute and host-style `~`/relative user-path resolution. It does not parse config content and does not change the legacy `resolvePdHome()` compatibility contract.
- `@principles/openclaw-plugin` owns read-only effective-config interpretation. Because OpenClaw 2026.11.5 does not expose its `$include` resolver through the plugin SDK, the plugin carries a bounded compatibility reader for JSON5 and `$include`; it performs no writes and returns no partial config on failure.
- Owner explicit `hooks.allowConversationAccess=false` remains authoritative across direct config, nested/single/multiple includes, and merge conflicts. Startup repair must not flatten include graphs or write a main-config override when the plugins ownership path is include-backed; ambiguity is fail-closed/no-write.
- Round 3 adds no new cross-package public API. The pre-existing Round 2 `resolveOpenClawConfigPath` install-layout export remains the only config-path API used across packages. The original four `@principles/core/runtime` cross-package symbols and export gates are unchanged.
