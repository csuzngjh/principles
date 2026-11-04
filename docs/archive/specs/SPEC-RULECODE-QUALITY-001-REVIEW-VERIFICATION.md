# SPEC-RULECODE-QUALITY-001 v0.1：外部评审独立核实

日期：2026-10-16。范围：核实 RF-01～RF-08 和实施裁决，不实施修复、不修改 SPEC/生产配置/数据库。

## 结论

采纳“修订后实施、A/B 分开”的总体建议，但不原样接受全部事实推导和 P0 定级。

- RF-01 有共享运行时缺口，隔离试验复现；不能据此宣称当前 Codex 生产已经错误执行。
- RF-02 是真实的设计前置条件不足，但尚不能定性为已部署的 P0 漏洞。
- RF-03 的命令/路径混用属实，但“null 分支提前放行 Git”的推论在当前实际返回类型下不成立。
- RF-04/05/07 应明确修订。RF-06/08 多数已有基础或已有 SPEC 要求，补强并保留即可，不重建机制。

建议优先级：RF-01/02 为进入相关工程实施前的高优先级阻断；当前证据不足以支持“已经造成普遍、紧急生产事故”的 P0 表述。严重程度与实施阻断是不同概念。

## 基线与方法

- 工作树：`C:\Users\Administrator\.codex\worktrees\codex-rulecode-recovery\principles`。
- HEAD：`e2ecbdd0a1adb528606df14bcd46ac3c6010e342`；核查前后 git status clean。
- 源码、固定工作树构建产物、隔离测试分别取证，不代表安装版或 main。
- GitHub 实时查询：#2048 OPEN，head e2ecbdd0a；#2049 OPEN，head a0175c9299；均未合并。
- 使用 receiving-code-review 的先核实后接受方法；没有启动旧后台代理或修改其他痛苦信号。

## RF-01：有条件采纳，已复现共享运行时缺口

源码链：

1. `packages/host-runtime/src/production-rulehost-gate.ts:171-186`：provider 返回 undefined 时 context 保持 undefined；返回坏对象或抛异常则赋值 `UNAVAILABLE_RULE_CONTEXT`。
2. `:364-372`：V2 的运行时隔离仅检查 `!context`，未检查 history.status 或所需事实是否可用。
3. `:400-410` 附近将 truthy context 送入实际执行输入，因此上下文不可信时仍可能调用规则。
4. `:190-192` 有总 deadline 检查；provider 超时耗尽总预算后会提前 allow，不能把“抛异常后继续运行”的结论推广到本次超时案例。

隔离 probe 使用一条测试专用、没有 unavailable 自我保护的 V2 规则，走实际 shared gate 和 Node RuleCode runtime；只在新建测试工作区插入夹具，不操作生产 activation。

| provider 情况 | gate 决定 | V2 是否运行 |
|---|---|---|
| 未接入 | allow + unavailable warning | 否，0 |
| 返回 undefined | allow + unavailable warning | 否，0 |
| 返回无效对象 | deny + invalid warning | 是，1 |
| 抛异常 | deny + failed warning | 是，1 |
| 返回 schema 合法的 unavailable | deny，无来源故障 warning | 是，1 |
| 返回 available | deny，正向对照 | 是，1 |
| 超过总 gate deadline | allow + deadline warning | 否；该早退未提供 evaluatedLiveRules 计数 |

这证明“暂停不是运行时充分保证”，不证明当前所有已批准规则都会错误阻止。测试代码是故意缺少自我保护的负控，不是生成工件或生产事故。

当前 Codex `packages/codex-adapter/src/pd-hook.ts:367-376` 未传 ruleContextProvider，落在第一行的暂停路径。不能把该共享缺口表述为当前 Codex 已经错误拒绝了工具。

采纳方案：对新引入的可信事实依赖型规则，由运行时独立于模型代码核实资格、事实可用性和来源；失败只隔离对应规则，保留原因。不全局停用所有 V2，不把“缺批准事实”改成全局拒绝工具。资格申报必须同时解决 RF-02 的漏报问题。

