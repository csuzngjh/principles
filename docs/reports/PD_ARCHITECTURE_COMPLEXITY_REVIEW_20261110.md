# PD 代码架构与复杂度评审（2026-11-10）

> 性质：只读评审。本轮未修改任何产品代码、未建分支、未发版。
> 方法：先测量（可复跑的统计命令见附录 A），再用真实事故反推结构原因，最后按"每投入一天能降低多少维护成本"排序。
> 词汇遵循 `codebase-design`：deep module / interface / seam / 信息隐藏 / blast radius。

---

## 1. 一句话结论

PD 的问题不是"文件太大"或"包太多"，而是 **几个关键 seam 一直没被收口，导致同一个概念在仓库里有 3–4 套并行实现，而且失败与空结果无法区分**。最值得动的五处，按投入产出排序：

| # | 改动 | 现在有几个实现 / 多少接触点 | 一天投入能换来什么 | 主要依据 |
|---|---|---|---|---|
| 1 | **存储访问收口成 `WorkspaceState` 端口** | 70 处直连 SQLite（45 个生产文件）、33 个文件直连 better-sqlite3、54 条建表散在 8 个文件 | 改一次 schema 或读模型，不再需要跨包搜索调用点；"表里没数据"和"引用坏了"从此可区分 | 事故 #1、#6 |
| 2 | **RuleHost / Gate 收敛成一个决策内核** | 4 套实现（openclaw `rule-host.ts`+`gate.ts`、host-runtime `production-rulehost-gate.ts`、pd-cli `rulehost-pipeline-runner.ts`、core 的 builder/validator/evaluator/writer） | 同一个缺陷只修一次（PRI-1044 实际修了两遍）；新增宿主只需实现 2 个适配函数 | 事故 #1、#4、#5 |
| 3 | **配置读取收敛成 1 个 reader + 1 个 writer** | 4 个独立的 `loadPdConfig` + 1 个安装器校验器 | 新增配置字段不会再"某一条链路静默丢掉"；字段漏读可被测试机械发现 | 事故 #2 |
| 4 | **宿主安装/注册收敛成一个分阶段工厂** | installer 5155 行 + workbuddy-host-installer 3400 行，变更热度全仓前二 | 三宿主安装步骤不再各写一遍；binding 版本不同步类问题只修一处 | 事故 #4、#5 |
| 5 | **决策输出必须说明"为什么 / 还差多少"** | 关键判定返回单一布尔或 `insufficient` 枚举（如晋升就绪判定） | 所有"卡住了但看不出原因"的问题（#6）从"读代码猜"变成"看返回值" | 事故 #6 |

第 1、2 项是**结构性**的（改接口与信息隐藏）；第 3、4 项是**去重复**的（把已有能力接上，不新建抽象）；第 5 项成本最低，但它决定了前四项改完之后 Owner 能不能真的看见结果。**建议顺序：5 → 3 → 1 → 2 → 4**（先让失败可读，再逐层收口）。

---

## 2. 基线测量表

### 2.1 规模（不含 node_modules / dist）

| 包 | 源文件 | 源码行 | 测试文件 | 测试行 |
|---|---:|---:|---:|---:|
| principles-core | 404 | 99,940 | 481 | 143,591 |
| pd-console | 180 | 51,963 | 208 | 51,253 |
| pd-cli | 115 | 34,836 | 170 | 49,133 |
| openclaw-plugin | 134 | 27,358 | 223 | 50,992 |
| create-principles-disciple | 43 | 19,130 | 107 | 26,292 |
| host-runtime | 52 | 17,814 | 70 | 19,115 |
| codex-adapter | 21 | 3,578 | 33 | 8,059 |
| pd-companion | 14 | 3,027 | 30 | 3,746 |
| workbuddy-adapter | 12 | 1,782 | 15 | 3,069 |
| website | 14 | 1,490 | 4 | 1,121 |
| pd-mcp-server | 9 | 1,220 | 8 | 1,478 |
| install-layout | 1 | 385 | 1 | 235 |
| **合计** | **999** | **262,523** | **1,350** | **358,084** |

值得注意的两点：

- **三个包测试行数超过源码行数**（core 143k vs 99k、openclaw 51k vs 27k、cli 49k vs 35k）。这本身不是坏事，但它和下面的"32 个重 mock 测试文件"合起来说明：**大量测试在补偿边界不清**，而不是在保护一个清晰的公共行为。
- **源:测 = 1:1.35**。对 AI 助手意味着：改一处行为，找到受影响测试的成本常常高于找到实现本身。

### 2.2 大文件（源文件，非测试、非脚本）

超过 1500 行的 14 个文件：

| 行数 | 文件 |
|---:|---|
| 5155 | create-principles-disciple/src/installer.ts |
| 3919 | principles-core/src/runtime/internalization/evaluator-runner.ts |
| 3564 | pd-console/src/ui/utils/validators.ts |
| 3400 | create-principles-disciple/src/installers/workbuddy-host-installer.ts |
| 2475 | host-runtime/src/governance-signal-admission.ts |
| 2147 | principles-core/src/runtime/index.ts（406 个 re-export 块） |
| 1977 | pd-cli/src/commands/runtime-activation.ts |
| 1922 | pd-console/src/ui/api.ts |
| 1890 | pd-cli/src/commands/candidate.ts |
| 1781 | principles-core/src/runtime/internalization/rollout-reviewer-runner.ts |
| 1731 | openclaw-plugin/src/core/trajectory.ts |
| 1716 | principles-core/src/runtime/adapter/pi-ai-runtime-adapter.ts |
| 1669 | principles-core/src/runtime/pain-signal-bridge.ts |
| 1623 | pd-console/src/server/config/pd-config-store.ts |

另有 43 个源文件在 800–1500 行之间（合计 56 个 ≥800 行）。

**但从 2.5 的变更热度看，行数本身不是优先级**：`validators.ts`（3564 行）近 300 次提交里几乎没被改过，而 660 行的 `active-principle-prompt.ts` 被改了 9 次。

