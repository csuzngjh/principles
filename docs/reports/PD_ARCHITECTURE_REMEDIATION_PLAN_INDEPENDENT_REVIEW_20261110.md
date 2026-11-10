# 架构复杂度整改计划 — 独立评审

- 评审对象：`docs/plans/2026-11-10-architecture-complexity-remediation-plan.md`
- 依据报告：`docs/reports/PD_ARCHITECTURE_COMPLEXITY_REVIEW_20261110.md`
- 评审基线：`d:\Code\principles`，评审时工作区干净；所有结论以当前源码为准，不采信文档自述
- 评审方法：`codebase-design`（deep module / interface / seam / 信息隐藏）+ `domain-modeling`（术语与权威）
- 评审边界：只读。未修改产品代码，未修改计划与报告，未建分支

---

## 0. 裁定

**CONDITIONAL（有条件通过）**

方向是对的，阶段划分（5 → 3 → 1）也是合理的；但有 6 处事实判断与计划自述不符，其中 3 处会直接导致"批次做完、事故仍在"：

1. 事故 #2 的根因定位错了 —— 字段丢弃在 core 校验，不在 4 个 loader；
2. R4、S-R1 这两条"红→绿"测试今天就不会红；
3. 只读端口与"迁移 console 剩余 27 处"互相矛盾，执行到 1C 必然触发自己的停止条件。

另有 1 项被严重低估：**105 个测试文件、326 条直连 SQL 仍然绑定表结构**，它会让"改一次表结构只落 core"这个最大卖点基本落空。

修完必须修改项 M1–M12 后可以开工；其中 M1、M2、M3、M4 必须在动代码之前改计划，M6/M7/M9/M10 必须在对应批次开工前改验收口径。

---

## 1. 三组数字复算

### 1.1 口径

```powershell
$root='d:\Code\principles\packages'
$files=Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' }
$prod=$files | Where-Object {
  $_.FullName -notmatch '\\tests?\\|__tests__' -and $_.Name -notmatch '\.test\.tsx?$' }
```

"生产代码口径"= 排除 `node_modules`、`dist`、`tests/`、`__tests__`、`*.test.ts(x)`。

### 1.2 第一组：第 0 阶段改动面

| 项目 | 计划值 | 复算值 | 差异原因 |
|---|---|---|---|
| 产线文件 | 11（core 6 + cli 1 + console 4） | **13** | 漏算 `activation/index.ts`、`runtime/index.ts` 两个桶导出 |
| 测试文件 | 8 | **至少 3 个构造夹具；计划点名的断言文件 5 个** | "8"无法复算 |
| 包 | 3（core / cli / console） | 3 | 一致 |

证据：

- 桶导出：`packages/principles-core/src/runtime/activation/index.ts:67-88`；`packages/principles-core/src/runtime/index.ts:1545` 显式再导出。
- 构造夹具：`failedChecks:` 在测试中只命中 3 个文件（evaluator / reader / decision-service 测试）。
- `PromotionReadinessResult` 类型在测试中被显式引用的只有 1 个文件；其余是断言现有输出，不是构造。

**判断**：加一个新导出必然改 2 个桶文件；"11 个产线文件"应改为 13。"8 个测试文件"应改为"3 个构造夹具 + 5 个断言文件（合计 8 个，但性质不同）"，否则估算会把纯断言文件当成类型迁移成本。

### 1.3 第二组：报告三个关键数

| 指标 | 报告/计划值 | 复算值 | 差异原因 |
|---|---|---|---|
| `new SqliteConnection(` | 70 处 / 45 文件 | **70 / 45** | 一致 |
| `from 'better-sqlite3'` | 33 文件 | **33 文件 / 34 处** | 计划附录命令注释写 `# 33`，同一条命令实际输出 34 |
| `CREATE TABLE` | 54 条 | **54 / 8 文件** | 一致（含 console `e2e-seed` 2 条） |
| 4 套规则评估 | 842 / 802 / 705 / 1226 | **非空行 842 / 802 / 705 / 1226**；总行 881 / 842 / 731 / 1279 | 报告用的是"非空行"口径，计划未注明 |
| 4 个独立 `loadPdConfig` | 4 | **4 个函数** | 数字对，定性不准确（见 §2.2） |

按包分布（直连 SQLite 构造）：console 35 处 / 17 文件，host-runtime 14 / 9，pd-cli 10 / 10，openclaw-plugin 7 / 6，principles-core 4 / 3。

**判断**：

- 存储与建表的数字完全可复算，报告这一部分可信。
- 规则实现的数字是"非空行"，不是文件总行；引用时应写明口径，否则每次复核都会出现 40 行左右的假差异。
- 计划附录的 `# 33` 与命令输出 34 不一致，属于可复现性瑕疵：读者照抄命令会得到不同数字。

### 1.4 第三组：批次独立性抽查

