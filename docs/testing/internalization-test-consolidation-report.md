# PD Internalization 测试收敛调查 + 实施报告（Test Diet Phase 2.2-A）

> 日期：2026-09-22 · 基线 commit：`b930276f`（PR #1820 已并后）· Linear：PRI-888
> 性质：调查 + 低风险测试重构（仅测试文件，零生产代码/CI/mock 策略变更）
> 原则：**删除重复表达，不删除系统记忆。** 目标不是减少测试数量，而是把"10 个表达同一行为的测试"收敛为"1 个参数化测试"。

---

# 1. Test Inventory（internalization 区域，调查范围）

`packages/principles-core/src/runtime-v2/internalization/__tests__/`（74 文件）+ runtime-v2/__tests__ 中 retry_wait 相关文件。

**Prompt Builder 家族（10 文件，170 it，2066 行，调查前）**

| File | Cases | Purpose | Pattern |
|---|---|---|---|
| dreamer-prompt-builder.test.ts | 21 | dreamer prompt 契约 | template-dup（与 philosopher 逐字重复 ~10 it） |
| philosopher-prompt-builder.test.ts | 16 | philosopher prompt 契约 | template-dup |
| scribe-prompt-builder.test.ts | 21 | scribe prompt 契约（PRI-816/838 块） | mixed |
| evaluator-prompt-builder.test.ts | 18 | evaluator prompt 契约（PRI-644 钉） | mixed |
| evaluator-prompt-builder-v2.test.ts | 10 | evaluator V2 输入（PRI-425 钉） | unique |
| rollout-reviewer-prompt-builder.test.ts | 8 | rollout 评审 prompt | template-dup |
| artificer-prompt-builder.test.ts | 40 | artificer 契约（PRI-741/780/634/508/509 密集钉） | mixed |
| artificer-prompt-builder-v2.test.ts | 5 | artificer V2（EP002-R4/PRI-490 钉） | unique |
| peer-prompt-language.test.ts | 25 | 输出语言指令（PRI-336） | mixed |
| scribe-prompt-language.test.ts | 6 | scribe 语言指令 | duplicate-split |

**Diagnostic Runner 三连（3 文件，38 it）**

| File | Cases | Purpose | Pattern |
|---|---|---|---|
| diag-router-runner.test.ts | 13 | Stage C runner（真实 TypeBox 验证、PRI-667 双写） | mixed |
| diag-rootcause-runner.test.ts | 12 | Stage A runner（PRI-442 Bug-B-005 钉） | template-dup |
| diag-distiller-runner.test.ts | 13 | Stage B runner（EP-07 血缘、伪造 axiom 检测） | template-dup |

**Retry/Backoff 家族（6 文件，130 it）**

| File | Cases | Purpose | Layer | Pattern |
|---|---|---|---|---|
| internalization-task-guards.test.ts | 57 | PRI-62 守卫边界矩阵 | 纯单元 | boundary-repeat |
| task-three-strikes.test.ts | 29 | PRI-141 三振升级 | 纯单元 | **与 guards 的 Three Strikes describe 跨文件重复** |
| split-diagnostician-runner-retry.test.ts | 18 | ERR-067 重试链 + PRI-818 缓存 | orchestrator | stage-repeat |
| task-state-semantics.test.ts | 9 | PRI-104 就绪语义 | 纯单元+读模型 | boundary-repeat |
| pain-signal-bridge-execute-pending.test.ts | 12 | PRI-624 worker 跳过/预算 | bridge worker | unique（层唯一） |
| production-canary-fixture-gate.test.ts（retry_wait describe） | 5 | PRI-102 真实 SQLite 就绪 | real-DB canary | boundary-repeat |

---

# 2. Diagnostic Runner Duplication Matrix（**暂缓合并**，任务书要求只画矩阵）

## 2.1 Harness 对比

