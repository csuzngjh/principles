# AGENTS.md - 工作空间指南

Principles Disciple（PD）是 **Owner 治理的行为内化层**：把重复出现的、与 Owner 相关的
行为证据，转化为经过审阅、可回滚的原则，从而改变 Agent 未来的行为。

本指南只覆盖 PD 的职责。通用 Agent 行为（记忆、人设、任务执行、群聊礼仪、工具偏好）
由宿主/OpenClaw 和你自己定义，PD 不预设。

---

## PD 拥有什么

- Owner 认为值得改变的行为证据；
- 可审阅的原则提案；
- Owner 的批准、拒绝、通道选择、回滚与归档决策；
- 可逆的激活与后续行为变化的观察。

## PD 不拥有什么

- 通用记忆或记忆维护；
- Agent 人设或身份；
- 战略管理或战略对齐；
- 任务编排或任务衍生；
- 后台治理（定时任务、超出 Owner 审阅的心跳、环境健康）；
- 用户画像。

以上属于宿主/OpenClaw 或你本人。

---

## PD 工作流

```text
行为证据 -> 诊断 -> 原则提案 -> Owner 审阅
-> 可逆激活 -> 后续可观察的行为变化
```

- **记录证据**：`pd pain record`（对 Owner 相关的行为证据手动触发）。
- **审阅提案**：`pd candidate list` 或 `pd console open`——提案等待你的决策（approve / reject / defer / rollback）。
- **激活**：支持 `prompt`、`code_tool_hook` / RuleHost、`defer_archive` 三种结果。
- **回滚**：任何已激活原则都可回滚，见 `pd console` 的 Owner 可见控制。

## PD 数据位置

- `.principles/` — 原则存储（PRINCIPLES.md、profile、思维模型）。
- `.state/` — PD 运行时状态（如 pain flag，仅 legacy 兼容）。

不要将项目业务逻辑写入 Agent 工作区；业务代码放在项目根目录（`$CWD`）。

---

## 反模式（不要做）

- 不要以 PD 名义自主整理记忆或维护 `memory/` 文件。
- 不要运行后台战略对齐或环境健康维护。
- 不要自行衍生或排期任务。
- 不要把某种人设或身份强加给 Agent。
- 不要把每次工具失败都当作 PD 证据——只有 Owner 相关的行为模式才符合条件。

---

_这是起点。你可以按需添加自己的约定和规则。_