| 批次 | 计划主张 | 验证结果 | 证据 |
|---|---|---|---|
| 5C | 每批可独立 revert | **不成立**：5B 读取 `criteria`，单独回退 5C 会破坏 5B | 5A→5B→5C 是类型上的前后依赖 |
| 3D | 读写分开 revert | **不成立**：读委托、3 个写入口、`writeWorkspaceConfig` 的诞生捆在同一批 | 3A 只定义 `readWorkspaceConfig`；写函数没有独立批次 |
| 1C | 用只读端口迁移 console 剩余 27 处 | **自相矛盾**：console 有 8 处 `readonly:false` 写连接（2 个文件）；1A 端口只读，4.6 停止条件第 1 条禁止写入 | `Select-String 'readonly: false'` 统计 |

**判断**："每批可独立 revert"只在**逆序回退**时成立。应改为："批次按逆序可回退；单独回退中间批次不成立，因为后面批次依赖它新增的类型/函数。" 这不是致命问题，但会误导 Owner 以为可以任选一批撤回。

---

## 2. 对计划判断的验证

### 2.1 顺序（5 → 3 → 1；2、4 暂缓）是否最优

**结论：顺序本身合理，但缺一个更底层的横切原语，建议放进 5A 之前，而不是重排阶段。**

- 5 → 3 → 1 的理由成立：5 是最便宜、可观测性收益最高的一步；3 是文件读取，不碰数据库，风险低于 1；1 最大，最后做。
- 但 Phase 1 的端口要返回 `Outcome`（`ok / reason / nextAction`），Phase 5 要返回 `criteria[]`（`checkId / status / unavailable`）。当前仓库**没有任何共享的 `Outcome` 类型**（全仓搜索无匹配）。如果先做 Phase 5、再做 Phase 1，就会在同一次整改里造出两套"带原因的结论"词汇 —— 这正是计划自己反对的"第二套权威"。
- 建议：不重排阶段，只在 5A 之前加一个 0.5 批：在 core 定义一个最小的结论词汇（`ok`、`reasonCode`、`nextAction`、`status: 'ok' | 'failed' | 'unavailable'`），并在 5A 与 1A 都复用它。仓库已有可参考的既有形状：`packages/principles-core/src/host/host-installer.ts:106,156` 的 result（`reason` + `nextAction`），符合"Connection Before Creation"。

**暂缓项的触发条件是否可操作**

| 项 | 条件 | 可操作性 |
|---|---|---|
| 第 2 项（规则评估四合一） | ① 第 5 项 criteria 已合并 | **可执行、可验证**（类型/提交是否存在） |
| | ② PRI-1044 真机验证关闭 + 连续 30 天无新宿主适配改动 | **弱**：仓库里 `production-rulehost-gate.ts`、`rule-host.ts` 在 2026-11-07 仍有改动，安装器 11-08 仍有改动；"连续 30 天不动"在活跃仓库里接近永远等不到 |
| | ③ 同一缺陷在 ≥2 宿主各修一次的"第二次实例" | **反应式**：需要先再出一次事故，属于等 bug |
| 第 4 项（安装五阶段） | ① `writeWorkspaceConfig` 已合并 | 可执行 |
| | ② 安装侧 30 天无改动 | 弱（同上） |
| | ③ binding 版本不同步类问题第二次实例 | 反应式 |

**判断**：每项只有一个条件真的可执行。建议把 ②③ 改成事件触发 + 到期复核：

> 第 2 项：criteria 合并后，若任一 PR 同时修改 `production-rulehost-gate.ts` 与 `rule-host.ts`，即启动；否则每 6 周复核一次，记录"继续暂缓"的理由。

这比"30 天无改动"更容易真正执行，也不会变成永久托词。

### 2.2 事故 #2：字段丢弃的根因层

计划把"配置一读一写"的根因写成"4 个独立 reader，某个 reader 丢弃 `runtimeProfiles.*.systemPrompt`"。**这与源码不符。**

| 事实 | 证据 |
|---|---|
| `systemPrompt` 在类型中声明 | `pd-config-types.ts:113-117` |
| 消费方读取 `profile.systemPrompt` | `pd-config-agent-binding.ts:277-278` |
| `pd-config-validate.ts` **全文没有 `systemPrompt`** | `Select-String 'systemPrompt'` 无命中 |
| `validateRuntimeProfile` 只逐字段拷贝，未拷贝 `systemPrompt` | `pd-config-validate.ts:305-315,319` |
| 4 个 loader 都调用 core 校验 | pd-cli `loadPdConfig:112`、host-runtime `loadPdConfigForPlugin:75`、console `loadPdConfig:249`、installer `validateConfigYamlFull:481` |
| effective 若拿到字段会保留（展开拷贝） | `pd-config-effective.ts` 的 `{ ...profile }` |

**判断**：

- 根因在 **core 的 `validateRuntimeProfile` 字段拷贝不全**，一处代码影响全部 4 个入口。合并 4 个 loader 不会修复事故 #2；做 3B/3C 之后 `systemPrompt` 仍然丢。
- 真正修复它的是 3A 的"字段覆盖率测试 + 补齐 validate/effective 拷贝"。因此 **3A 应成为 Phase 3 的唯一必做批**，3B/3C/3E 降级为可选。
- 这也意味着计划 §5 收益表里"新增一个配置字段现在要改 8 文件/3600 行"不成立：4 个 loader 是字段无关的包装，新增字段从来不需要改它们。真实成本是 core 的 types + defaults + validate + effective（1,859 行）+ 消费方；改完仍然是这 4 个 core 文件 + 消费方。Phase 3 的真实收益是"漏读会被测试抓到"，不是"文件数减半"。