### 2.3 接口面

| 指标 | 数值 |
|---|---:|
| `@principles/core` 中 `^export` 语句 | 3,657 |
| 消费者实际从 core import 的**不同符号** | **777** |
| 消费者 import core 的次数 | 2,394 |
| core 发布 subpath exports | 25 个（含 `./runtime` 与 12 个 `./runtime/*` 深层路径） |
| 跨包依赖边 | 26 条 |

跨包边（次数）：

```
pd-cli          -> core         233      host-runtime     -> core         129
openclaw-plugin -> core         224      codex-adapter    -> core          29
pd-console      -> core         148      workbuddy-adapter-> core          14
pd-cli          -> host-runtime  31      create-installer -> core          13
openclaw-plugin -> host-runtime  26      console          -> host-runtime 20
```

结构含义：**core 是一个 777 个符号宽的"什么都公开"的面板，而不是模块边界。** 典型症状是 `SqliteConnection` 被 **45 个生产文件**从包入口直接 import（含测试共 142 处引用）——存储连接原语成了事实上的公共 API。

### 2.4 概念重复（同一件事有几套实现）

| 概念 | 实现数量 | 位置 |
|---|---:|---|
| 读 `.pd/config.yaml` | **4** | `pd-cli/src/services/pd-config-loader.ts:112`、`pd-console/src/server/config/pd-config-store.ts:249`、`host-runtime/src/pd-config.ts:75`（`loadPdConfigForPlugin`）、`create-principles-disciple/src/mvp-config.ts:481`（校验器） |
| RuleHost / Gate 决策 | **4** | `openclaw-plugin/src/core/rule-host.ts`(842) + `hooks/gate.ts`(802)；`host-runtime/src/production-rulehost-gate.ts`(705)；`pd-cli/src/services/rulehost-pipeline-runner.ts`(1226)；`core/runtime/internalization/rule-host-*`(4 文件) |
| 工具语义（含 `apply_patch` 目标路径解析） | **9 个文件** | codex-adapter/tool-semantics.ts、openclaw constants/{tools,tool-semantics}.ts、core tool-semantic-baseline/risk-calculator-policy、host-runtime codex-rule-context-provider/host-liveness-contract 等 |
| 打开工作区数据库 | **70 处** `new SqliteConnection()`，分布在 45 个生产文件 | console 35、host-runtime 14、cli 10、openclaw 7、core 4 |
| 绕过连接封装直连 better-sqlite3 | **33 个生产文件** | core 12、cli 9、host-runtime 7、console 4、openclaw 2 |
| 建表 DDL | **54 条，散在 8 个文件**（其中 52 条在 7 个生产模块，2 条在 console 的 e2e-seed 脚本） | `sqlite-connection.ts`(24)、`trajectory-schema.ts`(16)、`host-runtime/governance-observation-store.ts`(5)、`intervention-evidence-schema.ts`(3)、`governance-signal-admission.ts`(2)、`pd-console/.../IntentPageModel.ts`(1)、`openclaw/.../correction-observer-service.ts`(1) |
| Prompt 构造 | **10 个专用 prompt-builder**（另有 2 个宿主侧 prompt 模块，共 12 个文件） | core/runtime/internalization/*(6)、core/runtime/diagnostician/*(4)、host-runtime/active-principle-prompt.ts、openclaw-plugin/hooks/prompt.ts |
| 事件/遥测发射 | 2 套入口 | `host-runtime/workspace-telemetry-emitter.ts` 与 `pd-cli/services/workspace-telemetry.ts`（后者包前者，属可接受包装） |

宿主适配器重复度（规范化后逐行重合，codex 为基准）：

| 文件 | codex 行 | workbuddy 行 | 完全相同的行 | 占比 |
|---|---:|---:|---:|---:|
| pd-hook.ts | 446 | 458 | 247 | 55% |
| host-adapter.ts | 28 | 27 | 22 | 79% |
| worker/workspace-worker.ts | 413 | 231 | 256 | 62% |
| codec/input-decoder.ts | 86 | 161 | 41 | 48% |
| tool-semantics.ts | 11 | 15 | 6 | 55% |

两个包的目录结构几乎同名（`host-adapter.ts` / `codec/` / `tool-semantics.ts` / `*-evidence-recorder.ts` / `pd-hook.ts` / `worker/workspace-worker.ts`）。**这不是"代码风格像"，而是同一份宿主适配逻辑被复制了两次，然后各自演化。**

### 2.5 变更成本（真实需求的实测）

| 真实改动 | 涉及文件 | 涉及包 |
|---|---:|---:|
| PRI-1044 原生 Codex `apply_patch` 写入 + 缺工件可观测 | 9 | 2（host-runtime、openclaw-plugin） |
| PRI-1118 受控准入接线 | 24 | 5 |
| PRI-1146 Diagnostician V2 唯一生产链路切换 | **135** | **8** |
| PRI-1119 配置兼容（adaptiveActivation 身份字段） | 3 | 1 |
| MCP binding 随 runtime 替换刷新 | 4 | 2 |

变更热点（近 300 次提交，排除 package.json / CHANGELOG）：

| 改动次数 | 文件（行数） |
|---:|---|
| 13 | openclaw-plugin/src/hooks/prompt.ts（1319） |
| 11 | create-principles-disciple/src/installers/workbuddy-host-installer.ts（3400） |
| 10 | openclaw-plugin/src/index.ts（1187） |
| 9 | host-runtime/src/active-principle-prompt.ts（660） |
| 9 | host-runtime/src/index.ts（470） |
| 8 | host-runtime/src/adaptive-journal-reconciliation.ts（1308） |
| 7 | principles-core/src/runtime/index.ts（2147） |
| 7 | create-principles-disciple/src/installer.ts（5155） |
| 6 | host-runtime/src/governance-signal-admission.ts（2475） |

### 2.6 测试结构

| 指标 | 数值 |
|---|---:|
| mock ≥5 处的测试文件 | 32（最高 16 处：openclaw `prompt-production-chain` / `prompt-intent-injection` / `llm-input-presence-registration-chain`） |
| 非测试代码 `catch` 块 | 2,019（空 catch 仅 2 个） |
| 只针对"接线"而非行为的守卫测试 | 例：`pd-cli/tests/commands/workspace-telemetry-wiring.test.ts:17` 硬编码 4 个命令文件名，用 `readFileSync` 正则检查源码 |

最后一行是本次评审里**最值得警惕的测试形态**：守卫用"文件名单 + 源码字符串包含"来表达架构约束。它的效果是"已知的 4 个命令不能回退"，而不是"新命令不可能漏接线"。这类测试把约定写进了人的记忆，再用测试复制一遍记忆。

---

## 3. 六起事故的结构原因收敛

| # | 事故 | 直接结构原因 | 归属 |
|---|---|---|---|
| 1 | 候选规则查询 `INNER JOIN pi_artifacts` → 工件缺失时返回空集且无告警，界面仍显示"已启用" | 读模型自己拼 SQL，JOIN 让"没有匹配"和"引用损坏"塌缩成同一个空数组；循环体内再用 `continue` 丢弃异常行 | **A 存储端口** + **D 结果契约** |
| 2 | 配置解析丢弃 `runtimeProfiles.*.systemPrompt`，指令静默失效 | 同一份 YAML 有 4 个独立 reader；没有任何一方能证明"schema 里的每个字段都被读过" | **C 配置单一入口** |
| 3 | 遥测通道已建，三个命令入口只有一处真正接线 | 发射是每个命令各写一次的旁路调用，不是执行边界的固有部分；守卫靠硬编码文件清单维持 | **D/E 边界内建**（非独立项，见 §4.3） |
| 4 | 三宿主适配各一套，同一缺陷要分别修 | 宿主"语义层"没有共享内核，`tool-semantics` / payload 解码 / 决策顺序在每个宿主里各写一遍（重合度 48–79%） | **B 决策内核** + **F 安装工厂** |
| 5 | Codex `apply_patch` 补丁体在 `tool_input.command`，代码只认 `patch`/`input` → 路径为空 → 主通道静默放行 | 工具语义分散在 9 个文件，每个消费者各自决定"从哪个字段取路径"；取不到时返回空值并继续 | **B 决策内核** + **D 结果契约** |
| 6 | 晋升依赖 `shadowAge >= 24h`，而 `firstObservedAt` 随窗口滑动重置；判定正确但外部看不到"还差多久" | 判定把 5 个阈值压成一个布尔（`promotion-readiness-evaluator.ts:62-71`），没有任何字段回传"哪一项没过、差多少" | **D 结果契约** |

**收敛结论：六起事故只有两个根因** —— (a) 缺少一个拥有"读工作区状态"和"判定"的深模块，导致每个消费者自己拼装并自己决定失败语义；(b) 判定与读模型返回"值"而不是"带原因的结论"，使错误只能靠读代码发现。事故 3 是 (a) 的变体：接线是每个调用点自己的责任，而不是边界的内建行为。

---

## 4. 五处结构性改动

### 4.1 【A】把工作区存储收口成 `WorkspaceState` 端口

**现在是什么结构**

- `@principles/core` 导出 `SqliteConnection` 这一**连接原语**，被 45 个生产文件从包入口直接 import（含测试共 142 处引用）。
- 生产代码里 70 处 `new SqliteConnection(...)`，分布在 45 个文件：**pd-console 35**、host-runtime 14、pd-cli 10、openclaw 7、core 4。
- 33 个生产文件绕过连接封装直接 `import Database from 'better-sqlite3'`（core 12、cli 9、host-runtime 7、console 4、openclaw 2）；`host-runtime/src/governance-observation-store.ts:338-343` 自己打开 `{workspace}/.state/trajectory.db`，并在 206–267 行自建 5 张 `governance_*` 表。
- 54 条 `CREATE TABLE` 分布在 8 个文件（52 条在 7 个生产模块，2 条在 console 的 e2e-seed 脚本），其中 1 条在 `pd-console/src/server/models/IntentPageModel.ts`、1 条在 openclaw 的 `correction-observer-service.ts`。
- 典型越界：`pd-console/src/server/models/ActivationsConsoleModel.ts` 一个文件里 8 次构造连接、直接查 `activations` / `pi_artifacts`。

**可观察后果**

- 事故 #1 的代码现场在 `principles-core/src/runtime/activation-compatibility-read-model.ts:81-96`：`JOIN pi_artifacts` 后逐行 `if (!artifactId || !contentJson) continue;`，缺工件的激活直接从结果里消失，最终返回 `status: 'clean', scannedActivations: 0`——**"扫描通过"和"根本没扫到"是同一个返回值**。
- 事故 #6 的同源问题：读模型各自解释时间字段，`firstObservedAt` 的滑动语义在 4 个文件里各有一份理解。
- 后果 3：schema 变更的影响面无法静态确定。PRI-1146 动了 8 个包的 135 个文件，其中相当一部分是在跟随字段语义变化。

**改成什么形状**

core 暴露一个深模块，只发布语义接口，隐藏连接、pragma、迁移、事务与"空 vs 坏"的区分：

```ts
// 消费者看到的是"问题"，不是"表"
readActivationInventory(workspaceDir): Outcome<ActivationInventory>
//  - 内部负责：连接、只读打开、JOIN、缺工件归类、损坏行计数
//  - 返回：{ items, missingArtifacts: [...], unreadableRows: n } 或 { ok:false, reason, nextAction }

readPromotionEvidence(workspaceDir, artifactId): Outcome<PromotionEvidence>
writeGovernanceObservation(workspaceDir, obs): Outcome<{id}>
```

判据是"调用方需要知道多少"：现在 console 需要知道表名、列名、行形状、连接生命周期；改完后只需要知道 3 个语义查询名。**存储 seam 的真正职责不是"少写几行 SQL"，而是保证"缺失/损坏/正常"三种情况在类型上不可混淆。**

**改动面与批次**

| 批次 | 范围 | 文件数（估） | 能否独立上线 | 撤回方式 |
|---|---|---:|---|---|
| A1 | pd-console 的 35 处直连 → 调用 core 读模型 | ~15 | 能（单包内，纯读） | 恢复旧 model 实现即可 |
| A2 | host-runtime 的 14 处 + 7 个 better-sqlite3 文件 → 端口；`governance_*` 建表迁回 core 或明确登记为独立库 | ~12 | 能（需先补 schema conformance 测试） | 保留旧存储类，开关切换 |
| A3 | openclaw / pd-cli 的 17 处 | ~10 | 能 | 同上 |
| A4 | CI 守卫：非 core 包禁止 import `SqliteConnection` / `better-sqlite3` | 1 | 能（A1–A3 完成后才开） | 守卫可单独 revert |

**不需要数据迁移**（不改表结构，只改访问路径）；**不改公共契约**（新增端口是增量的）；**不放宽任何 fail-closed 条件**（端口内部必须先分类再返回，缺失引用必须是显式失败或显式降级，不能是空数组）。

**如何证明改好了**

1. `rg "new SqliteConnection\(|from 'better-sqlite3'" packages --glob '!**/principles-core/**'` → 0 命中。
2. `CREATE TABLE` 只出现在 core 的 schema 所有权文件（或 host-runtime 明确登记的独立库）。
3. 回归测试：对同一个"激活存在但工件缺失"的 fixture，端口必须返回 `missingArtifacts.length === 1`，且控制台能显示该状态；现有 `activation-compatibility-read-model` 的 `clean` 语义必须被拆成 `clean` 与 `scanned=0 但存在激活` 两种。
4. blast radius 指标：改一次 `activations` 表结构，受影响文件数从当前水平降到只落在 core 内。

---

### 4.2 【B】把 RuleHost / Gate 收敛成一个决策内核

**现在是什么结构**

四套并列实现：

| 实现 | 行数 | 位置 |
|---|---:|---|
| openclaw 运行时 | 842 + 802 + 293 | `openclaw-plugin/src/core/rule-host.ts`、`hooks/gate.ts`、`hooks/gate-block-helper.ts` |
| host-runtime 生产门 | 705 | `host-runtime/src/production-rulehost-gate.ts` |
| CLI 流水线 | 1226 + 291 | `pd-cli/src/services/rulehost-pipeline-runner.ts`、`rulehost-readiness.ts` |
| core 契约件 | 403+303+159+144+91+36+15 | `activation/writers/rule-host-writer.ts`、`internalization/rule-host-{input-builder,validator,evaluator,contracts,helpers,adapter}.ts` |

工具语义（决定"这个工具调用写的是哪个文件"）再分散到 9 个文件。相关文件合计 23 个非测试文件引用 `RuleHostInput` / `ruleHostInputContract`。

**可观察后果**

- **PRI-1044 实测**：同一个缺工件缺陷，必须在 `host-runtime/src/production-rulehost-gate.ts`（+39 行）和 `openclaw-plugin/src/core/rule-host.ts`（+56 行）各修一次，并各配一套测试。
- 事故 #5：`apply_patch` 的路径解析在 codex-adapter 与 host-runtime 各有一份，字段名认识不一致时，一侧返回空、另一侧继续执行 → 主通道静默放行。
- 事故 #4：binding 版本与 hook 载荷字段名在三个宿主里分别演进，属于同一个"没有共享语义层"的症状。

**改成什么形状**

一个纯决策内核 + 每宿主两个薄适配函数：

```ts
// core 拥有：决策顺序、降级语义、证据写入时机（全部隐藏）
evaluateRuleHost(input: RuleHostInput): RuleHostDecision
//  RuleHostDecision = { verdict: 'allow'|'block'|'degrade',
//                       reasons: Reason[],            // 为什么
//                       evidence: EvidenceRef[],      // 写什么
//                       degraded?: { reason, nextAction } }

// 每宿主仅实现（真实的两个变化轴）
resolveToolSemantics(toolCall): ToolSemantics   // 各宿主工具命名不同
toRuleHostInput(hookPayload): RuleHostInput     // 各宿主载荷字段不同
```

关键信息隐藏：**"从哪个字段取文件路径"不再由 9 个消费者各自决定**，而是 `resolveToolSemantics` 一个函数的责任；取不到路径必须是显式 `unresolved`（带 `reason` + `nextAction`），不能返回空字符串让下游放行。

**改动面与批次**

| 批次 | 范围 | 能否独立上线 | 撤回方式 |
|---|---|---|---|
| B1 | 先给现存的 openclaw 与 host-runtime 两条路径补"决策结果契约"（`verdict/reasons/evidence/degraded`），不改实现，只改返回类型 | 能（纯增量，消费者适配） | 类型与映射可 revert |
| B2 | 抽出 `resolveToolSemantics` 单一注册表，删除 9 处分散的工具字段判断 | 能（一个概念一个提交） | 保留旧分支直到两端测试对齐 |
| B3 | openclaw 的 `rule-host.ts` 改为调用 core 内核；`gate.ts` 只保留 hook 生命周期 | 能（单包） | 旧实现保留为包装器 |
| B4 | host-runtime 生产门改为同一内核 | 能 | 同上 |
| B5 | pd-cli 流水线改为同一内核 | 能 | 同上 |

**不改**：各宿主的 hook 注册方式、生命周期顺序、准入/限流策略——这些是真实变化轴，不该合并（见 §5 反面清单）。
**不放宽**：任何 `allow` 路径不得因重构而扩大；B1 必须先建立"决策枚举前后一致"的特征化测试。

**如何证明改好了**

1. 缺陷单点验证：人为在工具语义注入一个未知字段名的 `apply_patch`，只有 `resolveToolSemantics` 一处需要改，且该变更有测试覆盖。
2. `rg "apply_patch" packages --glob '!**/tests/**'` 命中数从 9 个文件降到 ≤2（语义注册表 + 内核）。
3. 同一组 fixture 分别喂给 openclaw 路径与 host-runtime 路径，`verdict` 与 `reasons` 必须逐项相等（跨宿主一致性测试）。
4. 新增宿主成本：接口新增 ≤2 个函数，不需要复制 `rule-host.ts` / `gate.ts`。

---

### 4.3 【C】配置读取收敛成 1 个 reader + 1 个 writer

**现在是什么结构**

同一份 `.pd/config.yaml` 有 4 个独立 reader：

| 位置 | 形态 |
|---|---|
| `pd-cli/src/services/pd-config-loader.ts:112` | `loadPdConfig(workspaceDir): PdConfigLoadResult` |
| `pd-console/src/server/config/pd-config-store.ts:249` | `loadPdConfig(workspaceDir): ConfigLoadResult`（另有 `updateAgentBinding` / `updateDefaultRuntime` / `updatePrinciplesOutputLanguage` 三个写入口） |
| `host-runtime/src/pd-config.ts:75` | `loadPdConfigForPlugin(workspaceDir)` |
| `create-principles-disciple/src/mvp-config.ts:481` | `validateConfigYamlFull(workspaceDir)`（只校验部分顶层段） |

core 侧还有 `pd-config-defaults.ts` / `pd-config-effective.ts` / `pd-config-validate.ts` / `pd-config-types.ts`（合计 1666 行）作为"类型与默认值"的第 5 份知识。

**可观察后果**

- 事故 #2：某个 reader 丢弃 `runtimeProfiles.*.systemPrompt`，指令静默失效、不报错。四个 reader 中任何一个漏字段，症状都是"功能不生效但全程无错误"。
- 事故 #4 的安装侧变体：MCP binding 刷新要在 installer 里单独修（`0c2d610a1`，4 文件/2 包），因为写配置的路径和读配置的路径不是同一个模块。
- 后果 3：新增配置字段要改 4–5 处，且没有任何机制能证明"改全了"。

**改成什么形状**

```ts
// core：唯一 reader。返回"已解析值 + 每个声明字段的读取状态"
readWorkspaceConfig(workspaceDir): ConfigReadResult
//  ConfigReadResult = {
//    config: EffectivePdConfig,
//    fieldStatus: Record<ConfigFieldPath, 'read'|'absent'|'invalid'>,
//    warnings: Array<{ path, reason, nextAction }>,
//    raw: unknown            // 未知字段保留，写回时不丢
//  }

// core：唯一 writer。保留注释与未知字段，写入后自校验
writeWorkspaceConfig(workspaceDir, patch): Outcome<void>
```

关键点不是"合并文件"，而是：**字段覆盖率可被机械验证**。类型里声明了 60 个字段，就应有 60 条 `fieldStatus`；没有的一条就是漏读——这一条把事故 #2 从"人靠读代码发现"变成"测试自动发现"。

**改动面与批次**

| 批次 | 范围 | 能否独立上线 | 撤回方式 |
|---|---|---|---|
| C1 | core 实现 `readWorkspaceConfig` + 字段覆盖率测试（不改消费者） | 能（纯新增） | 删除新增文件 |
| C2 | 4 个 reader 改为委托 core；保留各自返回类型做适配 | 能（逐包） | 逐个包 revert |
| C3 | 写入口收敛到 `writeWorkspaceConfig`（console 3 个 update + installer 写入） | 能（需 YAML 保真测试） | 保留旧 writer |

**不改**：配置的 schema 与默认值语义；不引入新配置文件；不做"配置中心"。
**不放宽**：reader 遇到非法值必须仍然 fail-closed（现有 `pd-config-validate.ts` 的拒绝行为不变）。

**如何证明改好了**

1. `rg "yaml.*parse|parseYaml\(" packages --glob '!**/tests/**'` 只剩 core 一处。
2. 字段覆盖率测试：`pd-config-types.ts` 中每个字段路径都出现在 `fieldStatus`，缺失即测试失败。
3. 回归：把 `runtimeProfiles.*.systemPrompt` 删除/改写后，必须出现一条带 `path` 与 `nextAction` 的 warning，而不是静默使用默认值。
4. 写回保真：对真实 config.yaml 做一次 no-op 写入，字节级 diff 仅允许格式等价变化。

---

### 4.4 【D】决策输出必须说明"为什么"和"还差多少"

**现在是什么结构**

典型现场 `principles-core/src/runtime/activation/promotion-readiness-evaluator.ts:62-71`：

```ts
const shadowAgeMs = summary.firstObservedAt === null ? null
  : Date.parse(evidenceSnapshot.createdAt) - Date.parse(summary.firstObservedAt);
const insufficientEvidence = summary.observed === null || summary.observed < 20
  || summary.matched === null || summary.matched < 3
  || summary.neutralControl === null || summary.neutralControl < 1
  || shadowAgeMs === null || !Number.isFinite(shadowAgeMs) || shadowAgeMs < 24*60*60*1000;
// 返回：status: 'evidence_insufficient' | 'blocked' | 'ready'
```

五个独立阈值被压成一个布尔，返回值只告诉调用方"不够"，不告诉"哪项不够、差多少、下次什么时候可能够"。

**可观察后果**

- 事故 #6：Owner 与控制台都看不到"还差 X 小时"，只能等；而 `firstObservedAt` 会随日志窗口滑动重置，等待可能永远不结束，且没有任何信号提示这一点。
- 同类问题在读模型侧：事故 #1 的 `status: 'clean'` 同样无法区分"没问题"与"没扫到"。

**改成什么形状**

把"结论"换成"结论 + 判据明细"，这是唯一一处需要改**公共契约**的改动，所以要最后做、并且只改一个方向（增加字段，不删字段）：

```ts
interface CriterionResult {
  id: string;                       // 'shadow_samples' | 'shadow_age' | ...
  status: 'passed' | 'failed' | 'unavailable';
  observed: number | null;
  required: number;
  remaining: number | null;         // 还差多少（小时/次）
  reason?: string;
  nextAction?: string;
}
type PromotionReadinessResult = { status: ...; criteria: CriterionResult[]; /* 兼容保留现有字段 */ }
```

**改动面与批次**

| 批次 | 范围 | 能否独立上线 | 撤回方式 |
|---|---|---|---|
| D1 | 给晋升判定加 `criteria[]`（保留旧字段，纯增量） | 能 | 删字段 |
| D2 | console/CLI 展示 `criteria`（"还差 6 小时 / 还差 7 次样本"） | 能（单侧 UI） | UI revert |
| D3 | 读模型统一引入 `Outcome` + `missingDependency` 分类（与 A 批次配套） | 能 | 类型层可 revert |

**如何证明改好了**

1. 用一条"只差 3 小时"的 fixture，返回值必须包含 `{id:'shadow_age', observed, required, remaining}`，且 UI 能直接渲染该文案。
2. 一条"工件缺失"的 fixture，读模型必须返回可区分的 `missingDependency`（而非空数组）。
3. 现有 `status` 语义不发生任何放宽：原有 `blocked` 场景仍为 `blocked`（特征化测试先行）。

---

### 4.5 【F】宿主安装/注册收敛成一个分阶段工厂

**现在是什么结构**

- `create-principles-disciple/src/installer.ts` 5155 行，单文件里至少混了 8 类职责：manifest 读写（206–316）、release 元数据（383）、npm 依赖解析与自包含校验（436–1044）、路径校验（1057）、备份/恢复/回滚（1130–1445）、gateway 动作（1445–1540）、legacy 契约预检（1575–1825）、插件 staging 与安装（1881–2072+）。
- `installers/workbuddy-host-installer.ts` 3400 行，与 openclaw 安装流程大量同构（config 段校验、profile 写入、MCP/binding 注册、安装后校验），但实现独立。
- 变更热度全仓第一、第二（11 次 / 7 次）；MCP binding 类问题已实际发生（`0c2d610a1`）。

**可观察后果**

- 事故 #4 的安装侧：binding 版本不同步时，需要在各宿主的安装器里分别修，且没有共享的"注册即校验"步骤。
- AI 助手的实际成本：改一个安装行为要在 5000 行文件里定位"这一步在哪个阶段、前面有没有写盘、失败会不会回滚"。

**改成什么形状**

不是一个 5000 行文件拆成 10 个文件（那是伪目标），而是**五个有类型化结果、可独立测试、可独立回滚的阶段**：

```ts
preflight(ctx): Outcome<PreflightPlan>       // 只读，决定装不装、装哪
backup(ctx): Outcome<BackupHandle>           // 可恢复点
stage(ctx): Outcome<StagedPayload>           // 不触碰安装目录
commit(ctx): Outcome<RegisteredHosts>        // 唯一的写入口
verify(ctx): Outcome<VerifyReport>           // 注册后自校验（binding 版本、hook 载荷）
// 每个 Outcome 都带 reason/nextAction；commit 失败必须能由 handle 回到 backup 点
```

两个宿主只提供 `HostInstallSpec`（路径、注册项、binding 形态、校验断言），不再各写一套流程。**隐藏的信息**是"顺序与失败回滚"，这正是现在最难读、最容易被 AI 改错的部分。

**改动面与批次**

| 批次 | 范围 | 能否独立上线 | 撤回方式 |
|---|---|---|---|
| F1 | 从现有 installer 抽出 `preflight`/`verify` 两个纯函数（不改调用顺序） | 能 | 函数体内联回去即可 |
| F2 | 抽出 `backup`/`commit` 边界，写盘动作只剩一处 | 能（需备份恢复回归测试） | 保留旧路径开关 |
| F3 | workbuddy 安装器改为消费同一 spec/阶段 | 能（单包 + 安装 e2e） | 旧实现保留 |

**不改**：安装产物的目录布局与安装器边界（AGENTS.md §1.1 已明确安装目录归 installer 所有，不得改动语义）。
**不放宽**：备份完整性、安装后校验、失败回滚必须逐条保留（`BackupIntegrityError` / `SelfContainedDependencyError` 的语义不变）。

**如何证明改好了**

1. 安装流程的失败注入测试：在 commit 中途失败，必须回到 backup 点且安装目录与安装前逐文件一致（现有备份恢复测试可扩展）。
2. 新增一个宿主只需 1 个 `HostInstallSpec` + 1 套 verify 断言，不复制流程。
3. binding 版本不一致由 `verify` 阶段报出 `reason`（而不是装完后运行时才发现）。

---

## 5. 明确不做什么（与"做什么"同等重要）

1. **不动 core 的 777 个导出，不重排包目录。** 收窄公共面本身没有直接事故支撑，而且成本极高、收益不可观测。只在 A/B/C 已经改动到的文件上顺手收窄；新增符号必须回答"调用方真的需要知道吗"。
2. **不按行数拆大文件。** `evaluator-runner.ts`(3919)、`validators.ts`(3564)、`rollout-reviewer-runner.ts`(1781) 都不在优先列表：行数大但变更不频繁，且拆文件不改接口不会降低 AI 的阅读成本（它仍要读全部）。只有当该文件进入 A–F 的改动范围时才处理。
3. **不合并三个宿主适配器为一个参数化 adapter。** 三宿主的差异是**真实变化轴**（工具命名、hook 载荷、注册方式），合并会造出 if-else 上帝类。只统一"语义层"（`resolveToolSemantics`）与"决策内核"，各自的生命周期与注册保持独立。
4. **不新建事件总线 / 遥测框架。** 现有 `WorkspaceTelemetryEmitter` 足够；事故 #3 的修法不是"再建一层"，而是让发射成为执行边界的内建行为。
5. **不做全仓 `as` / `any` 清理。** 已有 `rc-2` 守卫与 `isRecord` 惯例；批量清理会制造巨大 diff 而无行为收益。
6. **不动 pd-console 的页面组件与样式。** 与本次目标无关（除 A1 涉及的 model 层）。
7. **不引入新的特性开关。** 五处改动都是可在包内分批、可 revert 的结构调整，不需要运行时开关。

---

## 6. 反面清单（看起来该重构，其实是伪目标）

| 伪目标 | 为什么是伪的 | 真该做的 |
|---|---|---|
| 把 `installer.ts` 拆成 10 个文件 | 若只是移动行、不改接口，AI 仍要在 8555 行里追调用顺序与失败回滚路径 | 抽出 5 个阶段 + 类型化 `Outcome`（§4.5） |
| 继续给 core 加 subpath exports | 25 个已存在，777 个符号已可见；再加只会加宽接口面 | 收窄到 ≤10 个能力入口，内部符号不导出 |
| 把 host-runtime 的 `better-sqlite3` 换成 core 的 `SqliteConnection` | 只换库不建语义端口，等于把复杂度搬到另一个位置，事故 #1 依然可复现 | 建 `WorkspaceState` 端口，先分类再返回（§4.1） |
| "给每个 catch 加日志" | 2,019 个 catch、仅 2 个空 catch，日志量不是问题 | 修返回契约：让"空/缺失/损坏"不可混淆（§4.4） |
| 把 10 个 prompt-builder 合成 1 个 | 每个内部 agent 的提示结构是真实的领域差异 | 只统一"证据/上下文如何注入"的共享段 |
| 用"接线守卫测试"锁住更多命令 | 现有守卫已证明这是把记忆写进测试（硬编码 4 个文件名） | 把接线变成执行边界的内建行为，守卫改为机制测试 |
| 统一 `.pd/state.db` 与 `.state/trajectory.db` | 两库分离是既有设计决定，合并会触发数据迁移风险 | 只在端口层统一"如何被访问"，不合并物理库 |

---

## 7. 给 AI 助手的具体收益（可验收）

"改一个典型需求需要读多少文件"的估算口径：沿真实调用链，从命令/入口到判定与持久化，必须读的非测试文件数。

| 典型任务 | 现在（实测/估算） | 改动后目标 | 靠什么保证 |
|---|---|---|---|
| 排查"候选规则为什么没生效" | 9–12 文件 / 4 包（CLI → core builder/validator/evaluator/writer → host-runtime gate → openclaw rule-host） | 3 文件（读模型 + 判定内核 + 结果契约） | §4.1 + §4.2 + §4.4 |
| 新增一个带遥测的 CLI 命令 | 4+ 文件 + 依赖记忆 + 改守卫的硬编码清单 | 1 处注册（边界内建发射） | §4.4 / 事故 #3 |
| 修一个宿主侧缺陷 | 2–3 个包各修一次（PRI-1044 实测 2 处） | 1 处内核 + 各宿主 ≤2 个适配函数 | §4.2 |
| 新增/修改一个配置字段 | 4 个 reader + 1 个 installer 校验器 | 1 个 reader + 1 个 writer + 覆盖率测试自动报错 | §4.3 |
| 改一次工作区表结构 | 影响面不可静态确定（70 处直连、45 个文件） | 只落在 core 端口内 | §4.1 |
| 排查"为什么晋升不了" | 读 evaluator + snapshot + reader，且返回值无进度 | 读 1 个 `criteria[]` | §4.4 |
| 改一个安装步骤 | 在 5155 行里定位阶段与回滚路径 | 读对应阶段函数 + `Outcome` | §4.5 |

**哪些"现在靠人记住的隐含约定"可以变成代码或检查：**

| 隐含约定 | 现在如何维持 | 改后 |
|---|---|---|
| "读激活必须联表查工件" | 每个读模型自己记得 JOIN | 端口内固定，缺工件显式分类 |
| "配置字段要在 4 个 loader 都出现" | 无机制，靠事故教训 | 字段覆盖率测试 |
| "新命令要接遥测" | 守卫里硬编码 4 个文件名 | 边界内建 |
| "`apply_patch` 路径在哪个字段" | 9 个文件各自记得 | 单一语义注册表 |
| "哪个包可以直接开数据库" | 无机制 | CI 守卫（A4） |
| "晋升要等 24h 且可能永远等不到" | 无任何提示 | `criteria` 明示 remaining |
| "安装失败要回到备份点" | 靠读 installer 的控制流 | 阶段契约 + `Outcome` |

---

## 8. 风险与边界

- **本轮无代码改动**，因此无回归风险；以上所有"改动面"都是估算，落地时必须先做一次 Reality Audit（AGENTS.md §P2.1），确认现有能力是否只是"未连接"。
- **最大风险点**：§4.4 与 §4.2 涉及公共契约（返回类型），必须"只增不减"并先写特征化测试；不得为了通过测试放宽 `blocked` / `fail-closed` 语义。
- **不得**为任何一项引入第二套权威数据源（例如为端口再建一份缓存表），也不得为"整洁"删除现有测试或放宽断言。
- 若某一项在执行中发现"现有能力已存在、只差连接"，优先修连接，不新建抽象（Connection Before Creation）。

---

## 附录 A：统计方法与可复跑命令

所有命令在 `d:\Code\principles` 下执行（PowerShell 7）。`$root` 指 `d:\Code\principles\packages`。

**A1 各包文件数与行数（区分 src / test）**

```powershell
$root='d:\Code\principles\packages'
$all = Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' }
$rows = foreach($f in $all){
  $lines=(Get-Content $f.FullName | Measure-Object -Line).Lines
  $rel=$f.FullName.Substring($root.Length+1); $pkg=($rel -split '\\')[0]
  $isTest = ($rel -match '(^|\\)tests?\\' -or $rel -match '\.test\.tsx?$' -or $rel -match '__tests__')
  [PSCustomObject]@{Lines=$lines; Package=$pkg; IsTest=$isTest; Path=$rel}
}
$rows | Group-Object Package | ForEach-Object {
  $s=$_.Group|Where-Object{-not $_.IsTest}; $t=$_.Group|Where-Object{$_.IsTest}
  [PSCustomObject]@{Pkg=$_.Name; SrcFiles=$s.Count; SrcLines=($s|Measure-Object Lines -Sum).Sum
    TestFiles=$t.Count; TestLines=($t|Measure-Object Lines -Sum).Sum}
} | Sort-Object SrcLines -Descending | Format-Table -AutoSize
```

**A2 Top 30 大文件 / >800 行清单**

```powershell
$rows | Sort-Object Lines -Descending | Select-Object -First 30 | Format-Table -AutoSize -Wrap
$rows | Where-Object { $_.Lines -gt 800 -and -not $_.IsTest } | Sort-Object Lines -Descending
```

**A3 导出面**

```powershell
$src = Join-Path $root 'principles-core\src'
Get-ChildItem $src -Recurse -File -Include *.ts |
  Where-Object { $_.FullName -notmatch '__tests__|\.test\.' } |
  Select-String -Pattern '^export ' | Measure-Object            # 3657

