# SPEC-RULECODE-CODEX-V2-001 v0.1

状态：Owner 于 2026-10-18 在当前会话批准实施修复计划及开放 Codex V2。工单 PRI-1015；基线 aee5380128196cf164136f8d6d5d5f01b68acb7c。

## 目标与边界

复用现有 Scribe→Artificer→Evaluator、共享 RuleHost、Owner 审批/激活与恢复权威，修复契约断层、业务语义模板偏置、路径事实和回放/生产差异，并接通 Codex V2。源码修改、验证、提交推送与 PR 属本轮；正式发布、合并、生产规则批准/激活不自动执行。

历史治理资料保持原样。缺可信设计批准来源的原原则明确 unsupported；不能将 prompt 激活批准、聊天关键词或模型推断当作设计批准。

## 实现约束

1. 当前代码生成的 Scribe 必须携带合法 intentContract/executionConditions；旧工件读取继续兼容。缺失不得默补 requiredFacts=[]；在现有有界输出纠错内处理，失败明确到阶段。
2. 通用协议/沙箱只执行程序安全约束。业务判词必须来自当前原则与独立证据；模板不得按 tmp/temp/draft 名称替 Owner 判断，也不得将所有 V2 原则解释为读前写或系统路径禁写。
3. 词法路径按根、盘符/UNC、完整路径段消解。跨盘不能变工作区内路径，中间 .. 逃逸不能伪装普通相对路径；不引入通用 Shell 解析器，不声称解析文件系统符号链接。
4. sandbox 与 live 复用同一动作/风险事实。risk 是输入事实而非每条原则的全局 block 判词。
5. Codex 沿现有 RuleContextProvider seam 只读消费已授权历史；严格绑定实际 PreToolUse session/workspace/project/tool，禁止跨会话、未来记录和当前调用泄漏。来源不可核实时给 unavailable/unknown，保留 shared gate 的强制隔离。
6. 新规则通过实际 Evaluator gate 后由系统写入版本化输入兼容标记 ruleHostInputContract={version:1,contextVersion:2,hostKinds:[实际宿主]}，不从模型输出继承。Codex V2 必须有该标记、精确工件已有批准；shadow 绑定原审批记录保存的工件摘要，live 还须原有 promotion digest 核验。旧审批无摘要不回填，历史无标记规则不随 provider 接通自动执行，不新增审批权威。
7. 回放/宿主故障、shadow/live、正式治理步骤分别验收；不得将隔离测试标为生产已经生效。

## 验收

- 新输出缺条件在新生成边界失败；旧工件可读且下游明确停点。
- 根因负控修复前失败、修复后通过；跨盘/UNC/点段/大小写与路径根边界明确。
- 当前原则外 read/search 不因 risk 信号误拦；无独立业务依据的模板不生成虚构 expectedDecision。
- Codex provider 精确 same-session、无未来/当前调用、未知结果/坏源隔离；实际 Hook→shared gate 执行合格 V2，新旧资格反例 evaluate 零调用。
- 真模型生成＋独立保留反例；真实 Scribe 不手工补条件；原审批原则缺源明确分列，不宣称闭环。
- core/host-runtime/codex-adapter 与相关 CLI 消费回归、verify:merge、最终 PR CI。

## 复杂度与回滚

无新持久表、审批真相、服务、后台进程、flag 或外部能力。新持久元数据：已有 rule artifact 的输入兼容标记及 Artificer 工件的系统还原 Owner 样例；已有 approvals 表增加 nullable artifact_digest，将批准绑定当时的规范工件快照；已有 tool_calls 表增加 nullable project_dir，记录宿主原生 cwd，防止用户级共享工作区串用项目历史。旧行不倒填项目或摘要，无法核实的旧历史为 unavailable。两列由已有 schema owner 做加法迁移，不建立第二份批准或轨迹权威。

新 host-specific 行为：Codex runtime context provider，复用当前历史 reader 与 shared gate；来源故障由现有暂停机制隔离。必要的 factory/export 是现有宿主 seam 的真实实现，不建设通用平台。截断窗口、execute 与未声明工具不提供无法证明的负事实或精确计数。为兼容原 extractor，无法提取目标的命令仍以原文标签传递，但不再按文件路径规范化成工作区内路径；原命令保留在 paramsSummary，不声称已识别其文件访问范围。

回滚使用原有 rulecode_context_v2/host 控制、逐规则停用、源码 revert 和正规安装恢复；不直接修生产文件。
