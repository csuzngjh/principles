# SPEC-RULECODE-QUALITY-001 v0.2：可信 RuleCode 生成与 Codex 验证

日期：2026-10-16。状态：修订设计稿；Owner 将配套执行指令交给代理后，按指令列明范围实施。本文本身不批准任何规则或生产激活。

替代 v0.1 的实施设计；历史证据仍保留。本文是技术要求唯一来源，配套指令负责执行授权、步骤和交付管理。

## 1. 结论、范围和可交付结果

让 PD 生成有真实事实前提、忠于 Owner 原意、通过独立验证的代码。缺事实时明确停点，不用近似门禁冒充完整实现；不因 RuleCode unsupported 而否定或停用既有获批 prompt 原则。

| 范围 | 本轮要求 | 能声称的完成 |
|---|---|---|
| A：质量与运行保护 | 必须实现、测试和交付 | 受支持原则可正确生成；不支持/故障不会伪装成功 |
| B1：可信来源调查 | 必须只读完成 | 有来源证明，或具体的无源/不可用证据 |
| B2/B3：事实接线与 Codex | 默认 NO-GO；仅在第8节全部条件经核查成立后，按本设计实施 | 通过前提后才能报告接线合格 |
| B4：原痛苦闭环 | 依赖 B2/B3 和正式治理授权 | 原原则真实生成并到达审阅入口；部署效果另计 |

无源不是代理询问 Owner 的理由：将 B 标记 BLOCKED，继续完成 A、B1、代码修复、验证、提交推送和 PR。A/B1 完成不等于原原则完整闭环。

## 2. 背景与固定证据

原 pain：`manual_1791868470372_8c47edyh`。

- 主 prompt candidate：`fe766b65-81e5-48cd-9236-19d75cb140ed`；ledger：`ce2b7885-a9ea-4f6e-94da-b0e6c9b85110`。历史上获批的主 prompt，不可替代新代码工件批准。
- 优先代码任务：`artificer-52d98a96-65b9-4952-82c5-51ba2d853c53-code_tool_hook`。
- 另一代码任务：`artificer-406f6131-5a28-4d17-9a7f-a18298d48bd0-code_tool_hook`；只读单列，不能因首分支完成就宣称全部完成。
- 原生产工作区：`C:\Users\Administrator\.codex\pd-workspace`。
- canonical 安装 runtime：`C:\Users\Administrator\.pd\runtime`。它与插件私有 runtime、源码构建是不同对象。
- 已核查源码：`C:\Users\Administrator\.codex\worktrees\codex-rulecode-recovery\principles`，HEAD `e2ecbdd0a1adb528606df14bcd46ac3c6010e342`。不是默认新开发工作区。
- 主目录 `D:\Code\principles` 有无关本地文件；保护，不清理、不重置、不直接在那里开发。

证据目录：`D:\Code\pd-deliveries\codex-pain-recovery-20261015`。

| 已核实事实 | 证据 |
|---|---|
| 生成指令鼓励 closest per-call proxy 和参数标记 | `artificer-prompt-builder.ts:257–265`；并存禁止把窗口事实当批准的指令 |
| RuleContextV2 没有可信开发 SPEC 批准事实 | `rule-context-v2.ts` 的 history/facts 契约 |
| 已有意图、样例、沙箱、Evaluator、防伪和修订能力 | intent-contract、preflight、evaluator-runner、refiner-rulehost-gate |
| Codex 没有实时 context provider，V2 暂停 | `pd-hook.ts:163–177,367–376` |
| 共享 gate 把坏上下文变为 truthy unavailable，仍可运行 V2 | `production-rulehost-gate.ts:171–186,364–372`；隔离 probe 已复现 |
| 路径与命令混用，但 null 提前放行推论不成立 | builder 返回 string；无路径为 `""`；Git 命令不为 null |
| GLM 在隔离原数据副本中真实生成，约69秒 | `rulecode-zai-copy-1792127239446/result.json`；不是生产恢复或激活 |
| 坏产物存在自填批准绕过、只读搜索误拦、Git变体漏拦 | 原 implementationCode 与离线回放 |

