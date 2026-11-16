# ROUTER_RECOMMENDATION_QUALITY_AUDIT.md — Phase 2 Router 上游推荐质量审计（2026-11-15）

约束遵守：本轮未修改任何提示词/Schema/Runner/Validator；未调用模型 API；全部结论基于最新源码 `161763546` 与冻结实验的真实产物。

## 一、Router 完整生产提示词（提取与指纹）

完整文本（不允许摘要——全文已落盘）：

- `​.tmp/prompt-v2-ab/next-task/upstream-prompts/router.base.txt` — 10,562 字符，SHA-256 `f90c51307aa6e4f9…`（与 round-1 冻结 V2 清单 **逐字节一致**，证明当前源码即冻结版）
- `​.tmp/prompt-v2-ab/next-task/upstream-prompts/router.prod-zh-CN.txt` — 11,377 字符，SHA-256 `ac5df7202d4aa5a7…`（= base + zh-CN 语言指令，默认 `DEFAULT_OUTPUT_LANGUAGE='zh-CN'`，`language-directive.ts:36`）
- **运行时摘要级证实**：真实实验 run 的 `trustedContextReceipt.systemPromptDigest = ac5df7202d4aa5a7…`（S03 上游工作区 pi_artifacts），与上述渲染逐字节同哈希——即模型实际收到的系统提示词就是提取件
- 源文件：`packages/principles-core/src/runtime/diagnostician/router-prompt-builder.ts`（blob SHA 见 `upstream-prompts-fingerprints.json`）
- 模型与运行参数：zai `glm-5.3`，provider=open.bigmodel.cn，maxTokens=49152，timeout=900s，reasoning=high（pi-ai.glm profile）；profile **无** systemPrompt 附加层（PRI-633 合并结果=base+语言指令两层）

Router 自身 **零专属 Feature Flag**（仅 outputLanguage）；其输入=Stage A+Stage B 工件+系统注入的 trustedContext（Ledger 合法原则白名单，低信任数据通道）；输出契约=`DiagnosticianOutputV2Schema`（raw 校验先于 post-processing，`raw 输出契约`段）。Validator=`diag-router-runner.ts`（V2 血缘验证+schema 校验+association 校验）。

### 提示词结构（关键段落原文引用）

| 段落 | 行为 |
|---|---|
| ROUTING RULES | 按 kind 路由：principle/rule/implementation/prompt/defer；`Default: "principle" is the preferred kind` |
| 单原则约束 | `Emit AT MOST ONE kind: "principle" entry… Never copy the same principle into several entries to pad the list.`（仅约束 principle kind 防灌水） |
| rule 载体 | `If a specific trigger pattern can be identified for deterministic interception → kind: "rule"`（必填 triggerPattern+action） |
| prompt 载体 | `If a prompt directive can enforce the behavior → kind: "prompt"` |
| 关联义务 | 每条 rule 必须带 principleAssociation（implements→同输出 principle 条目 或 canonical_principle 或 unresolved） |
| **缺失的能力** | **无任何跨 kind 去重/独立性判断指令**——Router 被明确告知"Route what the distiller produced"，不被要求判断 rule/prompt 条目与 principle 条目是否描述同一机制 |

## 二、真实输出逐 Pain 对照（14 admitted Pain，全部真实产物）

数据：`upstream-diagnosis-dump.json`（14 个上游工作区的 diag_rootcause/diag_distiller/diag_router 工件+候选表）。

| Pain | recs（kinds） | 语义关系判定 | 关联声明 |
|---|---|---|---|
| S01 | 1×principle | 单条 | — |
| S02 | principle+rule+prompt | **三载体同一机制**（调查先行+阈值止损；rule 增加触发/动作的确定性形态；prompt 为工作流注入形态） | rule-1→principle-1 ✓ |
| S03 | principle+rule | **双载体同一机制**（等待前状态核查） | ✓ |
| S04 | principle+rule | 双载体同一机制（最小干预边界） | ✓ |
| S05 | principle+rule | 双载体同一机制（配对同步） | ✓ |
| S06 | principle+rule | 双载体同一机制（方向确认） | ✓ |
| S07 | principle+rule | 双载体同一机制（授权门） | ✓ |
| S08 | principle+rule | 双载体同一机制（先查先例） | ✓ |
| S09 | principle+rule | 双载体同一机制（语义门禁） | ✓ |
| S10 | principle+rule | 双载体同一机制（通道不可擅替） | ✓ |
| S11 | 1×defer | 单条（证据不足如实降级——正向样本） | — |
| S12 | principle+rule | 双载体同一机制（恢复前核实） | ✓ |
| S13 | principle+rule | 双载体同一机制（先归因再升级+状态废弃） | ✓ |
| S14 | principle+rule | 双载体同一机制（先召回约定） | ✓ |