### 2.3 "空结果 vs 错误"：收口在存储层是否足够

**不够。存储层只解决"读"，下面这些层会重新制造同一个歧义，且都是现存的真实代码：**

| 位置 | 行为 | 为什么重新制造歧义 |
|---|---|---|
| `packages/principles-core/src/runtime/activation-compatibility-read-model.ts:66-70` | `state.db` 不存在时返回 `status:'clean'` + reason | 只看 `status` 的调用方会读成"扫描通过" |
| 同文件 `:81-96` | 工件/激活关联缺失时 `continue` 丢行 | 有激活但工件缺失 → 0 行 → `clean` + `scannedActivations: 0` |
| `packages/pd-console/src/server/models/OwnerDecisionConsoleModel.ts:339-342` | `catch { continue; }` | 读取失败 → 该待决项消失 → "没有待决"，与"读不到"同形 |
| `packages/pd-cli/src/commands/runtime-activation.ts:151,155` | 坏行 `/* exclude malformed telemetry */`、坏目录 `/* contributes no entries */` | 影子摘要静默少计，调用方只看到更小的数 |
| `packages/pd-console/src/ui/pages/activation/ActivationPage.tsx` | 只对 `evidence_insufficient` 与 `failedChecks` 有分支；未见 readiness `unavailable` 的独立文案 | 模型区分了，UI 又抹平 |
| `packages/pd-console/src/server/models/ActivationsConsoleModel.ts:451` | 悬挂工件已产出 `degraded` + reason | 模型层已区分，但页面未渲染该状态/原因 |
| console 侧 `readRuleCodeTelemetry` | 无源目录时返回 unavailable 摘要（null） | 页面用 `notCollected` 处理 null，这一点是**正确**的，不应算作缺陷 |

**判断**：Phase 1 的试点必须包含 `activation-compatibility-read-model` 与 `OwnerDecisionConsoleModel` 的 catch 分支，否则"事故 #1 类问题"在存储层修好之后仍会在 UI 和决策列表里复现。计划当前只把它们放在 Phase 5 的"状态过滤"里，层次错位。

### 2.4 "红→绿测试"是否真的先红

抽查 2 个批次 + 2 条新增测试：

| 测试 | 计划声称 | 验证 | 结论 |
|---|---|---|---|
| R4（CLI 与 Console 影子摘要逐字段相等） | 现在两个生产者不同函数，边界窗口会不等 | 两边都调用 core 的 `summarizeRuleCodeShadowEvents`；`collectRuleCodeEventEntries` 是逐字复制（`runtime-activation.ts:132-158` vs `ActivationsConsoleModel.ts:214-239`） | **今天就会绿**，不是红测试 |
| S-R1（缺工件的激活，Console model 返回"已启用/无异常"） | 现在无异常 | 模型已返回 `status:'degraded'` + reason；未渲染的是 UI | **模型层不会红**；红测试必须写 UI |
| S-R2（空表 vs 引用损坏都返回空数组） | 现在不可区分 | `activation-compatibility-read-model` 确实不可区分；但试点是 `ActivationsConsoleModel`，两者不是同一函数 | 红成立，**但打错了对象** |
| C-R1（host-runtime 读到的 `systemPrompt` 被丢） | 现在被丢 | 确实被丢，但原因是 core validate | 红成立，**归因错了** |
| 5A/5C（criteria 字段） | CLI 输出无字段 | 字段确实不存在 | 红成立 |

**判断**：R4 是"凑红"失败的反面 —— 它今天就是绿的，无法证明改造有效；S-R1 必须在 UI 层重写。其余红测试成立，但归因要改。

### 2.5 停止条件是否可执行

| 条件 | 判定 | 改进写法 |
|---|---|---|
| 5.6-1 端口出现写入 → 停 | **可执行** | 保留 |
| 5.6-2 结论需要新增 DB 表 → 停 | **可执行** | 保留 |
| 5.6-3 契约变更超出已核实测试文件 → 停 | **可执行** | 把"8 个"改成动态清单：开工前列出路径，超出即停 |
| 5.6-4 回归面超过预估 1.5 倍 → 停 | **不可执行**（没有"预估"基线） | 每批开工前写"预计改动文件清单（数量+路径）"，实际超出清单即停 |
| 5.6-5 事故 #1/#6 仍无法区分 → 停 | **不可执行**（没有判定 fixture） | 指定 fixture：`state.db` 缺失、激活存在但工件缺失、事件目录不可读 三种输入，逐一断言"不可混淆" |
| 3.6-4 / 4.6-5 "回归面 >1.5 倍" | 不可执行 | 同上，改成文件清单 |
| 4.6-6 "8 处中有一处依赖部分失败仍继续" | 半可执行 | 列出 8 处的判定输入；任一出现"部分失败仍返回 success"即停 |
| 4.6-1 "端口出现写入" | **与 1C 冲突** | 见 M4 |