六个扩展案例的失败不是模型能力评分；输入不变、只改变外部期望的案例应归信息缺失/冲突。未经可信来源证明，提交消息也不能证明任务简单。

PR #2048（证据接线，e2ecbdd0a）和 #2049（maxTokens保留，a0175c9299）在最近查询时均 OPEN。实施时重新查询；已合并就复用 main，未合并就核查依赖，不能假装安装版已支持。

## 3. 非目标和权威

不重建 Artificer/Evaluator，不新增通用开发审批、任务编排、Shell解析、通用LLM修复或后台调度系统；不改 ZCode，不消费其他生产痛苦，不自动发版、安装到生产或激活规则。

| 事实 | 权威 | 不能替代它的内容 |
|---|---|---|
| 原意 | 原痛苦及真实来源、获批原则 | 生成器重述 |
| 意图/执行条件投影 | 既有工件元数据，绑定源引用和摘要，派生性质明确 | 平行政策账本 |
| 样例标签 | Owner标注或有明确委托的代理判断，保留actor和依据 | 将代理判断称为Owner亲审 |
| 开发SPEC批准 | 宿主可信决定及任务、版本、范围绑定 | PD原则/激活批准、命令标记、普通仓库文件、模型自报 |
| 代码批准与激活 | 既有PD治理记录 | 语义评审或沙箱通过 |
| 验证结果 | 真实执行记录，绑定材料版本 | LLM自报passed |
| task/run/重试状态 | 既有store及事务 | 报告文件或新状态账本 |

哈希证明内容对应关系，不证明人类身份或批准含义。批准来源必须能证明明确对象，不能把“继续”默认等同于后续所有设计批准。

## 4. 逻辑调用链

```text
Owner源材料 + 已有Scribe
  → 生成前意图依据完整性 + 执行条件核验
  → 来源/样例/宿主能力核验
      缺条件 → 持久化明确停点，不调用生成模型
      条件具备 → 现有ArtificerL2
          → 现有结构、安全、真实样例校验
          → 现有Evaluator语义评审 + 实际独立回放
              代码缺陷 → 现有有界修订
              条件缺失 → 退出代码重试，记录恢复入口
              通过 → 既有rollout / Owner审阅
                  → 正式Owner决定后，现有shadow和激活流程
```

路由、回退和预算判断由代码完成。模型只承担现有语义判断/代码生成，不新增“执行条件分类模型”调用。

## 5. A1：生成前意图依据完整性

### 5.1 最小可验证契约

在既有工件/任务metadata中增加带版本的派生核查记录，不建立新表。每次核查必须绑定：

- 原痛苦/获批原则的实际源引用与内容摘要；二者血缘一致。
- 既有Scribe与intentContract引用及摘要；没有契约不等于损坏，但不能冒充核实完成。
- 必须阻止的行为、必须放行的行为、适用范围与原文依据。
- 所需事实、提供者、目标宿主、不能观察的内容。
- 核查者/核查方法、核查材料版本和结果；代理语义判断不得标为Owner新决定。

生成前可执行条件不得由即将生成代码的模型独自决定。仅“模型声明不需要审批”不能使已知审批原则通过。

对本案例，设计已明确要求 `可信设计批准 + 当前任务/SPEC绑定 + 适用范围`；这三项缺失则拒绝生成审批硬门禁。不得把此要求写死为数据库某个ID特判；它作为有来源的条件随原工件血缘传递，不能由下游产物删掉。

### 5.2 判定时点和缺失处理

先核对源引用、摘要、既有语义材料与条件记录，再构造Artificer runner。现有下游Evaluator不能独自承担“生成前已保证”的证明。