## RF-02：采纳目标，补上可实施判据，调整 P0 表述

属实：`intent-contract.ts:24-26` 明确历史兼容时允许缺失；ArtificerRunner 提取不到就传 undefined；其字段校验只证明结构完整，不证明忠于 Owner 原意。

v0.1 A1 已经要求“不信模型自报无需批准”，但没有充分定义原意依据、前置检查产物、判定时点和不具备材料时的退出条件。

补充注意：既有 Evaluator 在 Artificer 之后，不能只写“由 Evaluator 核查”就声称实现了生成前语义保证。需要明确生成前可复用的、带权威来源绑定的条件记录在哪里形成；没有足够原意/依赖依据就停在未核实状态。不得仅为此新增分类模型、关键词审批探测器或平行政策账本。

对原已知审批原则，可以明确其必须依赖审批事实及范围；推广到任意自然语言原则，不能承诺确定性代码能完美识别全部语义依赖。派生契约也不能自动变为 Owner 亲自批准的新政策。

应作为相关实现前的设计阻断采纳；没有证据证明它是当前已部署的 P0 事故。

## RF-03：部分属实，关键 null 推断不成立

属实：`rule-host-input-builder.ts:195-205` 对 execute 命令无法提取文件目标时返回整条 command，随后作为 normalizedPath 处理。路径字段因此不一定真是文件路径，不能据此声称拥有精确动作语义。

但 `normalizePathPure` 的实际返回类型是 string，缺路径时返回空字符串；`buildRuleHostAction` 不把它转换为 null。隔离 probe 验证：

- `git commit ...`：normalizedPath 是整条命令。
- `git -C . commit ...`：仍是整条命令，不是 null。
- `rg "git commit" docs/`：normalizedPath 是经过路径规范化的命令文本；原 command 仍保留在 paramsSummary。
- 无路径 unknown_tool：normalizedPath 是 `""`。

因此，不能由 gate 的 `action.normalizedPath === null` 分支推出这些 Git 操作被直接 allow。那条 guard 与当前 builder 存在类型/历史语义不一致，但这不是评审所称已复现的 Git 漏拦路径。

已有一致性基础：`golden-trace.ts:185-205` 在提供相同 projectDir/toolSemantics 时调用同一个 buildRuleHostAction；不应再造标准化模块。

采纳真实原始宿主载荷→规范化→生产/沙箱决策的消费者一致性测试，明确 command、动作与路径的能力边界。Git 变体漏拦的当前直接证据来自生成代码的 substring 逻辑，不能混归因为该 null guard。

## RF-04：采纳为语义明确化，不是现有文本自相矛盾

v0.1 B2 已区分 approved / not_approved / not_required / unknown，且要求权威证明 not_approved；Q03 也明确要求可信事实不同。两者并不逻辑矛盾，但确实缺少一张规范性的运行行为表。

建议修订表：

- approved 且适用范围核实：审批原则本身不拦；不覆盖其他独立安全规则。
- 权威 not_approved，且当前动作落在获批原则要求审批的范围内：审批规则阻止。
- 权威 not_required：审批原则本身不拦。
- unknown、来源损坏、范围未核实或版本不符：隔离该依赖型规则、结构化披露未执行；不能把此时的 host allow 称为“已经确认获批”。

任何测试必须把判定差异放入实际输入；无权威来源时不伪造 not_approved。

## RF-05：采纳，SPEC A4 确实写得过宽

v0.1 A4 的“可恢复任务只有材料版本或宿主能力变化后才能恢复”覆盖到了来源瞬时故障，过于严格。

`consumer-evidence-preflight.ts` 和 `internalization-consumer-cycle.ts:560-577` 明确使 evidence_source_error 保持 wake-eligible、不构造 runner、不消耗模型尝试。它与缺 Owner 样例后的 needs_human_review 是不同机制。