**12/12 rule 条目全部带 `principleAssociation: linked → recommendation_ref: principle-1`**——系统在产物层显式记录了"rule 与 principle 是同一机制的两种载体"。

## 三、七问逐答

1. **Router 是否将同一纠正目标拆成多个 recommendations？** 是——12/14 Pain 输出 2-3 条（S01/S11 恰 1 条），均为同一机制的多载体拆分（principle+rule[+prompt]）。这是 ROUTING RULES 的设计行为（"decide the concrete carrier(s)"），不是语义复制。
2. **是否只是换了措辞？** 不完全是：rule 条目不是 principle 的复述——它把同一决策点转译为确定性拦截形态（triggerPattern/action 必填）；但 description 字段与 principle 文本高度重叠（S02 rule-1 描述≈principle 文本+阈值）。prompt 条目（仅 S02）为提示注入形态。
3. **同一 recommendation 的不同抽象层级？** 是——principle=抽象行为不变式，rule=同决策点的具体拦截。这是分层防御结构，不是冗余。
4. **是否存在真正不同的决策机制？** **没有**——每个 Pain 的全部 recs 都源自 Distiller 的唯一 abstractedPrinciple；14/14 Pain 无第二条独立机制的 recommendation（S02 的三载体也同属一个机制）。
5. **Router 是否对 recommendation 的独立性进行判断？** **否**——提示词无独立性/去重指令；唯一相关约束是 principle kind 防灌水（AT MOST ONE）。rule/prompt 与 principle 之间的关系只通过 principleAssociation 声明"implements"，不触发任何合并/抑制。
6. **重复 recommendation 被多个候选链分别消费？** 是且必然：每条 rec → 1 candidate（diagnostician-committer）→ bridge 每候选恰 1 条 Dreamer 链（`intake-to-internalization-bridge.ts:129-188`）→ 2-3 条链各自探索**同一份诊断**。
7. **是否上游诊断本身重复、Router 忠实转发？** **否**——RootCause 每 Pain 恰 1 条 rootCause（schema 单字段），Distiller 每 Pain 恰 1 条 abstractedPrinciple（≤200 字符单字段）。**上游无重复，多路复用由 Router 的多载体拆分引入。**

## 四、分类结论（Owner 四分法）

| 类别 | 判定 |
|---|---|
| RootCause 已经重复 | **否**（14/14 单根因；S01/S11 还示范了"证据不足→降级"的正向行为） |
| **Router 新增了重复** | **机制意义上：否；结构意义上：是**——Router 不生产语义重复条目（无同 kind 复制），但它把一个机制拆成 2-3 个载体条目，而管道把每个载体条目当作独立候选各自成链——**跨链重复的算术来源就是这次拆分 × 每候选一链的桥接设计** |
| Router 合理拆分了不同机会 | **载体维度上是合理设计**（rule=确定性拦截走 code_tool_hook+人审门，principle=prompt 链；职责不同）；**但下游消费方式使"合理拆分"变成"重复探索"**：rule 链与 principle 链的 Dreamer/Philosopher 阶段完全同构，产出近义原则稿（上轮审计 S03/S07/S12 实证），rule 链还 40/40 步于人审门 |
| 数据不足无法判断 | 无——本轮 14 Pain 全量证据充分 |

## 五、上游证据（RootCause/Distiller 未被 Router 放大的直接证明）

- Distiller→Router 保真：13 个 principle 条目中 9 条描述与 Distiller abstractedPrinciple **逐字一致**，4 条为微改写（S01 引号/标点、S04 单词序、S12 句号、S14 首字"在"省略）——0 条语义改写（对照 dump）；提示词明令 abstractedPrinciple 由系统注入（"provided by the system from Stage B — do not restate it"），description 字段的微改写不违反该约束。
- Router 未添加新机制：全部 recs 的内容均可追溯到 Stage B 原则+Stage A 根因；association 全部 linked（0 unresolved——trustedContext 可用且模型未发明 ID）。

## 六、给下一轮提示词设计的事实清单（不动提示词，只陈述）

1. Router 提示词**没有**"判断条目间独立性"的指令；它只有单原则防灌水约束。
2. 关联信息（12/12 linked）在产物层已经存在——链协调所需的全部数据已经由 Router 产出，只是没有任何下游消费者使用它。
3. 拆分的代价在管道里被放大：每载体一链 × 每链 2-4 候选（Dreamer）→ 每 Pain 4-8 个候选、2-3 份近义原则稿（上轮审计）。
4. defer 行为存在且正确（S11）；"证据不足不固化"的纪律在 Router 层有效。
5. S02 是唯一 3 载体 Pain：prompt 条目与 rule 条目在"阈值止损"语义上再次重叠——多载体拆分在同机制内部还有二级重叠。

（七、结论与建议见 UPSTREAM_NEXT_STEP_OWNER_REVIEW_CARD §B——本报告不改提示词。）