# 消费者实际用到的 core 符号（去重）
$files = Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' }
$syms=@{}; foreach($f in $files){
  $c=Get-Content $f.FullName -Raw; if(-not $c){continue}
  foreach($m in [regex]::Matches($c,"import\s+(?:type\s+)?\{(?<b>[^}]*)\}\s+from\s+'@principles/core(?:/[^']*)?'")){
    foreach($p in ($m.Groups['b'].Value -split ',')){
      $n=($p.Trim() -replace '^type\s+','' -replace '\s+as\s+.*$',''); if($n){$syms[$n]=1}
    }
  }
}
$syms.Count                                                    # 777
```

**A4 跨包依赖边**

```powershell
$edges=@{}
foreach($f in $files){
  $rel=$f.FullName.Substring($root.Length+1); $from=($rel -split '\\')[0]
  $c=Get-Content $f.FullName -Raw; if(-not $c){continue}
  foreach($m in [regex]::Matches($c,"from\s+'(?<m>@principles/[a-z-]+|principles-disciple)(?:/[^']*)?'")){
    $k="$from -> $($m.Groups['m'].Value)"; if($edges.ContainsKey($k)){$edges[$k]++}else{$edges[$k]=1}
  }
}
$edges.GetEnumerator() | Sort-Object Value -Descending
```

**A5 存储接触点**

```powershell
# 生产代码 = 排除 tests/ 、__tests__/ 以及任意层级的 *.test.ts
$prod = $files | Where-Object {
  $_.FullName -notmatch '\\tests?\\|__tests__' -and $_.Name -notmatch '\.test\.ts$'
}
$prod | Select-String -Pattern 'new SqliteConnection\(' | Group-Object Path   # 70 处 / 45 文件
$prod | Select-String -Pattern "from 'better-sqlite3'" | Group-Object Path    # 33 文件
$prod | Select-String -Pattern 'CREATE TABLE' | Group-Object Path            # 54 条 / 8 文件
```

> 注意：若只用 `-notmatch '\\tests?\\|__tests__'` 过滤，会漏掉 `src/**/*.test.ts`，导致数字虚高（首版草稿曾据此得到 139/39/67，已按生产口径更正为 70/33/54）。

**A6 配置读取实现**

```powershell
Get-ChildItem $root -Recurse -File -Include *.ts |
  Select-String -Pattern 'export function (loadPdConfig|loadPdConfigForPlugin|validateConfigYamlFull)'
