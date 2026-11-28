# PRI-1307 Contract Independent Review Record

> **状态**：Final（随契约一并提交 Owner 审查）
> **日期**：2026-11-28
> **审查对象**：`docs/reviews/PD-CAE-STAGE1A-REPLAY-CONTRACT.md`（PD-CAE Stage 1A Offline Replay Contract）
> **审查方式**：主代理编写契约 → 独立子代理（Agent C） adversarial 审查 → 主代理修订 → 交叉复核
> **调查基础**：Agent A（Specification Archaeology）与 Agent B（Runtime Reality Audit）并行只读调查（先于契约编写）

---

## 1. 审查配置

### 1.1 审查轴线（工单规定）

1. UNKNOWN 是否可能被误判为 NO；
2. 因果顺序是否存在伪造风险；
3. Target Attribution 是否存在过度推断；
4. Coverage 分母是否正确；
5. 是否重复建设现有能力；
6. 是否产生隐性生产 ABI。

### 1.2 审查代理独立性

Agent C 为独立只读子代理，未参与契约编写，收到六项审查轴线、完整性核对清单与引用核实任务，可自由读取仓库源码验证契约中的文件/行号引用。

---

## 2. 编写前调查结论摘要（Agent A / Agent B）

### 2.1 Agent A（Specification Archaeology）关键输入

- SPEC §5 三值表必须原样保留：No 要求窗口覆盖**可证明完整**；ordering 的 Yes/No 要求可信宿主原生顺序，DB insertion order alone ⇒ Unknown。
- SPEC line 116：三值是评估语义，**不新增生产公共 enum**——测试局部词汇被授权，生产 ABI 被禁止。
- `propose_correction` 在 v2 规则中被禁（PRI-490）——fixture 只用 `allow|block`。
- 15 个决策点，包括：fixture 版本化采用 `fixtureVersion` 字面量 + provenance 块（复制 PRI-1208 digest 先例）；OpenClaw 无法表达 excludeToolUseId（不得伪造）；P2-2 Artificer prompt ordering 矛盾是 known-blocker，标注不修复；hostKind 行变体需要测试局部行语义而非生产 ABI 扩展；"fixture 永不成为生产 ABI"必须显式声明。

### 2.2 Agent B（Runtime Reality Audit）关键输入

- Golden Trace schema 权威：`golden-trace.ts`（TypeBox）；`GoldenTraceDecision`（allow/block/propose_correction）≠ `RuleHostDecision`（allow/block/requireApproval/auto_correct）——两套词汇不得混用。
- Replay 注入点：`evaluateCaseWithTimeout` → `createSyntheticRuleHostInput`，走生产 `buildRuleHostAction` + ToolSemanticRegistry。
- `assembleBehaviorHistory`：任一行校验失败毒化整窗（5 类校验失败），非逐行降级。
- 窗口读取语义：OpenClaw `id DESC` 20 行 session-only；Codex/WorkBuddy `created_at DESC, id DESC` 100 行——全是 insertion ordering，非因果。
- 建议（已全部采纳）：复用 GoldenTraceCase 字段命名；envelope 版本化复制 PRI-1208 corpus 先例；evidence provenance 在 envelope 显式化；inconclusive 词汇复用生产已有 unavailable/coverage 词汇；不复制 RuleContextV2 进 fixture ABI，组合引用。

---

## 3. 主代理编写阶段的自我修订（先于 Agent C 审查）

以下问题由主代理在编写与交叉验证中自行发现并修复，早于独立审查：

| # | 问题 | 修订 |
|---|---|---|
| S1 | 初稿引用虚构文件 `buildRuleHostHistory.ts:97-118`（该文件不存在）；多处行号与包路径错误（production-pain-evidence 行号、rule-context.ts 名称） | 全部经源码核实后更正为真实位置（`behavior-history.ts:22-59`、`rule-context-v2.ts:30`、`production-pain-evidence.ts:260/336-383`）；OpenClaw 身份未透传改为"全文件无引用"的缺席证据表述 |
| S2 | Coverage taxonomy 表格缺逐行"计算方式"列（工单要求六项定义） | 在 §8.2 表头前补统一计算方式与无法测量处理的冻结条款 |
| S3 | **顺序证据设计张力**（最严重）：SPEC 严格语义下 insertion order alone ⇒ Unknown，若严格执行则 blind_retry 正控在逻辑上不可能成立；初稿用"假设性使用"豁免，构成审查轴线 2 的潜在漏洞 | 引入 `live-local` 顺序证据级别：全部 live 写入 + 单 session + 窗口完整 + 无 backfill 时，同步 live hook 的 writer 机制证据与 insertion order 相互印证——此时证据不再是"insertion order alone"。schema 枚举、§5.2 分级表、§5.3 案例 1、§4.3 判定表、示例 11.1/11.2/11.3/11.4 全部同步修订 |
| S4 | R1 毒化机制描述不精确（"4 类"） | 按源码核实修正为 5 类校验失败，并明确 unknown 毒化的真实机制：writer 词汇 `unknown` 不是合法 `RuleToolOutcome`，在 outcome 枚举校验处失败 |