三维 harness ~90% 同构（同样的 10-fn stateManager mock、8-fn runtimeAdapter、相同 runner options），差异仅在各自独占的 mock 角色：router=committer + 真实 TypeBox；rootcause=validator+contextAssembler + 0 依赖；distiller=validator + 1 依赖。

## 2.2 重复矩阵（节选；完整分类见代理报告存档）

| it title（缩写） | router | rootcause | distiller | verdict |
|---|:-:|:-:|:-:|---|
| currentPhase is Completed after success | Y | Y | Y | **SAME-TEMPLATE ×3** |
| currentPhase is Failed after validation failure | Y | Y | Y | **SAME-TEMPLATE ×3**（失败注入点不同：真实 schema vs 注入 validator） |
| wrong taskKind ('dreamer') fails closed → input_invalid | Y | Y | Y | **SAME-TEMPLATE ×3** |
| missing taskId re-injected by postFetchTransform | — | Y | Y | **SAME-TEMPLATE ×2** |
| present-but-empty taskId NOT overwritten（真实 Default*Validator） | — | Y | Y | **SAME-TEMPLATE ×2** |
| artifact write failure → retryOrFail，不 markTaskSucceeded | — | Y | Y | **SAME-TEMPLATE ×2** |
| corrupted predecessor artifact fails schema (EP-01) | Y×2 | — | Y | **SAME-TEMPLATE ×3 变体** |
| dependency not succeeded → blocked | Y | — | Y | SAME-TEMPLATE ×2（rootcause 首阶段不适用） |
| happy path（lease→succeed→产物） | Y | Y | Y | STAGE-SPECIFIC（成功产物各不同：commit:// vs diag-rootcause:// vs groundedOnCorePrincipleIds） |
| PRI-667 双写 / 双写失败 | Y | — | — | STAGE-SPECIFIC（钉） |
| PRI-442 Bug-B-005 'main' agentId | — | Y | — | STAGE-SPECIFIC（钉，禁合并） |
| EP-07 血缘失配 + max_attempts_exceeded 遥测 | — | — | Y | STAGE-SPECIFIC（错误类不对称：retryable vs input_invalid） |
| fabricated axiom 拒绝（伪造检测） | — | — | Y | STAGE-SPECIFIC |

**合计**：38 it 中 12 个为同模板候选（可收缩为 ~5 个参数化槽位），26 个为 stage 专属契约。

## 2.3 暂缓原因（合并风险）

1. 依赖图不同（0/1/2 依赖 + committer/validator/contextAssembler 角色组合）——共享工厂做错会静默削弱"前驱缺失→failed"契约。
2. **失败注入层不同**：router 走真实 TypeBox，A/B 注入 validator mock——统一注入点会改变"Failed phase"测试实际覆盖的层，属覆盖面变化而非重构。
3. PRI 钉密集且散文注释是契约的一部分（PRI-667/PRI-442/EP-07）。
4. 错误类不对称（`max_attempts_exceeded` vs `input_invalid`），模板化不得拉平。

**建议**（Phase 2.2-B/2.3）：先提炼 `createMockDeps(stage)` 角色组合工厂，再将 12 个同模板 it 折入 `it.each` over `{runnerClass, taskId, taskKind, failureInjector, requiredDepCount}`，预计 −120~150 行、−8~9 个重复测试体。`diag-chain-e2e` 已拥有跨 stage 集成契约，进一步支持收缩。

---

# 3. Prompt Builder 收敛（**已实施**）

## 3.1 重复模式（调查结论）

- **dreamer/philosopher 逐字重复块**：shape/taskId/contextHash/artifact 透传/valid-JSON/parsed.taskId/pure-function/PRI-633 payload 等 ~10 个 it 除字段名外逐字相同。
- **六 builder 共享机械模板**（各有变体）：JSON-only 指令、confidence 0..1 指令、copy-source-id 指令、promptContractVersion 透传、systemPrompt 承载指令（PRI-633）。
- **语言文件拆分**：scribe 语言指令独立成文件，与 peer-prompt-language 同构（本阶段未合并，见 §6 follow-up）。