**判断**：5 类里约 2 类是口号（"1.5 倍""无法区分"），其余可执行。所有"1.5 倍"都应替换成开工前写死的文件清单。

### 2.6 风险是否被低估

**（a）"测试 arrange 直连、assert 经端口"会不会形成生产一套、测试一套？**

会，而且规模比计划描述的大得多：**105 个测试文件、326 条直接操作 `activations` / `pi_artifacts` 的 SQL**（`FROM/INTO/UPDATE ... activations`、`pi_artifacts`）。端口只约束生产代码，测试仍是第二套写法，并且会在每次表结构变更时继续被牵动。计划没有给测试侧的收敛机制，只用"迁移期允许"带过。

这不是纯粹的风格问题：它直接推翻"改一次表结构只落 core"的收益。缓解办法必须写进计划（见 M7）。

**（b）33 个文件直连数据库库，迁移期如何避免两套写法并存？**

计划只有 1F 的 CI 守卫。但 1F 与 1D 冲突：

- 1D 允许把 `governance_*`（5 张表）登记为"独立库"，而它就在 host-runtime，仍然需要连接；
- 1F 又要求非 core 包的 `SqliteConnection` / `better-sqlite3` import 为 0。

二者不能同时成立。必须定义"已登记独立库"的豁免机制（登记表 + 测试），否则 1F 永远绿不了，或者被临时注释掉。

**（c）`host-runtime` 自建 5 张表的归属决策卡，选错代价与回退**

- 事实：`host-runtime/src/governance-observation-store.ts` 打开 `trajectory.db` 并建 5 张 `governance_*` 表；这是观察/轨迹域，不是 core 的 Principle 生命周期域。
- 若"迁回 core schema 所有权"：core 需要接管 DDL 与迁移，但计划明确"不改表结构、不写迁移"；结果只能是 core 也执行 `CREATE TABLE IF NOT EXISTS`，形成第二套 DDL 真相（违反 P4），且两处 DDL 漂移没有守卫。
- 若"登记为独立库"：成本低、可回退，但需要在 1F 里有正式豁免，且要有登记表测试防止第三个野生库出现。
- **建议选后者**，并把"独立库登记表 + 守卫测试"作为 1D 的验收；回退方式是删除登记项（代码路径不变），代价低。选前者的回退代价是 schema 所有权二次迁移，明显更高。

### 2.7 人日估算

计划合计 13–20.5 人日。按复算的触面，**实际更可能是 20–30 人日**。

| 批次 | 计划 | 我的判断 | 依据 |
|---|---|---|---|
| Phase 1 总计 | 7–10 天 | **11–17 天** | 非 core 产线文件 42 个（计划写"约 25"）：console 17、host 9、cli 10、openclaw 6；console 35 处里含 8 处写连接；每处需要语义查询设计 + 测试；再加 105 个测试文件的回归面 |
| 1C（27 处） | 1.5–2 天 | **4–7 天** | 27 处跨约 14 个文件，含写路径；平均每处 1–2 小时是下限 |
| 3D（读委托 + 3 写入口 + YAML 保注释写回） | 1.5–2.5 天 | **3–5 天** | 保注释的 YAML 写回需要 document API；3 个写入口语义不同；还要双语文案/测试 |
| 5B（criteria 进 console + CLI） | 1–1.5 天 | **1.5–2.5 天** | 漏算 `ui/i18n/zh-CN.json` 与 `en.json` 双字典、`.changeset`、console API 契约测试 |
| 10 个 checkId + 4 阈值 + 1 源不可用 | 计入 5A 的 1–1.5 天 | **2–3 天** | 计划写"5 类硬检查"，实际 10 个 required checkId |

未计入的固定成本：`.changeset`（仓库有 `.changeset` 目录）、`io-seam-registry.json` 登记、架构守卫修复、E2E/BDD、评审往返。建议把总额改成 20–30 人日，或把 1C/1D 的范围缩到"只迁移读写试点 + 3 个高频模块"。

---

## 3. Owner 问题：执行完之后，AI 改一个典型需求的负担下降多少

用可复算的方式表达。数字都是"必须打开的文件 / 行数"，按任务类型分开，因为三类任务的收益差异很大。

### 3.1 任务 A：查"这个激活为什么晋升不了"（诊断）

| 阶段 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| 现在 | 11 | **9,416** | evaluator 73 + reader + decision-service + snapshot + shadow-summary + openclaw-promotion-checks + CLI `runtime-activation.ts` + `ActivationsConsoleModel.ts` + `OwnerDecisionConsoleModel.ts` + `validators.ts` + `ActivationPage.tsx` |
| 计划后 | 1（先读输出）+ 2（必要时定位） | **约 500–900** | criteria 直接给出 `checkId/status/reason`；只有判断"谁产出了这个 check"时才回读 evaluator/reader |