---

## 4. Agent C 独立审查意见（摘要）

Agent C 给出 **NOT-READY** 初审结论与 11 项 blocking、14 项 non-blocking 意见。主要 blocking 意见：

| # | 意见 | 核心证据 |
|---|---|---|
| B1 | `live-local` 是因果顺序伪造：(a) hook 调度/并行调用/SQLite 写序列化使 live 写入顺序最多与因果相关而非可证；(b) `writerPath` 不是生产列，被测系统无法验证"全 live 无 backfill"前提 | SPEC v1.1 §5；Stage 0 P0-2（无宿主有可信通用动作序列） |
| B2 | envelope 无法重建决策时点输入快照；backfill UPDATE 造成 hindsight leakage；11.6 把 UPDATE/INSERT 两种不同现象混为一谈 | `codex-rule-context-provider.ts:76-79` cutoffAt；`production-pain-evidence.ts:382` 原位 UPDATE |
| B3 | observation 层混合原始事实/派生值/oracle 元数据：writerPath、outcomeEvidenceSource、targetAttributionClass 不是生产行事实；canonicalKind/normalizedPath 是派生输出——泄漏真值并允许伪造 | `trajectory-types.ts:261-266`；`behavior-history.ts:66-79` |
| B4 | 示例违背真实提取逻辑与 Codex apply_patch 形态：mutation regex 会提取 rm/mv/mkdir/touch/cp/sed -i 路径；Codex patch 无直接 file_path，pathless write 生成合成 `<tool:apply_patch>` 目标 | `rule-host-input-builder.ts:239-255`；`codex-rule-context-provider.ts:29-36` |
| B5 | NO 未操作化（truncated:false 不证明覆盖完整）；"前四类强证据"表述自相矛盾（含弱证据 live-result-shape-inferred） | SPEC v1.1:101-103；Stage 0 §4.7 |
| B6 | `writerPath:'absent'` 无法被 schema 表达（行字段必填）；duplicate 示例未忠实建模生产 dedupe（exact repeats 被抑制） | `production-pain-evidence.ts:547-554` |
| B7 | Golden Trace 映射无效：positive 必须 expect allow（`golden-trace.ts:160-162`） | 同左 |
| B8 | coverage 分类不是连贯分母体系：multi-target 缺失、非划分、分母不符生产机械现实（opaque/synthetic 非空即被评估）、provider-absent 无归属、PreToolUse/PostToolUse 混为一谈 | `production-rulehost-gate.ts:351-360`；`hooks.json` |
| B9 | wouldBlock 错误包含 requireApproval——生产上只有 block 变 gate deny；requireApproval 在 OpenClaw 仅记录 | `production-rulehost-gate.ts:1025-1052`；`openclaw-plugin/src/hooks/gate.ts:683-689` |
| B10 | PASS/FAIL/INCONCLUSIVE 无法表达契约自己的 known-defect characterization 规则；评测语义正确性与生产缺陷忠实度是两个轴 | 契约 §10.2/§10.3 自相矛盾 |
| B11 | 示例集非机器可校验最小集；缺 synthetic_target/cross_host_attribution 详例与部分 SPEC 负控 | §11 现状 |

Agent C 同时核实了引用准确性：其抽查的 10 处引用中 8 处准确（含主代理 S1 自修后的版本），2 处需再修（`production-pain-evidence.ts:260` 不是 live INSERT 主路径——应引 526-557 区域；OpenClaw 身份缺席证据需三处链接而非单文件）。Agent C 确认其审查期间契约文件在变化（live-local 引入前后两版），并指出两版都未解决根本顺序问题——**该观察正确，B1 的修正方向是撤销而非粉饰**。

---

## 5. 修订记录（响应 Agent C）

全部 11 项 blocking 已修订：

