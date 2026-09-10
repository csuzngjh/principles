# ADR-0025: 内置 Agent 角色/协议指令迁入 systemPrompt（DPB-07 修订）

- 状态：Proposed
- 日期：2026-09-09
- 关联：PRI-633、DPB-07（PR #399，milestone v2.5，m6-03）

## 背景

DPB-07（PR #399）规定：DiagnosticianPromptBuilder.buildPrompt() 不产生
extraSystemPrompt 字段，system prompt 由 agent profile/configuration 全权控制。
其原始动机是避免与 OpenClaw 宿主 agent 自身的 system prompt 冲突。在该决策下，
PD 的 10 个内置 agent（diagnostician 三段、dreamer、philosopher、scribe、
artificer、evaluator、rolloutReviewer、correction/empathy observer、signal
collector 分类器）的角色声明与协议指令全部内嵌在 **user 消息 payload** 中，
systemPrompt 通道被有意留空。

2026-08-31 对目标 provider（B.AI / deepseek-v4-flash）的实测确认：

1. 该端点不报告上下文缓存（cached_tokens 恒 0），缓存收益当前不可测；
2. deepseek-v4-flash 无 developer role（supportsDeveloperRole: false）；
3. 小样本 A/B（角色在 user vs system）输出质量无 observable 差异。

即使当前 provider 无直接收益，pi-mono（pi-ai）的标准通道就是
`Context.systemPrompt`：Anthropic 对 system 块打 cache_control、OpenAI 系
reasoning 模型自动升格为 developer role、DeepSeek 官方端点的自动前缀缓存
都以稳定的 system 前缀为前提。角色文本留在 user 消息使这些收益永久不可达。

## 决策

采用 **分层 systemPrompt**（保留 DPB-07 "profile 拥有追加配置面"的语义）：

1. **基础层（PD 内建）**：各 prompt-builder 产出的角色 + 协议指令（文本字节
   不变），从 user payload 拆出，经 `StartRunInput.systemPrompt`（新增可选
   字段）随 run 传递。
2. **工具协议层（仅 L2）**：静态 tool-protocol 文本从 user 消息尾移入
   system prompt；多轮循环获得稳定前缀。L1 fallback 不携带（该路径无工具）。
3. **追加层（profile 配置）**：`runtimeProfiles.<id>.systemPrompt` 以 `\n\n`
   叠加在最末（DPB-07 语义保留：该字段仍是 profile 所有者的 append-only 配置面）。
4. **放置策略归适配器所有**：
   - `PiAiRuntimeAdapter`：合并层 → `Context.systemPrompt`；repair 调用与
     L2 的 L1 fallback 同样携带；
   - 两个 L2 适配器：合并层 → `agentContext.systemPrompt`；
   - `OpenClawCliRuntimeAdapter`：**不迁移**。基础层折回 message 文件
     （payload JSON 之后追加），宿主 agent 自身的 system prompt 零接触 ——
     DPB-07 原始动机在该路径继续成立。
5. 合并规则：过滤空白层 → `\n\n` join → 全空则完全省略 systemPrompt 字段
   （未配置 profile 的行为与迁移前字节一致）。

## 后果

- 正向：身份/行为契约（system）与任务数据（user）分离；未来切换 DeepSeek
  官方端点或 Anthropic 时缓存/developer-role 收益无需再改代码；符合 pi-ai
  标准用法。
- 中性：当前 B.AI 端点行为无 observable 变化（实测确认）。
- 负向/成本：`*Instruction` 字段从各 PromptInput 契约移除（约 14 个测试文件
  同步更新）；OpenClaw 路径 message 文件格式从纯 JSON 变为 "JSON + 追加指令
  段"（宿主按自然语言阅读消息，无解析方依赖）。
- 回滚：纯代码迁移，git revert 即可；无数据/状态变更，无 feature flag。
