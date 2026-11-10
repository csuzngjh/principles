# PRI-1161 实施卡 v0.1：把逐块重复的样板句合并到公共位置

状态：**已批准并实施（Owner 2026-11-10，附四项条件，见 §6；批准原文为本会话 Owner 指令，逐字要点已录）** · 工单：PRI-1161（关联 PRI-1105）· 测量：`docs/implementation-reports/pri-1161-boilerplate-measurement-20261110.json` · 基准：`origin/main` `e7c7e6bba` 渲染器，真实快照沙箱（归档 2026-11-09T13:21:39Z，18 条激活）

## 1. 已核实的重复（真实数据）

每条原则的指令块由 5 行组成；其中与原则**完全无关**的重复文本：

| 片段 | 准确文本 | 每块开销（含换行） | 实测次数（18 条轮 / FIFO 7 条轮） |
|---|---|---|---|
| 逐块说明行 | `Apply this as an active behavior constraint. Do not treat this as background context.` | 86 字符 | 18 次（1566 字符，占正文 17.0%）/ 7 次（609 字符，16.7%） |
| 结束标签 | `</directive>` | 13 字符 | 18 / 7 |
| 开标签内常量 | `source="runtime_v2_activation"` | 31 字符（在逐原则行内） | 18 / 7 |
| 正文前缀 | `MANDATORY: ` | 11 字符（在逐原则行内） | 18 / 7 |

**依赖原则信息、不能合并的**：id 属性值（转义后 principleId）、authority 属性（owner / system_policy / 缺省）、正文（转义）。**逐块语义无法保留、继续按块输出的**：`</directive>`（存在性取证切片 `indexOf('</directive>')` 与 Hook 终验 `includes(body)` 依赖这个边界）、开标签常量与 `MANDATORY: ` 前缀（都在逐原则行内）。渲染器不含版本号与 activationId。

## 2. 唯一改法

`packages/principles-core/src/runtime/activation/prompt-activation-reader-contract.ts` 的 `sharedDirectiveBlockLines` **删除常量说明行**（上表第 1 行，5 行块变 4 行），同一文件 `sharedDirectiveHeaderLines` 的既有公共行

> `These directives are mandatory for this session unless they conflict with safety, security, or higher-priority system policy.`（125 字符）

替换为

> `These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy.`（178 字符）

原句的语义（mandatory + active constraint + not background context）完整并入公共位置一次，措辞吸收了被删行的两个要点。base 净增 53 字符；每块净减 86+1=87 字符。每轮净变化 = 53 − 87×N：N=1 时 −34，N=7 时 −556，N=18 时 −1513（15625 轮实测基线 9208 → 7695，−16.4%）。只改这两个 builder；`measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` 由同一 builders 派生，预算算术自动同步，**不改任何选择逻辑**。

## 3. 影响的调用者（全部经同一 builders，自动一致）

生产：`host-runtime/active-principle-prompt.ts`（共享装配入口）、`host-runtime/prompt-activation-deliverability.ts`、`host-runtime/prompt-injection-projection.ts`、`core/adaptive-principle-intervention.ts`、`openclaw-plugin/hooks/prompt.ts`（targetBody / injectedExpectations 切片——只依赖 `<directive ` 与 `</directive>` 边界，边界保留）。测试：golden 特征化（golden 文本须更新——唯一必然变化的测试）、packing 属性测试（恒等式由 builders 派生，应保持全绿）。全仓只有 1 处生产源码和 1 处测试硬编码了被删句子（rg 已枚举）。

## 4. 通过线（冻结，实现前写定）

**硬失败（任一即弃）**：HF1 任一原则正文/id/authority 属性丢失、改写或双重转义；HF2 任意集合（空/单条/多条、含 XML 特殊字符 `&<>"'` 的夹具）违反 `render(S).length === base + Σ block`；HF3 存在性取证 `bodyComplete` 在未截断渲染中出现 false；HF4 builder 选择的集合渲染后超出 `budgetChars`；HF5 golden 更新后仍有任何测试为对齐而放宽断言。

**收益**：B1 相同集合下逐轮 `newChars = oldChars − 87×N + 53` 逐字节精确；B2 与冻结 PRI-1160 基线同快照 20 轮全部满足 B1；B3 15625 轮净减少 ≥ 15%（预期 −16.4%）；B4 4000 轮单独报告「样板减少 / 新原则补位 / 最终净变化」三列——补位可发生，任何新入选原则都必须能用预算算术解释，不把补位计为无条件收益。

**正确性**：C1 空集渲染 `''` 不变；C2 单条渲染含一次且仅一次公共说明；C3 self-report 页脚不受影响；C4 FIFO 缺轮次键现状单独记录，不夹带修复。

**计量**：字符为准；Token 未知（无可靠 tokenizer）。一轮同输入比较即裁决。

## 5. 交互与回滚

- **PRI-1160 交互**：其冻结基线（81,364 字符）由旧渲染器产出。若本卡先合并，PRI-1160 的治理后复测必须**先用新渲染器重冻 pre 基线**再比较，不得跨渲染器对比。
- **回滚**：revert PR 即可；无新 flag、无配置、无 schema 变更。golden 测试随 PR 一并回到原措辞。
- **changeset**：`@principles/core`（渲染文本变化）+ `@principles/host-runtime` + `principles-disciple` 与 `create-principles-disciple`（C4 隐性依赖）。
- **边界**：生产治理写入、宿主启动、真实模型调用、生产启用均为 0；零新存储；Complexity Delta 全 NO。