**下降约 85–95%**，这是整个计划最真实、最大的收益。前提是 5A 覆盖全部 10 个 checkId，否则仍然要翻 `openclaw-promotion-checks.ts`。

### 3.2 任务 B：加一个配置字段（修改）

| 阶段 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| 现在 | 4–5 | **1,859 + 消费方** | types 488 + defaults 140 + validate 932 + effective 299；4 个 loader 是字段无关包装，**从来不需要按字段修改** |
| 计划后 | 4–5 | 同上 | 3A 不会减少文件数；它增加的是"漏改 validate/effective 会红" |
| 计划声称 | 8 → 2 | 3,600 → 1,200 | **不成立** |

**下降接近 0（文件数不变）**，收益是"不再静默丢字段"。这不是坏事，但不应被写成"减少一半阅读量"。

### 3.3 任务 C：改一次工作区表结构（修改）

| 阶段 | 产线文件 | 测试文件 | 说明 |
|---|---|---|---|
| 现在 | 45 | **105（326 条直连 SQL）** | 直连构造 70 处 |
| 计划后 | 约 3–6（core 内） | **105（不变）** | 测试 arrange 仍直连；表结构变更仍会让大量测试夹具失效 |

**下降有限**：产线侧显著下降，测试侧几乎不变。这是计划最大收益主张的漏洞。

### 3.4 需要记住的隐含约定数

现在至少 8 条：可写表清单、配置字段的四层接线、快照 digest 输入、状态优先级（unavailable > blocked > evidence_insufficient > ready）、10 个 required checkId、测试 arrange/assert 规则、安装器配置保留语义、两套影子摘要采集。

计划后预计 **8–9 条**：上面前 6 条中的一部分被文档化，但新增 criteria 词汇、fieldStatus 语义、端口读写边界、独立库登记表。**净减少 1–2 条，不是数量级下降。**

### 3.5 计划没有覆盖、但同样影响 AI 维护成本的部分

- **测试可读性与规模**：1,350 个测试文件 / 402,641 行，已经大于产线（999 文件 / 284,024 行）。计划只处理"测试怎么写 SQL"，没有处理"测试怎么找得到"。
- **`validators.ts`（3,934 行手写白名单）**：每加一个 API 字段就要加一条；5C 会碰到它，但没有治理方案。
- **`runtime/index.ts`（2,147 行桶文件）**：新增公共导出都从这里走；计划没把它算进改动面。
- **命名与文档一致性**：`runtime-v2` 刚改名 `runtime`，`CONTEXT.md` 与架构文档的漂移会直接增加 AI 的检索成本。计划不包含文档同步。
- **双语文案**：新 UI 状态/原因必须同时改 `zh-CN.json` 与 `en.json`，否则会出现只在一半语言里可读的状态。
- **发布机制**：core 新增公共导出需要 `.changeset`；计划没提，PR 可能卡在 release 检查。

---

## 4. 必须修改项

### M1. 重写事故 #2 的归因与 Phase 3 的范围

- **改什么**：把"4 个 reader 丢弃字段"改为"core `validateRuntimeProfile` 拷贝字段不全（`systemPrompt` 未拷贝）"；把 3A（字段覆盖率 + 补齐 validate/effective）设为必做；3B/3C 合并为可选一批；3E 延后。
- **为什么**：4 个 loader 都调用同一 core 校验；合并不修复事故。
- **不改的后果**：Phase 3 做完，C-R1 仍然红；Owner 会认为整改无效。

### M2. 删除或重写 R4

- **改什么**：R4 改为"两份 `collectRuleCodeEventEntries` 源码/行为等价的守卫"，并把重复的收集函数提取到 core（这是计划漏掉的真实收口）。若坚持保留"两份摘要一致"测试，必须承认它当前就是绿的，只能作为回归保护，不能作为"先红后绿"的证据。
- **为什么**：两边已共用 `summarizeRuleCodeShadowEvents`，收集函数逐字复制。
- **不改的后果**：测试造假绿，掩盖真正的复制漂移风险。

### M3. 重写 S-R1，并把两处真实歧义纳入 Phase 1

- **改什么**：S-R1 的红测试写在 UI 层（页面未渲染 `degraded`/reason）；把 `activation-compatibility-read-model.ts:66-70,81-96` 与 `OwnerDecisionConsoleModel.ts:339-342` 纳入 Phase 1 范围。
- **为什么**：模型层已区分，UI 层未渲染；决策列表 `catch { continue; }` 是同一失败模式的另一处。
- **不改的后果**：存储层修好后，用户仍看到"一切正常"，事故 #1 复发。

### M4. 解决只读端口与写路径的矛盾

- **改什么**：二选一 —— 端口拆成 `WorkspaceStateReader` / `WorkspaceStateWriter`（写侧定义事务与 fail-closed），或把 1C 拆成 1C-read（本阶段）与 1C-write（后续）。同时修正 4.6 停止条件第 1 条。
- **为什么**：console 有 8 处 `readonly:false`；1C 声称迁移 27 处。
- **不改的后果**：执行到 1C 必然停摆，或偷偷放宽停止条件。