修订应区分：缺材料等待有效补证；瞬时 I/O 故障在已有消费/调度机制内允许有界、退避的技术重试；持续损坏/血缘冲突保留明确诊断并停止无效循环。不能宣称现有 next-cycle 重试已具有新要求的全部退避/次数上限；实现前须核实复用点，避免扩展为通用重试系统。

## RF-06：采纳澄清，已有保护应保留而非重写

`evaluator-runner.ts:898-907` 在首次持久化前剥离 LLM 自报 adversarialResult；该模块还有实际 replay、缺 gateDeps 时对代码工件失败关闭和 repair feedback 接线。

v0.1 A3 已写“复用”，Q12 是防回归验收，不是在指控当前 passed=true 可绕过。修订将新增范围限定为独立适用样例、原始输入消费者一致性、验证版本绑定、原意检查及缺失的生产接线。不能重建 Evaluator 或新设验证权威。

## RF-07：采纳保证范围，不采用全局 fail-closed 改造

源码确有 fail-open：无效 tool input、数据库不存在/读取失败、总预算耗尽、批处理超时等路径返回 allow。其中数据库缺失/损坏还有现有 durable degraded marker，不是完全无观测保护。

应区分：正常条件下规则策略正确、来源失效时依赖规则不执行、宿主可用性故障时整体门禁可能未执行。后两者不能称为“获批放行”或“成功强制治理”。

不应因该评审把 PD 改成全局 fail-closed，这改变既有可用性/产品契约，且超出本 SPEC。若 Owner 需要故障时也绝不放行，是另一个需要明确批准的产品设计。

## RF-08：采纳为交付证据要求

事实属实，v0.1 第2节已有区分，但应将 commit、worktree、实际加载包路径/版本、宿主、模型 profile 和材料摘要下沉到每份测试/安装证据。不得以候选分支、PR CI 或文档推断正式安装版能力。

本次实时查询 #2048/#2049 仍 OPEN；没有检查生产安装版本，不能把本次候选源码 probe 当作生产复现。

## 原 GLM 产物复验与范围

重新运行 `REVIEW-ZAI-RULECODE.mjs`，原五例仍 accepted_shadow；六个扩展案例仍 rejected_validation_failed。继续保留此前纠正：其中包含隐藏状态未进入输入的案例，不能作为“模型六题全错”的统计。

确定性代码缺陷仍成立：只读搜索命令含 git commit 被误拦、git -C 变体漏拦、自填批准标记可改变决策。测试没有执行任何真实 Git 操作或调用生成模型。

## 本次实际执行的检查

1. 候选源码静态核查和两项 PR 实时状态查询。
2. `REVIEW-RF01-RF03-PROBE.mjs`：7种 provider 情况，4种动作规范化情况；来源文件/构建文件 SHA256 存在结果 JSON 中。
3. `production-host-runtime.test.ts` 的定向测试：2 passed，39 skipped（有意按名称筛选，不是全包通过）；其中旧 provider 故障测试的规则自身先 allow unavailable，未证明 gate 强制隔离。
4. 原 GLM 产物离线回放；没有重新生成代码。

未执行：全量测试、生产安装验收、真实 Codex 拦截、生产规则激活。没有修改源码、生产数据库或原 SPEC。

## 采纳与后续裁决

- A：维持 CONDITIONAL GO；先修订运行时隔离与生成前意图依据，不能视作当前已批准开工。
- B1：只读来源调查可继续，不需要改生产。
- B2/B3：当前仍 NO-GO；批准来源及逐规则启用资格未证实。
- B4：仍 BLOCKED；不重复使用主 prompt 的历史批准。
- v0.2：建议采纳以上澄清后形成；保留 A/B 分离、受控正例、现有生成/评审/治理链，以及 RuleCode unsupported 不影响既有获批 prompt 原则的产品语义。

证据文件：`REVIEW-RF01-RF03-PROBE.json`、对应 `.mjs`、`rulecode-zai-copy-1792127239446/INDEPENDENT-RULECODE-QUALITY.json`。