优先从已有Scribe/Philosopher语义材料取得条件依据，并验证没有与原文相冲突。既有材料不能支撑时，记录 `intent_unverified` 或 `intent_conflict`，进入现有可审阅/不支持停点，零生成调用。不得为了补该缺口临时增加通用分类模型或关键词审批检测器。

执行代理在本次修复/测试中可以依已知原文作受委托核查并保留来源；这不能成为产品未来对所有自然语言原则自动识别的保证。通用产品路径遇到无法核实的条件必须明确停点；受支持正例证明系统并非全部拒绝。

### 5.3 前置结果

| 逻辑结果 | 行为 |
|---|---|
| executable | 事实与能力具备，允许生成；不是质量通过 |
| needs_evidence | 能力存在但缺有效材料，等待补证 |
| unsupported | 当前宿主/输入无法表达原则，不自动生成或重试 |
| evidence_conflict / intent_conflict | 记录冲突来源，不让生成器自行选标签 |
| intent_unverified | 缺足够原意/条件依据，不生成硬门禁 |
| source_error | 来源I/O或损坏；按第9节分类，不误写Owner未标注 |

逻辑结果映射到既有task.status、reason和metadata；实现报告列明映射与全部消费者，不要求新增status枚举。缺字段、损坏字段、过时字段分别处理。

## 6. A2：生成与评审增量修复

- 删除“无法执行时用最近似代理”和自填标记可代表前置授权的指导；明确无状态函数可以读取真实历史，但不能创造不存在的事实。
- 不把编码前设计批准变成提交时关键词检查。可执行子范围若要独立成为另一规则，保留差异并走正式治理，不能静默替换原规则。
- 真实样例原输入和标签不改。模型新增样例标明来源；不能成为可信审批来源。
- 元数据风险披露不能抵消代码违反原意。生成器自己出题通过不能作为唯一质量依据。

复用已有 `EvaluatorRunner`、`evaluateRefinerRuleHostGate`、repairFeedback和Owner审阅。现有剥离LLM自报adversarialResult、真实回放和缺gateDeps失败关闭均须保留；不是重建这些机制。

新增范围限定为：意图前置核验、独立适用样例、原始宿主载荷消费者一致性、验证证据绑定及确实缺失的生产接线。

验证分开记录：真实标签回放、独立确定性反例、原意一致性评审。通过证据至少绑定代码/工件摘要、意图/样例版本、验证器、源码commit、实际包路径/版本、宿主、模型profile（无密钥）。任何关键材料变化使旧通过证据失效。

修订可使用部分失败反馈；后续验收不能把已完整泄露并反复修到通过的集合称为完全独立留出。不得用平均分抵消适用的安全反例失败。

生产和回放必须使用相同真实宿主词表、projectDir与现有buildRuleHostAction。读取真实Codex原始载荷的脱敏夹具，而非只手造理想参数；验证command仍保留、动作类别一致、文件路径语义没有被命令误充。

`normalizedPath`当前可能是命令文本，空路径为string空值；不要按不存在的null路径重现漏拦。优先现有语义提取，不引入通用Shell解析器；无法可靠识别的动作应暴露能力限制，不能宣称完整覆盖。

## 7. A3：运行时保护与可用性保证

### 7.1 上下文依赖规则的强制暂停

规则声明 `requiresContextVersion:2` 就属于运行时上下文依赖规则。该次调用出现以下任一情况时，在加载/编译/执行规则之前由shared gate跳过该V2规则：

- 没有provider、provider返回undefined；
- provider返回无效值、抛异常；
- schema合法但history.status为unavailable；
- 超过整体deadline；直接按现有故障可用性契约结束，不运行规则。

不能把truthy的UNAVAILABLE对象当作“具备执行资格”；警告不能代替暂停。用不带unavailable自我保护的规则做负控，证明没有进入evaluate。