### M5. 把"独立 revert"改为"逆序可回退"，并拆分 3D

- **改什么**：文档改为逆序回退；3D 拆成 3D-read / 3D-write（`writeWorkspaceConfig` 单独一批）；1C 按读写拆提交。
- **为什么**：抽查 5C、3D、1C 均不满足独立回退。
- **不改的后果**：回滚演练时才发现无法单批撤回。

### M6. 修正触面与人日

- **改什么**：Phase 1 非 core 产线文件从"约 25"改为 **42**（console 17、host 9、cli 10、openclaw 6）；总人日改为 20–30，或缩小 1C/1D 范围。
- **为什么**：复算数字；1C 27 处跨约 14 文件且含写路径。
- **不改的后果**：排期必然超支，超支后容易用"先合再修"掩盖。

### M7. 给测试侧一个真实收敛机制

- **改什么**：新测试一律通过 core 的 arrange/seed helper 造状态；存量按"改动到的文件必须顺手迁移断言"执行；1F 增加"测试目录直连 SQL 计数"基线，只降不升。
- **为什么**：105 个测试文件 / 326 条直连 SQL 会让表结构变更继续全仓扩散。
- **不改的后果**："改一次表结构只落 core"落空，两套写法长期并存。

### M8. 解决 1D 与 1F 的冲突

- **改什么**：定义"已登记独立库"的豁免机制（登记表 + 测试），或明确 `governance_*` 只能通过 core 提供的连接工厂访问。
- **为什么**：1D 允许独立库，1F 禁止任何非 core 连接。
- **不改的后果**：1F 的 CI 守卫要么永远红，要么被注释掉。

### M9. 补 core I/O seam 登记与架构守卫

- **改什么**：1A 若新增 core 端口并 import `node:fs` 或直接打开 DB，必须在 `packages/principles-core/io-seam-registry.json` 登记，并把"architecture-regression 通过"写进验收。
- **为什么**：`AGENTS.md` §8.1 "No unregistered core I/O"；registry 文件存在。
- **不改的后果**：PR 被架构守卫拦住，或绕过守卫造成 core I/O 失控。

### M10. criteria 覆盖 10 个 checkId，不是 5 类

- **改什么**：5A/5B 的验收改为覆盖 `REQUIRED_PROMOTION_CHECK_IDS`（10 项，`promotion-readiness-evaluator.ts:3`）+ 4 个数值阈值 + 1 个源不可用；按此重算 5A 工作量。
- **为什么**：只产 5 类会让 evaluator 的 `required_check_missing` 把结果判成 unavailable。
- **不改的后果**：5A 完成后回归大面积变红，或 criteria 与 status 再次不一致。

### M11. 补 i18n 与 changeset

- **改什么**：5B 增加 `ui/i18n/zh-CN.json` 与 `en.json` 双字典；Phase 3/5 的公共导出加 `.changeset`。
- **为什么**：仓库要求双语；`.changeset` 存在且发布流程依赖。
- **不改的后果**：中文/英文只有一半可读；PR 卡在发布检查。

### M12. 停止条件里的"1.5 倍"改为文件清单

- **改什么**：每批开工前写"预计改动文件清单（数量+路径）"，实际超出即停；"事故 #1/#6 无法区分"改为三种 fixture 的断言。
- **为什么**：当前条件没有基线，无法判定。
- **不改的后果**：停止条件只能靠事后解释，失去约束力。

---

## 5. 可选优化项

| 项 | 收益 | 代价 |
|---|---|---|
| O1. 在 5A 前定义一次共享结论词汇（`ok/reasonCode/nextAction/status`），Phase 1 复用；参考 `host-installer.ts:106,156` | 避免两套"带原因的结论"，减少一个隐含约定 | 多一个小批次（0.5–1 天） |
| O2. 3B/3C 合并为一批"两个同构包装委托 core" | 少一轮评审与回归 | 单批 diff 变大 |
| O3. 把 `activation-compatibility-read-model` 拆出 `not_scanned` 状态，作为 Phase 1 的第二个试点 | 直接命中事故 #1 的原始代码位置 | 需要同步 CLI 输出与测试 |
| O4. 5A 之前先加特征化测试锁定 10 个 checkId 的现有行为与状态优先级 | 防止 criteria 改造改变 blocked 优先级 | 半天成本 |
| O5. 收益表按"诊断/修改"分开写 | 避免用诊断收益给修改背书 | 无 |

---

## 6. 计划与报告都没提的问题