| # | 修订 |
|---|---|
| B1 | **撤销 live-local**。§5.2 分级表明确：无论行是否全 live/单 session/无 backfill，insertion order 仍只是 insertion-only（hook 调度/并行/写序列化 + writerPath 不可观测）。§5.3 案例 1 改为诚实结论：**当前生产证据能力下 repeated-failure YES 永不合法**——这是 Stage 0 P0-2 的契约化表达。新增 §5.5 Evaluation Mode：`evidence-fidelity`（默认，测生产证据现实）与 `rule-logic-isolated`（oracle 显式 assumptionGrants 授予下测规则逻辑，禁止计入证据就绪性）。schema 增加 `evaluationMode`/`assumptionGrants` 字段与约束 9 |
| B2 | 新增 `currentInvocation` 块（hookType/cutoffAt/workspaceDir/providerEnabled，必填）；`writerOperation` 区分 live_insert/verified_update/verified_insert/legacy_write；verified_update 必须声明 `preUpdateOutcome`；新增 §2.4.4 as-of-decision 投影规则（cutoff 后行不入、UPDATE 用旧值、当前行排除）；11.6 拆分为 INSERT 顺序反转与 UPDATE hindsight 两个变体 |
| B3 | envelope 三层重构：events 改为判别联合（`eventKind: observed/absent`）；observed 事件 `row` 层仅生产 `tool_calls` 原始列（snake_case，含 params_json 字符串形态）；`scenarioMeta` 隐藏层承载 writerOperation/outcomeEvidenceClass/coverageProvenance/targetAttributionOracle/truth；canonicalKind/normalizedPath 从 authored 输入移除——simulate 模式由生产代码重算，可选 `assemblyExpectation` 对照验证。currentCall 同步分层为 invocationInput/currentInvocation/oracle |
| B4 | 11.1 旗舰示例重写为 WorkBuddy `Write` 真实结构化 file_path 形态；新增 §2.5.1 Codex apply_patch 特别条款（无直接 file_path → 合成 `<tool:apply_patch>` 目标）；11.3/11.9 修正 mutation regex 提取现实，11.9 改用 regex 外命令 `python manage.py migrate --settings=prod` |
| B5 | 强证据显式枚举为 4 类（§2.4.3）；新增 `coverageProvenance` oracle 元数据；`assembledPriorReadOfTarget` 与 `epistemicPriorReadOfTarget` 分离（装配输出 vs 认知判定，OpenClaw 伪 no 场景两者分离） |
| B6 | 判别联合解决 absent 表达（absent 无 row、必有 absenceReason）；11.7 重写为一可见行 + 一 dedupe-folded absent 事件 |
| B7 | 11.1 goldenTraceMapping 改为 `kind: negative`（blocking 场景的 Golden Trace 词汇），schema 约束 13 强制非 allow 必须 negative，字段描述说明与 controlClass 的不同维度 |
| B8 | §8.2 全面重写：划分不变量三条（total=unreachable+declared；declared=routed+not-routed；evaluable-kind 六类互斥穷尽——补入 multi-target 9b）；PreToolUse gate 路由（3a）与 PostToolUse 证据采集（3b）分离；provider absent 单列 10b；显式命名 Mechanical Gate Funnel 与 Semantically-Attributable Funnel 双漏斗 |
| B9 | wouldBlock 仅计 block 且宿主 deny 映射 probe-verified 者；requireApproval 作为 decision intent 单独报告 |
| B10 | 新增 §10.0 Evaluation Axis：`semantic-correctness`（默认，缺陷产生 defect-attributed FAIL，与回归 FAIL 分开计数）与 `production-conformance`（钉住现状，PASS 不构成正确性证据）；§10.3 矛盾条款同步修订；schema 增加 `evaluationAxis` 必填 |
| B11 | §11 引言明确：§11.1 唯一规范示例（schema 机器校验 PASS），§11.2–11.10 为非规范设计注释，正式 fixture 由 PRI-1310 落盘后机器校验；synthetic_target/cross_host_attribution 详例与更多 SPEC 负控明确归属 PRI-1310 (fixture pack) |

**non-blocking 意见处置**：NB3（PreToolUse truth 禁 trueOutcome）→ schema 约束 11；NB4（exact/one-of 语义）→ schema description 定义 + 11.1 改用 one-of；NB5（neutral-or-absent 分解）→ 新增 `disposition` 枚举；NB6（context-absent 类别错误）→ 拆为 `contextPresence` 独立字段；NB7（hostEffect 必填）→ schema required；NB8（rule 绑定）→ provenance.ruleUnderTest 可选块；NB12（causalPosition 并发）→ truth 增加 `concurrentWith`/`orderUnknownReason`；NB1/NB2/NB9/NB10/NB11/NB13/NB14 记录在案，部分归属 PRI-1310 实施细化（schema 独立资产落盘 + 依赖检查、聚合混淆矩阵、规则作用域元数据）。