```

**A7 宿主适配器重复度**

```powershell
function Norm($p){ Get-Content $p | ForEach-Object { $_.Trim() } |
  Where-Object { $_ -ne '' -and $_ -notmatch '^\*' -and $_ -notmatch '^//' } }
# 对同名文件逐行集合求交，除以 codex 侧行数
```

**A8 变更成本与热点**

```powershell
git show --name-only --format='' <commit>                      # 单次需求涉及文件
git log -n 300 --name-only --format='' |
  Where-Object { $_ -match '^packages/' } |
  Group-Object | Sort-Object Count -Descending | Select-Object -First 30
```

**A9 mock 密度与 catch 统计**

```powershell
$tests | ForEach-Object {
  $n=([regex]::Matches((Get-Content $_.FullName -Raw),'vi\.mock\(|jest\.mock\(')).Count
  if($n -ge 5){ [PSCustomObject]@{Mocks=$n; File=$_.FullName} }
}
# catch 块：正则 'catch\s*(\([^)]*\))?\s*\{' 与 '...\{\s*\}'，非测试代码
```

---

## 附录 B：事故 → 证据位置对照

| 事故 | 当前代码证据 | 说明 |
|---|---|---|
| #1 缺工件静默通过 | `principles-core/src/runtime/activation-compatibility-read-model.ts:81-96`、`:117-122` | JOIN 丢行 + `continue` 丢行 + `status:'clean'` |
| #2 配置字段被丢弃 | 4 个 `loadPdConfig`（附录 A6）；`pd-config-types.ts` 声明字段 | 无字段覆盖率机制 |
| #3 遥测只接一处 | `pd-cli/tests/commands/workspace-telemetry-wiring.test.ts:17-31` | 守卫硬编码 4 个命令文件 |
| #4 三宿主各修一遍 | `openclaw-plugin/src/core/rule-host.ts`、`host-runtime/src/production-rulehost-gate.ts`；commit `dfa673639` 两处各改一次 | 同缺陷双修 |
| #5 `apply_patch` 字段不一致 | 9 个文件引用 `apply_patch`（codex-adapter/tool-semantics.ts 等） | 工具语义无单一注册表 |
| #6 晋升进度不可见 | `promotion-readiness-evaluator.ts:62-71` | 5 阈值压成 1 布尔 |