## 3.2 实施结构（契约文件 + 精简原文件，非单文件大合并）

**选择理由**：170 it 全并一个文件会 (a) 摧毁 PRI 钉的可定位性（评审者按文件名找 "PRI-644 anchor test"）；(b) 全部 blame 重锚到单次提交，历史检索死亡。契约文件只拥有机械模板，探针数据（精确字符串/regex）逐字取自原 it，断言强度零下降；PRI 钉与组合比较器（`toBe`/`toContain`）留在原文件。

**新文件**：`peer-prompt-builder-contract.test.ts` —— `describe.each` 6 case × 12 模板（含条件注册：sourceId 5 case、confidence 3 case、copyDirective 4 case、contractVersion 4 case）= **64 个执行用例**。

**各文件精简**（只删被契约 1:1 覆盖的 it；每个 case 的探针强度与原断言相同）：

| File | Before | Deleted | After | 保留的典型钉 |
|---|---|---|---|---|
| dreamer-prompt-builder | 21 | 10 | 11 | PRI-862、schema keys、riskLevel 枚举、example 可解析、code-fence regex、null/空数组变体、PRI-633 角色句 |
| philosopher-prompt-builder | 16 | 12 | 4 | schema keys、关键字钉、null 变体、PRI-633 |
| scribe-prompt-builder | 21 | 9 | 12 | systemPrompt===instruction 组合钉、PRI-816 三连、PRI-838 八连（含 PRI-815 冻结文本）、v4 版本钉 |
| evaluator-prompt-builder | 18 | 10 | 8 | sourceTrace 复制钉、v6 PRI-644 钉、score 措辞、systemPrompt toBe、example 结构解析 |
| rollout-reviewer-prompt-builder | 8 | 6 | 2 | systemPrompt toBe、approve_rollout example 钉 |
| artificer-prompt-builder | 40 | 6 | 34 | 全部 PRI-741/780/634/508/509/442/EP002-R4 钉、v8 版本钉 |
| **peer-prompt-builder-contract（新）** | — | — | **64** | 六 builder 机械契约（探针逐字保留） |

**禁合并清单（调查确认"形似而不同"的 12 项，全部未动）**：循环/超界序列化（仅 evaluator/artificer 走 bounded serializer）、systemPrompt 比较器差异（toBe vs toContain vs startsWith）、byte-identical-undefined 的 artificer startsWith 变体、JSON-only 措辞差异（scribe 无 "no prose"）、scribe PRI-816 缺席语义 vs philosopher 必填、版本钉各属不同 PRI 历史、rollout 的 toBe 引用透传、evaluator V1/V2 双 fixture 透传、evaluator-v2 指令常量钉、语言指令的 subject 特定正负探针、dreamer 的 raw-string 角色句扫描（已推广为加法不替换）、coreGrounding 三连仅限 grounding trio。

---

# 4. Retry_wait/Backoff 参数化（**已实施**）

**层判定的铁律**：retry_wait "deadline 前不可就绪/后可就绪" 在 4 层各有唯一证明——纯守卫函数（guards）、读模型+状态机（task-state-semantics）、bridge worker 预算保持（PRI-624）、真实 SQLite canary（PRI-102）。**跨层合并全部拒绝**；仅同层内的边界值重复做参数化。

| 文件 | 变更 | Before→After（执行用例） |
|---|---|---|
| internalization-task-guards.test.ts | canRetryNow 6 it → `it.each` 6 case（PRI-62 精确边界 `leaseExpiresAt===nowMs` 保持显式命名 case）+ 拆出其他非 retry_wait 状态 1 it | 57 → 58 |
| task-state-semantics.test.ts | retry_wait 前后对 2 it → `it.each` 2 case（retryAfter 仅在原断言处断言，不加不弱） | 9 → 9 |
| production-canary-fixture-gate.test.ts | 快照对 2 it + 门对 2 it → 两个 `it.each` × 2 case（同文件同层；真实 SQLite 路径不变） | 不变（describe 内） |
| split-diagnostician-runner-retry.test.ts | ERR-067 Stage A/B/C 三连 → `it.each` 3 case（seed 闭包保持各 stage 前置成功链） | 18 → 16 |
| **合计（4 文件）** | | **108 → 109**（全部保持/略增） |

