---
"create-principles-disciple": patch
"@principles/workbuddy-adapter": patch
---

PRI-1127 WorkBuddy 产品入口：把已有的「自适应原则注入（只追加）」设置卡扩展到 WorkBuddy 宿主，补齐「选到工作区 → 配置决策服务 → 开启 → 查看结果 → 关闭」这段用户可见路径。

- 设置卡新增宿主选择（Codex / WorkBuddy），明确标注当前工作区、宿主与其已有开关 `host.<host>.adaptive_activation`。启停只写所选宿主的开关；决策服务配置仍是工作区级共享项，沿用原有写入保护（其它启用宿主存在时拒绝改写；已有 `replaceableActivationIds` 替换配置时拒绝通过只追加入口开启，但仍可关闭）。
- 结果按工作区 + 宿主 + 同轮身份匹配：复用真实 `generation_id`（WorkBuddy）/ `turn_id`（Codex）与已有 `runtime_v2_prompt_activations_injected` 注入事件。WorkBuddy hook 现在把与 Codex 同构的 `adaptive` 事实写入同一事件（`resultCode`、`scored`，以及仅当最终装配确实包含该 id 时才出现的 `appendedActivationId`），不新增事件类型或子系统。页面补显示同轮身份、实际装配得出的「已追加」、最终顺序与独立请求证据；送达由独立的模型请求证据确认，页面不推断。
- 默认关闭不变：Codex / WorkBuddy 两条开关互不影响，省略 `host` 时保持原 Codex 契约（与并行的 Codex 侧工作兼容）。关闭、缺少可信当前轮身份或没有可追加空间时继续走 Native；不用 Session ID、轮次序数或历史文本替代身份。
- 可用范围：仅 WorkBuddy 宿主在 `host.workbuddy` 已启用且该工作区配置了决策服务时可开启；不改变 Codex 现有行为，不扩展到跨模型 / 跨任务矩阵。OpenClaw 普通 embedded 仍依赖上游同轮身份字段，本单不改动、继续按现有上游依赖跟进。
- 关闭方式：在控制台该工作区的 WorkBuddy 卡关掉开关，或在工作区 `.pd/config.yaml` 的 `features` 中把 `host.workbuddy.adaptive_activation.enabled` 设为 `false`。关闭后零评分请求，原则装配正文与 Native 逐字节一致。