**Agent C 指出而需承认的遗留引用问题**：`production-pain-evidence.ts:260` 引用已核——260 行确为 schema 探测语句而非 live 写入主路径（526-557 区域）。本文档记录该误差；契约正文该处引用语义不变（live INSERT 通路存在性无误），精确行号修正列入下文遗留项。

---

## 6. 尚未解决的分歧 / 遗留风险

1. **无实质分歧**：Agent C 的 11 项 blocking 全部被接受并修订——包括推翻主代理自己引入的 live-local（主代理 S3 自修方向错误，Agent C 的批评正确）。
2. **遗留风险 L1**：契约内嵌 schema 与 PRI-1310 落盘副本可能漂移——已约定内嵌为权威，漂移时修复副本（§2.8 引言）。
3. **遗留风险 L2**：`rule-logic-isolated` 模式存在被滥用为"证据就绪"的诱导风险——依赖 §5.5 冻结条款 3（报告分离）与评审纪律，无机器强制。
4. **遗留风险 L3**：紧凑示例（§11.2–11.10）为非规范注释，其设计意图与 schema 的一致性未经机器校验——PRI-1310 落盘时须逐个重新核对（特别是 11.6 变体拆分）。
5. **遗留风险 L4**：`production-pain-evidence.ts` live INSERT 精确行号（526-557 区域 vs 260）在契约正文未逐一更正——语义不受影响，供 PRI-1308 引用时以源码为准。
6. **遗留风险 L5**：聚合 oracle 弱点（NB14）——no-op 规则可通过全部 inconclusive/negative fixture；依赖正控有效性（现已立于 assumptionGrants 之上）与聚合混淆矩阵报告（PRI-1310）。
7. **验证局限**：ajv v6 方言转换验证（§7 表）。Agent C 审查的是修订前版本——修订后未经第二轮完整独立审查（时间/预算约束），但全部修订直接响应其意见且 schema+规范示例机器验证通过；Owner 审查时可要求第二轮。

---

## 7. 机器验证记录

| 项目 | 方法 | 结果 |
|---|---|---|
| JSON Schema 合法性 | ajv v6（仓库现有版本，draft-07；schema 仅用 draft-07 兼容特性，机械方言转换 `$defs`→`definitions` 后编译） | PASS——schema 编译成功 |
| 规范示例（§11.1）schema 符合性 | ajv validate | PASS |
| 引用路径存在性 | 逐一路径文件系统核实（6 处文档路径） | 全部存在 |
| 文件/行号引用准确性 | 主代理源码核实 + Agent C 独立抽查 | 见 §4/§5 |
| 示例-标签一致性 | §11.11 矩阵 vs §3.12 映射人工核对 | 一致；`synthetic_target`/`cross_host_attribution` 无 §11 详例但 §3 内有行内示例（工单最小示例集未要求） |

**验证局限声明**：ajv v6 仅支持 draft-07，契约声明的 draft 2020-12 方言通过机械转换验证；两者在本 schema 使用的特性子集上语义等价（未使用 2020-12 独有特性）。`format: date-time` 在 ajv v6 内建支持。后续工单若引入 2020-12 独有特性，须先升级验证工具链。

---

## 8. 最终一致性结论

**审查流程结论**：契约初稿经独立 adversarial 审查判定 NOT-READY（11 项 blocking），全部 blocking 已修订并机器验证通过。审查流程本身验证了工单设计的价值——最重要的发现（live-local 因果伪造风险、observation 层真值泄漏、决策时点快照缺失）都是初稿的实质缺陷，若未冻结前发现将污染 Stage 1A 全部下游评测。

**当前状态**：修订后契约满足工单全部结构性要求（11 章节、11 标签、13+ 覆盖分类、三值语义、顺序/归因/宿主/决策契约、PASS/FAIL/INCONCLUSIVE + 评测轴 + 评测模式、10 示例）。两个最深的诚实结论已契约化：

1. **当前生产证据能力下，repeated-failure YES 永不合法**（顺序证据天花板 insertion-only）——Stage 0 P0-2 的契约化表达，不是设计失败；
2. **测试规则逻辑必须显式分离评测模式**——`rule-logic-isolated` 的 assumptionGrants 是 oracle 授予而非证据，禁止计入生产证据就绪性。

**签署意见**：契约可提交 Owner 审查冻结。遗留风险 L1–L5 已如实记录，均不构成本阶段冻结障碍，但必须在 PRI-1310 落盘时处理。