## 6. Owner 批准与条件（2026-11-10）

Owner 批准实施卡 v0.1（提交 `1f6ca5c04`，卡哈希 `efc3c779…07d24`），附四项条件：

| # | 条件（摘要） | 落地 |
|---|---|---|
| 1 | 只改公共说明和逐块重复行；逐原则正文、顺序、属性、转义、授权字段和 `<directive>` 边界保持原样。实现前逐一核对生产调用者；若有消费者单独使用块正文且不附公共头部，保留原语义；无法保证则报告调用点与反例、暂停该路径 | 调用者审计见 §7：全部调用者分两类（切片类=同源包含比对，整渲染类=与 projection 同口径的长度计量），无「裸块正文」消费者，无需暂停任何路径 |
| 2 | 固定同一入选集合与顺序，字符差精确符合 `−87×N + 53`，并比对实际正文与属性；再走现行共享装配入口验证最终输出；两层分别报告；按卡执行 15% 通过线；紧预算轮把样板减少、补位、净变化分开计量 | 两层比较见实现轮报告（层 1 = 冻结基线同集合重渲染；层 2 = 现行共享入口 20 轮） |
| 3 | 覆盖空集、单条、多条、转义、self-report、精确预算边界及逐原则取证切片；补位必须由现有装配规则解释；正文或授权丢失、预算偏差、取证误判、意外选中变化任一即失败并保留原渲染 | 测试矩阵见 §4 + 新增针对性测试；失败判据即 HF1–HF5 |
| 4 | 保留 PRI-1160 旧基线与原始哈希；以后在新渲染器下做治理后复测，另冻结同一渲染器版本的治理前基线，避免把样板节省算进治理收益 | 冻结文件零改动；复测脚本注释与收口检查点写明渲染器版本分界 |

边界确认：本轮只做离线验证，宿主启动、真实模型调用、生产治理写入均为 0。交付 PR/base/head、两层对比、测试与 CI、保留或放弃决定和检查点；FIFO 问题留在独立范围。

## 7. 调用者审计（实现前，逐文件）

| 调用者 | 用法 | 类别 | 结论 |
|---|---|---|---|
| `host-runtime/active-principle-prompt.ts` | 装配入口整渲染 + targetBody 单条渲染取切片 | 切片+整渲染 | 边界不变；整渲染与 builders 同步 |
| `host-runtime/prompt-activation-deliverability.ts` `computePromptSingleItemFit` | 单条整渲染长度作审批期 fits 成本，注释明示「与共享 projection 的 usedChars 同口径」 | 整渲染 | 与 projection（measure/base 派生）同步变小；fits 只会更容易成立，无丢失 |
| `host-runtime/prompt-injection-status.ts` | 消费 computePromptSingleItemFit → `classifySingleItemBudgetTier(costChars)` | 整渲染 | 同上；档位只会下移（更便宜），可解释 |
| `host-runtime/prompt-injection-projection.ts` | measure/base 逐块成本 | 派生 | 自动同步 |
| `core/adaptive-principle-intervention.ts:123` | 单条渲染取 `<directive>` 切片做同源包含 | 切片 | 边界不变即安全 |
| `core/prompt-builder/xml-escape.ts` | 仅注释引用 | — | 无影响 |
| `openclaw-plugin/hooks/prompt.ts:1237` | 终验 body 切片 `includes` | 切片 | 安全 |
| 插件存在性取证 `buildInjectedExpectations` | bodyText 切片 + 最终装配包含 | 切片 | 安全；bodyText 不再含样板行，与最终正文同源 |
| `pd-cli/tests/scripts/prompt-capacity-measurement.test.ts:34` | 测试内单条整渲染 | 测试 | 如断言绝对字符数则按新渲染器更新预期 |
| `host-runtime/tests/prompt-injection-golden-characterization.test.ts` | golden 文本含被删句 | 测试 | 按新渲染器更新 golden（唯一硬编码处） |

**无「单独使用块正文且不附公共头部」的消费者；无需暂停任何路径。**

## 7. 勘误（2026-11-10）

本节为带日期勘误，依据 Linear 评论 `96480210` 与 Owner 批准补充勘误（2026-11-10）。上方 §1–§6 为原卡与原批准记录，**原样保留、不作改写**；§2 冻结判据中的 `−87×N+53` 及其算例是当时的误写，以本节为准。

- **每块移除量**：`Apply this as an active behavior constraint. Do not treat this as background context.` 共 **85 字符**，连同其前导换行，每块移除 **86 字符**。公共头部替换（125→178）增加 **53 字符**。
- **固定入选集合及顺序**（纯渲染，逐字节精确）：`newChars = oldChars + 53 − 86×N`（N 为该轮入选原则数）。N=1、7、18 时分别减少 **33、549、1,495 字符**。
- **20 轮固定集合合计**（PRI-1160 冻结基线同集合）：**81,364 → 70,212 字符，减少 11,152 字符（13.7%）**。
- **15625 预算轮**：**9,208 → 7,713 字符，减少约 16.2%**，仍满足原定 15% 通过线。**原硬失败条件（HF1–HF5）继续有效。**
- **实际预算装配单独报告**：4000 字符 FIFO 样本补进 3 条原则，最终净变化 **+332 字符**——固定集合的渲染节省不等于补位后的最终净节省，两者分列（详见 `pri-1161-two-layer-comparison-20261110.md/.json`）。
- **PRI-1160 交互**：其冻结基线（81,364 字符）由旧渲染器产出；未来治理后复测必须用同版渲染器另冻治理前基线，原基线保留不动。