1. **105 个测试文件、326 条直连 SQL** 绑定 `activations` / `pi_artifacts`。这是存储收口收益的最大漏洞。
2. **`OwnerDecisionConsoleModel.ts:340-342` 的 `catch { continue; }`**：读取失败被当成"没有待决项"，与事故 #1 同构，但不在任何批次的范围内。
3. **`runtime-activation.ts:151,155`**：坏行与坏目录被静默忽略，影子摘要会静默少计；由于 console 有逐字复制，两边会一致地少计 —— 任何"两份摘要相等"的测试都发现不了。
4. **`activation-compatibility-read-model` 在 `state.db` 缺失时返回 `status:'clean'`**（reason 有值但 status 误导）。只读 status 的调用方会误判。
5. **仓库没有共享 `Outcome` 类型**，Phase 1 与 Phase 5 会各造一套。
6. **`.changeset` 与双语文案**未纳入任何批次。
7. **`io-seam-registry.json` 与 `AGENTS.md` §8.1** 的登记义务未纳入 1A 验收。
8. **Console 页面不渲染 `degraded`**：即使 Phase 1 把模型修对，用户仍看不到原因；该缺口可能正好落在 Phase 1 与 Phase 5 之间。
9. **`ActivationsConsoleModel` 8 次构造里有写连接**；35 处 console 直连分布在 17 个文件，不是 12 个。
10. **计划附录 `# 33` 与实际 34 处不一致**，复现性瑕疵。
11. **`REQUIRED_PROMOTION_CHECK_IDS` 是 10 项**，计划写"5 类硬检查"。
12. **`runtimeProfiles` 的 effective 展开是保字段的**，丢弃发生在 validate；"reader 丢字段"的表述会误导修复位置。
13. **Phase 0 的"8 个测试文件"不可复算**：只有 3 个构造夹具，5 个是断言文件。

---

## 7. 我不建议采纳的修改

1. **不建议把"删除重复 loader"当成 Phase 3 的验收门槛。** 它不修复事故 #2，还会把安装器（最热文件）的失败语义改严；3E 的风险高于收益。
2. **不建议把 `PromotionReadinessResult` 拆成多个小类型或新包来"提高可读性"。** 会增加接口数量，违反 deep module 的 leverage 原则；一个结果类型 + `criteria[]` 已经足够。
3. **不建议对测试目录一刀切禁止 SQL。** 会逼出大量隐藏 SQL 的假夹具，反而降低可读性与排错能力；用"计数基线只降不升"更稳。
4. **不建议因为 R4 当前是绿的就把"两份摘要一致"整个删掉。** 应改成源码/行为等价守卫，并把收集函数提 core，防止复制漂移。
5. **不建议用"连续 30 天无改动"作为唯一触发条件。** 应改为"下次修改这两个文件时顺带评估"的事件触发 + 到期复核记录。
6. **不建议在 Phase 1 就迁移全部 70 处。** 先做读侧 + 3 个高频模块，写侧单独设计；一次性迁移会让回归面不可控。

---

## 8. 建议的修订后批次表

| 批次 | 内容 | 相对计划的改动 |
|---|---|---|
| 0.5 | core 定义结论词汇（`ok/reasonCode/nextAction/status`） | 新增 |
| 5A | criteria 覆盖 10 个 checkId + 4 阈值 + 1 源不可用；先加特征化测试 | 范围扩大，工作量重估 |
| 5B | criteria 进 console/CLI + 双语字典 | 补 i18n/changeset |
| 5C | 删除重复派生调用（逆序可回退） | 声明改为逆序 |
| 3A | core 字段覆盖率 + 补齐 validate/effective 拷贝 | **升为必做，事故 #2 的真正修复** |
| 3B/3C | 两个同构 loader 委托 core（合并为一批，可选） | 降级 |
| 3D-read | console 读委托 core | 拆分 |
| 3D-write | `writeWorkspaceConfig` + 3 个写入口收敛 | 独立批次，重估 3–5 天 |
| 3E | 安装器改为消费 core 校验 | 延后，单独决策 |
| 1A | 端口（读 + 写两侧）+ io-seam 登记 | 补登记与守卫验收 |
| 1B | 试点：`activation-compatibility-read-model` + `ActivationsConsoleModel` + `OwnerDecisionConsoleModel` catch 分支 | 试点对象修正 |
| 1C-read | console 读侧剩余部分 | 拆出写侧 |
| 1C-write | console 写侧（8 处） | 新增独立批次 |
| 1D | host-runtime（独立库登记 + 豁免测试） | 补登记机制 |
| 1E | cli + openclaw | 不变 |
| 1F | 守卫（生产 + 测试计数基线） | 补测试基线 |

---

## 附录 A：复算命令与原始结果

```powershell
# 1) 直连 SQLite / 直连 better-sqlite3 / CREATE TABLE
$root='d:\Code\principles\packages'
$files=Get-ChildItem $root -Recurse -File -Include *.ts,*.tsx |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' }
$prod=$files | Where-Object {
  $_.FullName -notmatch '\\tests?\\|__tests__' -and $_.Name -notmatch '\.test\.tsx?$' }
$sc=$prod|Select-String -Pattern 'new SqliteConnection\('
$bs=$prod|Select-String -Pattern "from 'better-sqlite3'"
$ct=$prod|Select-String -Pattern 'CREATE TABLE'
"SC_OCC=$($sc.Count) SC_FILES=$(($sc|ForEach-Object{$_.Path}|Sort-Object -Unique).Count)"
"BS_OCC=$($bs.Count) BS_FILES=$(($bs|ForEach-Object{$_.Path}|Sort-Object -Unique).Count)"
"CT_OCC=$($ct.Count) CT_FILES=$(($ct|ForEach-Object{$_.Path}|Sort-Object -Unique).Count)"
```