这是按调用、按上下文依赖的隔离，不是停用所有V2 activation，不修改治理状态。健康上下文下已有支持路径不变；在整体执行预算尚有剩余时，不依赖V2的健康规则继续执行；shadow与live分别证明。整体deadline耗尽仍遵守既有fail-open，不要求超预算继续评估V1。旧规则如在“合法unavailable”情况下以前仍执行，本修复明确改为暂停，报告行为变化并提供回归，不声称行为完全不变。

其他独立规则/宿主安全机制仍可拒绝工具。不得把“该规则未执行”说成“它批准了工具”。

### 7.2 四种审批状态的规范行为

此表约束B的契约和A的隔离/测试，不表示当前已经存在审批provider。

| 来源核实结果 | 额外条件 | 审批原则行为 |
|---|---|---|
| approved | 当前task/SPEC/范围一致、未撤回 | 本原则不拦；不覆盖其他规则 |
| not_approved | 权威来源明确证明未批准，且当前动作为该原则要求批准的行为 | 由合格规则阻止 |
| not_required | 权威范围/分类证明当前动作无需审批 | 本原则不拦 |
| unknown | 断开、损坏、范围未核实、状态不明 | 运行时隔离依赖该事实的规则，明确未执行，不伪装获批 |

缺失记录不等于not_approved。提交消息、行数、普通文件、自填metadata不能单独证明not_required。

### 7.3 保证边界

| 条件 | 可保证/需验证 | 不能声称 |
|---|---|---|
| 正常来源、完整输入、规则合格、执行完成 | 契约范围内策略判定正确 | 任意自然语言原则均可执行 |
| 上下文/批准事实失效 | 对应依赖规则未运行且降级可见 | 工具已通过审批 |
| 输入坏、DB不可读、整体超时等已有fail-open | 现有allow及可用降级观测；补齐本次改动涉及的观测 | 成功强制治理或绝不会放行 |

保留既有整体fail-open可用性契约，不实施全局fail-closed。数据库降级已有durable marker，复用而不重建；这不构成绝对拦截保证。

## 8. B：只读来源调查与条件实施

### 8.1 B1 必交付

提交真实来源样本（脱敏）和可重复读取方法，证明人类身份、明确决定、宿主task、SPEC版本/摘要、允许范围、撤回/替代状态、当前动作绑定。普通聊天关键词、模型提取结果、PD激活批准均不够。

来源不存在或不满足：报告B BLOCKED、具体缺少字段/能力和已查位置；不让原痛苦再次进入无限等待，也不询问Owner。保留既有prompt原则。

### 8.2 B2/B3 解除NO-GO的全部条件

只有以下全部成立才可按本SPEC条件分支实施，否则停止该分支、继续交付A/B1：

1. 已有宿主权威来源满足8.1，存在真实样本和读取接口，不需要建设新批准系统或新增外部权限。
2. 当前任务、SPEC、scope的关联来自可信宿主，不由工具参数自填；unknown与权威未批准可区分。
3. 现有激活/资格机制可限制到复验过且正式获批的目标规则；接通provider不会唤醒其他历史V2规则。
4. 可沿已有seam注入事实和上下文，不新增治理权威或审批数据库；契约满足下述8.3。
5. 安全负控、来源故障、隔离与旧规则兼容可在候选环境先完成。

这些条件是工程资格，不是允许代理批准新规则。提出满足条件的证据可以自主继续既定设计；不满足不得自行改产品边界。

### 8.3 条件分支的最小契约

沿现有host-owned provider seam扩展带版本的上下文投影，字段意义固定：sourceRef/sourceKind、actor/decision/revision、hostTaskRef/workspaceRef、specRef/specDigest、scope、resolution（第7.2节四态）。使用真实guard校验unknown，拒绝血缘不一致和原型污染；不增加批准写入口。

投影每次调用或经可证明失效机制核实最新状态；SPEC改变、批准撤回、任务切换后不得复用旧批准。哈希不是身份认证。读取失败按7.1/7.2在运行时隔离依赖规则，而非交给模型代码猜测。