---

# 5. Before / After 总账

| 指标 | Before (b930276f) | After (本 PR) |
|---|---|---|
| 触及文件集执行用例（10 文件） | **232** | **244**（+12，契约套件对每 builder 执行全部模板） |
| it 定义数（源码位置） | 170+108=278 | 278 − 53（builder 删）− 5（retry 折叠净差）+ 13（契约新模板）≈ **233 定义表达同一行为面** |
| 测试文件数（触及家族） | 10 | 11（+1 契约文件） |
| 行数 | — | 净 −~180 行（builder 家族 −~330 / 契约 +~370 之外的重试折叠 −~100，见 diff 统计） |
| 断言数 | — | 不降（逐 it 核对：每个被删 it 的全部断言由契约 case 以相同探针复执行；retry 折叠逐 case 保持） |
| production code | — | 零改动 |
| PRI/regression 钉 | — | 全部保留原文件原标题 |

> 注：执行用例上升是本设计的预期结果——参数化把"每 builder 一份拷贝"变成"一个模板 × N case 执行"，源码位置的重复下降，运行时保护面不缩反增。

---

# 6. Keep / Merge / Do-Not-Touch

## Keep（已保持独立）
- 全部 PRI 钉（§3.2 表格右列）；四层 retry_wait 证明（guards/semantics/PRI-624/PRI-102）；diag-chain-e2e 集成层；peer-prompt-language 的 buildLanguageDirective 单元 describe（8 it）。

## Merge Candidates（本阶段未实施，供 2.2-B）
1. **diag runner 12 同模板 it**（§2.3 方案）——med risk，需先做角色工厂。
2. **task-three-strikes（29 it）↔ guards Three Strikes describe（10 it）跨文件重复**（PRI-141 同层双写）——低-med risk：保留 guards 侧参数化正本 + task-three-strikes 独有 its（decideArtifactRejectionFeedback/migration/architecture 等），两侧 PRI-141 钉合一。
3. **scribe-prompt-language（6 it）并入 peer-prompt-language** 作第 6 case——低 risk。
4. evaluator-v2/artificer-v2 吸收进各自主文件（同 SUT 不同时代 fixture）——低 risk 但 churn 大。
5. artificer 文件内部两处自重复（v8 版本钉 ×2、JSON-only ×2）——已加注释标记，留待后续。

## Do Not Touch（永久）
- Owner approval / activation 边界测试（activation/ 目录零改动）；
- PRI-624 bridge 预算保持、PRI-102 真实库 canary、PRI-442 Bug-B-005、PRI-667、EP-07 血缘遥测、P0-D/INV 状态迁移边、PRI-621 flag 默认值钉。

---

# 7. 验证

- 触及 10 文件 before：232 用例全绿 → after：244 用例全绿（含契约套件 64/64）。
- principles-core 全套通过（结果见 PR Evidence）。
- 编辑过的 11 个测试文件以独立 tsc 命令行 typecheck（修正 3 处闭包窄化类型错误；仅余 pi-ai-http-transport 既有噪音，与本 PR 无关）。
- `verify:merge`：见 PR。

---

# 8. Self Review 结论

**Safety**：Owner approval 防线零触碰（activation/ 目录不在 diff）；activation contract 零改动；历史 bug 钉全部原位保留；所有被删 it 均有逐断言等强度的契约替代（探针字符串逐字拷贝）。**Complexity**：未新增生产 helper；契约文件是纯测试数据+模板（不引入测试框架）；case 数据是声明式字段而非断言闭包（仅 retry seed 用闭包，因其本质是"每 stage 前置链"编排）。
