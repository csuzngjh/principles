# RuleCode Graduation Design — PRI-634-E

## 历史设计检查（Step 5）

### 原始设计意图

- **PRI-439**（ArtificerRuleOutput 统一契约）：合并了 V1/V2 双版本输出，`implementationCode` 变为强制字段，移除了纯文本（plan-only）路径。核心设计假定：RuleCode 是**可执行代码**，作用于 `code_tool_hook` 通道，拦截具体工具调用。
- **ADR-0014 2026-06-17 Amendment Decision 1**：RuleHost MVP Activation — golden trace 作为输入，`expectedDecision` 使用 GoldenTraceDecision（allow/block/propose_correction），sandbox 层映射到 RuleHostDecision。MVP 范围：`code_tool_hook` / RuleHost 是"代码安全规则"通道。
- **ADR 2026-06-28 rulecode-context-v2**：v1 规则系统 = string/keyword-based 匹配，作用于**代码**，规则匹配是字符串/关键词级别。RuleHost 接收有限上下文（为什么规则存在、目标什么代码）。
- **PRI-485 Phase 6**：确定性对抗重放自动生成。实现 5 个 v2 模板（alias、path-boundary、combination、truncation、unavailable）——**全部为 write 路径语义**。

### 设计扩展线

| PR | 扩展方向 | 当前状态 |
|---|---|---|
| PRI-484 | `requiresContextVersion: 2` — v2 规则可读 input.context | 已合并 |
| PRI-485 | v2 对抗用例自动生成 | 已合并（仅 write 语义） |
| PRI-490 | v2 规则禁止 propose_correction + evidenceRefs（BehaviorExamplePack） | 已合并 |

**结论**：设计意图正在从"代码安全规则"向"Agent 行为规则"扩展，但对抗重放层（v2 模板生成器）**没有同步扩展**——它仍然只支持 write 语义，而行为规则（检查解释器版本、验证编码契约）主要作用于 execute 类工具。这是本次失败的架构根源。

---

## 优化方案（Step 6）

### 方案 1：增强 Artificer 输出契约

**内容**：
- 在 `ArtificerRuleOutput` 中增加受控 toolName 词表约束（validator 检查 `canonicalizeToolKind(toolName) !== 'other'`）
- 要求 positive case 的 params 必须包含 `path` 或 `file_path`（当 affectedTools 包含 write 工具时）
- 强制 Artificer 输出 `requiresContextVersion: 2`（v2 规则）以启用 evidenceRefs 和 ruleContext

**收益**：
- 契约层保证 Artificer 输出的工具名可被下游理解
- 从源头拦截"别名表不匹配"问题（本次 `execute_command` 不在表里的直接原因）
- 低运行时开销（纯 validator 增强）

**风险**：
- 不解决 execute 类工具 write-path 语义的根本矛盾（`path` 参数对行为规则无意义）
- 约束 toolName 词表后，Artificer 需要知道哪些工具名是"合法"的——这需要宿主侧声明而不是 core 维护硬编码表（spec §4.4 已预见）
- 增加 positive case 的 path 要求后，纯行为规则（如"检查环境变量"）如果没有文件路径就无法产出合法 golden trace

**复杂度**：中等（修改 validator + 可能调整 Artificer prompt）

### 方案 2：增强 Replay 自动生成 golden trace（扩展 v2 模板）

**内容**：
- 为 `execute` / `agent` / `other` 三种 canonical kind 分别实现对抗模板
- `execute` 模板：命令注入、编码参数边界、解释器版本欺骗、路径穿越、组合信号
- `agent` 模板：会话污染、权限滥用、上下文泄露
- `other` 模板：通用 fallback
- 放宽 `resolveCasePathParam`：当 params 无 path 时，尝试从 `command`、`script_path` 等 execute 类参数派生路径
- 将 `canonicalizeToolKind` 的别名表扩展为宿主可声明（spec §4.4 设计方向）

**收益**：
- **直接解决本次根因**：execute 类规则可达对抗重放
- 保持 gate 的确定性（不是降低标准）
- 结构对称：gate 为所有 4 种 canonical kind 都有覆盖

**风险**：
- `execute` 模板需要设计区别于 write 的对抗场景——命令注入（command injection）、编码参数干扰（encoding parameter manipulation）、解释器版本欺骗（interpreter version spoofing）等——这些比 write 的 path 边界更复杂
- `agent` 模板的对抗场景设计尚不成熟（需要额外研究）
- 实现量较大（约 5 个新模板 × 5 种场景 = 25 个对抗用例生成函数）
- 模板质量的确保需要真实沙箱回测

**复杂度**：高（核心架构扩展但无外部依赖）

### 方案 3：降低验证要求（不推荐）

**内容**：
- 对非 code-bearing 的 prompt 通道 artifact 跳过对抗重放门
- 放宽 `no_adversarial_cases_after_merge` 从 terminal state 降级为 warning（恢复 R1 行为）
- 允许 `adversarialResult = null` 时以 evaluator 的 LLM 决断为准

**收益**：
- 立即解除本次阻塞（且不影响 code_tool_hook 规则的安全性）
- 零实现成本（仅改 flag/阈值）

**风险**：
- **违反 PRI-634 R3 的核心设计裁决**：code-bearing 的 prompt 信道 artifact 如果跳过门，又回到链 48371236 的"LLM 自鉴"模式
- 降低了对 code-bearing 产物的安全一致性要求
- 一旦开了"非 write 工具跳过门"的先例，write 工具的安全门也难以维护

**复杂度**：低

### 方案 4：新增行为规则模型（独立于 RuleHost 的规则通道）

**内容**：
- 在 `prompt` / `code_tool_hook` 之外新增 `behavior_rule` 通道
- 行为规则不通过 RuleHost（不拦截工具调用），而是通过 `before_prompt_build` 和 `before_message_write` 钩子注入行为约束
- 对抗验证：用影子模式（shadow mode）观察行为改变，而非确定性沙箱重放

**收益**：
- 行为规则和代码规则**分离治理**，各自的验证方式适配各自的风险
- 行为规则可以走"注入→观察→报告"循环，不需要对抗重放
- 不对现有 gate 做任何妥协

**风险**：
- 新通道 = 新架构（新的 channel writer、新的 activation 路径、新的审批 UI）
- 行为改变的观察和归因比确定性重放困难（需要更长的观察期和统计置信度）
- 与当前 `prompt` 通道的激活机制重叠——prompt 通道已经通过注入改变行为，但它还是走 RuleHost 验证

**复杂度**：最高（新子系统）

---

## 推荐方案

**短期（P1 修复）**：**方案 1 + 方案 2 的子集**
1. 扩展 `TOOL_ALIAS` 表，添加 `execute_command`、`run_script`、`code_interpreter` 等缺失别名（修复本次 alias 表不完整问题）
2. 在 `resolveCasePathParam` 中增加从 `command`、`script_path`、`interpreter` 等 execute 类参数中提取路径的 fallback
3. 在 `canonicalizeToolKind` 为 `'execute'` 时使用最简单的模板（如命令注入 + 编码参数边界），不要求完整的 5 模板

**中期**：实现**方案 2 的完整 execute 模板**，覆盖行为规则所需的对抗场景

**长期**：评估**方案 4**——若行为规则增加到一个通道无法承载的复杂度，分离为独立通道

**不推荐**方案 3（降低标准违反 PRI-634 的核心设计裁决）。