逐规则资格由可信核验记录及既有批准/工件摘要绑定派生，不能由生成器漏报字段获得豁免。旧工件缺资格不自动升级；provider接通本身不是旧规则复验或授权。无法实现该限制时，B仍BLOCKED。

### 8.4 B4与授权边界

先用原数据的只读快照复用成功Scribe，跑真实Artificer→Evaluator→修订→审阅工件，保留原血缘，单目标分支；另一分支只读报告。

生产恢复、安装、治理决定不由后台执行指令默认授权。无生产授权时以候选/副本证据交付并明确未到生产；不得将测试夹具或候选安装当作生产证明。

若后续已有本次目标明确授权，才通过官方定点命令及dry-run/confirm推进；仍不得将主prompt批准复用为新RuleCode批准。没有新代码审批/激活授权时，交付审阅入口并停止该治理分支，不中断其他工程交付。

## 9. 恢复和预算

| 故障类型 | 恢复方式 | 模型预算 |
|---|---|---|
| 缺材料/标签/原意依据 | 有效材料版本变化后官方定点恢复，不反复唤醒 | 0生成调用 |
| 瞬时来源I/O | 复用已有消费/重试机制，最多3次连续技术失败；下次最早隔1个、再2个正常周期，重启不清零 | 0生成调用 |
| 永久损坏/血缘冲突 | 明确故障终态及官方恢复入口，禁止自动伪修 | 0生成调用 |
| 缺provider/宿主不支持 | 等待能力变化，不按瞬时错误忙重试 | 0生成调用 |
| 代码语义/实现失败 | 现有有界repair；每候选不超过既有上限与3次生成尝试中的较小值 | 按真实调用记录 |
| provider服务暂时失败 | 沿用既有有限技术策略，不扩展通用LLM修复 | 单独计次/耗时 |

优先复用现有nextAttempt和计数；preflight未建立run时，必要的技术失败计数/下次周期放入现有task metadata并事务更新，不新建调度器或表。第3次连续瞬时失败后结束自动重试，保留明确source故障及恢复入口；不能转成Owner未标注。读取成功后清除连续技术失败状态，保留历史事件。

恢复幂等、租约冲突零禁止写入、dry-run零治理变更；不能产生重复规则、审批请求或丢失旧run。

基线模型为 `zai/glm-5.3-flash`；正式profile最近回读timeoutMs=600000、maxTokens=32000。实施先核实，不更换模型或增大预算。既有成功试验发生在maxTokens恢复前，不将其误记为32000。独立确定性回放不调用模型。

## 10. 验收矩阵