结果：`SC_OCC=70 SC_FILES=45`；`BS_OCC=34 BS_FILES=33`；`CT_OCC=54 CT_FILES=8`。

```powershell
# 2) 按包的直连分布（occ/files）
$sc|Group-Object { ($_.Path.Substring($root.Length+1) -split '\\')[0] } |
  ForEach-Object { $fs=($_.Group|ForEach-Object{$_.Path}|Sort-Object -Unique).Count;
    "$($_.Name): occ=$($_.Count) files=$fs" }
```

结果：console 35/17，host-runtime 14/9，pd-cli 10/10，openclaw-plugin 7/6，principles-core 4/3。

```powershell
# 3) 规则实现行数（总行 vs 非空行）
@('openclaw-plugin\src\core\rule-host.ts','openclaw-plugin\src\hooks\gate.ts',
  'host-runtime\src\production-rulehost-gate.ts','pd-cli\src\services\rulehost-pipeline-runner.ts') |
  ForEach-Object { $p=Join-Path $root $_; $t=(Get-Content $p).Count;
    $n=(Get-Content $p | Measure-Object -Line).Lines; "$_ total=$t nonblank=$n" }
```

结果：`881/842`、`842/802`、`731/705`、`1279/1226`。

```powershell
# 4) 配置 loader
Get-ChildItem $root -Recurse -File -Include *.ts |
  Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\' } |
  Select-String -Pattern 'export function (loadPdConfig|loadPdConfigForPlugin|validateConfigYamlFull)'
```

结果 4 个定义：`host-runtime/src/pd-config.ts:75`、`pd-cli/src/services/pd-config-loader.ts:112`、
`pd-console/src/server/config/pd-config-store.ts:249`、`create-principles-disciple/src/mvp-config.ts:481`。

```powershell
# 5) 调用点
37 处 / 30 文件（loadPdConfigForPlugin）
53 处 / 29 文件（loadPdConfig）
合计 90 处 / 59 文件
```

```powershell
# 6) 测试直连 SQL（存储收益的关键反证）
$tests=$files | Where-Object { $_.FullName -match '\\tests?\\|__tests__' -or $_.Name -match '\.test\.tsx?$' }
$t=$tests|Select-String -Pattern 'FROM activations|INTO activations|UPDATE activations|JOIN pi_artifacts|FROM pi_artifacts|INSERT INTO pi_artifacts'
"TEST_OCC=$($t.Count) TEST_FILES=$(($t|ForEach-Object{$_.Path}|Sort-Object -Unique).Count)"
```

结果：`TEST_OCC=326 TEST_FILES=105`。

```powershell
# 7) 规模
PROD_FILES=999  PROD_LINES=284024
TEST_FILES=1350 TEST_LINES=402641
READINESS_CHAIN_LINES=9416（11 个文件）
CORE_CONFIG_4=1859（types 488 + defaults 140 + validate 932 + effective 299）
LOADER_4=3231（593 + 123 + 1820 + 695）
```

## 附录 B：关键证据位置

| 结论 | 证据 |
|---|---|
| 10 个 required checkId | `principles-core/src/runtime/activation/promotion-readiness-evaluator.ts:3` |
| 4 个数值阈值 / 状态三元式 | 同文件 `:65-68`、`:70` |
| 工件缺失返回 blocked + artifact_not_found | `principles-core/src/runtime/activation/promotion-readiness-reader.ts:32` |
| `clean` + `scanned 0` 的歧义 | `principles-core/src/runtime/activation-compatibility-read-model.ts:66-70,81-96` |
| 模型已产出 degraded + reason | `pd-console/src/server/models/ActivationsConsoleModel.ts:451` |
| 决策列表静默丢项 | `pd-console/src/server/models/OwnerDecisionConsoleModel.ts:339-342` |
| CLI 静默忽略坏行/坏目录 | `pd-cli/src/commands/runtime-activation.ts:151,155` |
| 两份收集函数逐字复制 | `pd-cli/src/commands/runtime-activation.ts:132-158`；`pd-console/src/server/models/ActivationsConsoleModel.ts:214-239` |
| `systemPrompt` 类型声明 / 消费 | `pd-config-types.ts:113-117`；`pd-config-agent-binding.ts:277-278` |
| validate 全文无 `systemPrompt` | `pd-config-validate.ts`（`Select-String` 无命中） |
| 桶导出 | `activation/index.ts:67-88`；`runtime/index.ts:1545` |
| core I/O seam 登记表存在 | `principles-core/io-seam-registry.json` |
| `.changeset` 存在 | `.changeset/` |
| 双语文案 | `pd-console/src/ui/i18n/zh-CN.json`、`en.json` |
| 8 处 console 写连接 | `Select-String 'readonly: false'`：8 处 / 2 文件 |
| `ActivationsConsoleModel` 8 次构造 | `Select-String 'new SqliteConnection\('`：8 |