| ID | 场景与必需结果 | 证据 |
|---|---|---|
| Q01 | 原审批原则缺可信来源，preflight明确停点，零生成调用 | 真实store/runner接线 |
| Q02 | 自填批准标记不改变可信状态或绕过原负例 | 负控回放 |
| Q03 | 相同动作、输入中的可信批准事实不同，结果分别符合7.2 | 版本化契约+沙箱 |
| Q04 | 相同有效输入有相反标签，识别冲突/信息不足 | 样例验证 |
| Q05 | 只读rg含git commit不因文本误拦 | 真实词表回放 |
| Q06 | Git参数/空白/工作目录变体，结果稳定；不支持写法明示 | 动作变体 |
| Q07 | 原意要求编码前批准，不能缩成提交检查 | 语义+执行反例 |
| Q08 | 权威not_required正常放行，不靠提交消息分类 | 来源契约 |
| Q09 | 另一task/workspace、旧SPEC、撤回批准不可复用 | 血缘负控 |
| Q10 | 上下文undefined/坏对象/异常/unavailable/deadline | 实际gate，不带自保护的V2规则不得执行 |
| Q11 | 自测通过、独立适用反例失败，不进入合格规则审阅 | 真实Evaluator/repair |
| Q12 | LLM自报passed无权威作用；保留现有剥离和缺gate失败关闭 | 既有回归 |
| Q13 | 代码/意图/样例/能力版本变化，使旧证据失效 | store往返 |
| Q14 | 重复恢复、租约冲突、重启，无重复审批/规则及丢历史 | SQLite接线 |
| Q15 | Codex无provider保持V2暂停，不接通全体旧规则 | 真实hook集成 |
| Q16 | 真实当前调用的session/task/上下文血缘一致 | B满足后宿主验证 |
| Q17 | 原原则代码生成并经完整链到可审阅pending工件 | B满足后定点证据 |
| Q18 | shadow不拦工具；live按契约执行，分别证明 | 另有正式激活授权后 |
| Q19 | provider立即故障且整体预算尚存时健康V1规则继续；影子不影响live | 实际共享gate |
| Q20 | 缺意图/摘要失配/生成器漏报批准依赖不能绕过前置核验 | 已知原原则负控 |
| Q21 | 瞬时来源故障恢复，无材料变化也可技术重试且零模型调用 | 持久化退避/上限 |
| Q22 | 故障持续超限，明确终态、重启不清零，非Owner标签故障 | store+worker |
| Q23 | 原始Codex脱敏载荷进入生产与回放，action/params/路径语义一致 | 消费者集成 |
| Q24 | DB/输入/整体预算故障的allow标记未执行/降级，不记成功治理 | 故障负控 |
| Q25 | metadata/报告包含实际基线、包路径版本、host、无密钥profile | 工件回读 |
| Q26 | 至少一个基于真实可观察事实的受控原则，经真实LLM和完整Evaluator链通过 | A正向能力证明 |

Q26用非生产夹具，不创建其他生产痛苦；不能代替原原则。保留现有坏GLM工件为负控，不手工修好后称模型生成。修复前后的有效测试必须能区分，不改原业务期望凑绿。

## 11. 源码定位与工程要求

所有路径相对新实施工作树根；执行前核实责任，不要求每个文件都改：

| 责任 | 路径 |
|---|---|
| 意图、生成约束 | `packages/principles-core/src/runtime-v2/internalization/intent-contract.ts`、`artificer-prompt-builder.ts`、`artificer-runner.ts` |
| preflight/证据恢复 | 同目录 `consumer-evidence-preflight.ts`、`owner-evidence-recovery.ts`；`packages/host-runtime/src/internalization-consumer-cycle.ts` |
| 既有生成/评审/回放 | core下 `adapter/artificer-l2-adapter.ts`、`tools/artificer-l2-tool-contract.ts`、`internalization/evaluator-runner.ts`、`refiner-rulehost-gate.ts` |
| 动作/上下文 | `internalization/rule-host-input-builder.ts`、`rule-context-v2.ts`、`rule-host-contracts.ts`；`runtime-v2/golden-trace.ts` |
| 运行保护 | `packages/host-runtime/src/production-rulehost-gate.ts` |
| Codex | `packages/codex-adapter/src/pd-hook.ts`、`codex-evidence-recorder.ts` |

先读AGENTS、相关现行ADR/feature、Error Pattern Index，运行error:context；回归覆盖真实公共入口、SQLite与跨包消费者。既有source/prototype/lineage校验不弱化。显著实施后做Standards/Spec双轴审查。

不扩大PR到全仓重构。新元数据为加法、带版本；旧工件缺记录显示legacy/unverified，损坏则单独失败。不得把旧规则/旧批准自动升级。

## 12. Complexity Delta 与回滚

| 项目 | 本设计 |
|---|---|
| New durable source of truth | NO，宿主批准和现有治理/store仍唯一权威 |
| New persisted schema/state | YES，现有metadata中的核查/验证版本、技术重试状态；不新表 |
| New subsystem/service/background process | NO |
| New public abstraction/interface | A尽量内部扩展；实际跨包如实列YES；B满足时为已有context契约扩展 |
| New runtime feature flag | NO；既有资格限制不可满足则B阻塞，不临时加全局开关 |
| New cross-package dependency | NO，沿既有依赖和seam |
| New host/platform-specific behavior | B满足时YES；A保护为共享运行时行为修正 |
| New external/network capability | NO，不新增模型种类调用或外部授权 |

新metadata用于防止旧通过证据复用、使停点及有限重试可恢复；普通风险字符串不足以实现。B接口仅承载实际缺少的事实，不能靠命令标记替代。通过真实store往返和消费者负控验证；回滚保留加法数据、不删除历史，使未支持新契约的规则暂停。

代码用PR revert；候选环境用正式installer回退。生产安装、规则停用另需明确授权；不直接改安装目录、SQLite、config或批准记录。若数据迁移确实必要，遵守DATA_CLEANUP_GUIDELINES，不删除治理数据。

## 13. 交付与完成语义

工程交付包括：SOURCE-AND-PLAN、B1来源报告、RF闭合表、Q01–Q26矩阵、实施报告、实际调用/故障负控、回滚、changeset/release-intent、commit/push/PR/CI记录。运行报告使用带无密钥配置和代码摘要的证据清单；报告不是新状态权威。

| 状态轴 | 判定 |
|---|---|
| A工程 | 必需实现、回归、Q26真实生成与评审、提交推送及PR；缺一项如实PARTIAL |
| B1 | 必须完成只读调查，有源或无源均需证据 |
| B2/B3 | GO且实施验证完成，或明确NO-GO/BLOCKED；不可只写“待确认” |
| B4 | 未恢复 / 副本通过 / review-ready / runtime-verified，逐级记证据 |
| 发放到用户 | 未发布 / 候选沙箱安装 / 正式发布 / 正式生产加载，分别记；本次默认不授权后两项 |

`A_DONE+B1_DONE+B_BLOCKED` 可以称“本轮工程交付完成，原原则仍阻塞”，不能称“原痛苦闭环”。SPEC整体功能COMPLETE仍需要B到达审阅入口及获正式授权范围内的真实宿主验收；审批/激活未发生时记待治理验收，不伪装代码失败。

## 14. RF-01～RF-08 修订闭合表

| RF | v0.2处理 |
|---|---|
| 01 | 第7.1节把失效上下文隔离变为运行时保证，区分异常/undefined/deadline，Q10/Q19；不称当前Codex生产已复现 |
| 02 | 第5节定义前置来源绑定、时点与缺失退出；不能用下游Evaluator假充生成前保证；Q20 |
| 03 | 第6节原始载荷一致性；纠正null提前放行推断，复用既有builder，Q23 |
| 04 | 第7.2节四态行为表，未知不是权威未批准 |
| 05 | 第9节区分补证和瞬时技术重试，Q21/Q22 |
| 06 | 第6节明确已有防护与增量范围，Q12保留防回归，不重建Evaluator |
| 07 | 第7.3节明确正常策略/失效隔离/宿主可用性三类保证，Q24 |
| 08 | 第2、6、13节逐份证据绑定基线和真实加载信息，Q25 |

RF-01/02是实施前高优先级阻断；当前证据不足以把它们描述为普遍紧急生产事故。实现者解决具体问题，不按未经证实的P0标签扩大架构。

## 15. MVP与自评

不做会继续产出伪批准和误拦规则；通过明确停点、独立验证、真实审阅与宿主记录观察价值；沿现有激活/暂停/回滚控制恢复。Owner价值是减少等待、误拦和不确定性，保留对真实治理决定的控制。

本版保留A/B分离和受控正例；同时修正前置核验、运行暂停、四态、来源恢复和证据基线。没有承诺靠提示词解决接口缺失，没有把安全拒绝全部生成当能力成功，也没有授权建立新的审批平台。本文尚未实施，不声称修复已通过。
