---
"@principles/core": minor
"@principles/host-runtime": minor
"@principles/codex-adapter": minor
"@principles/pd-console": patch
---

Console → Settings 新增「自适应原则注入」工作区入口（Codex 桌面普通聊天，首版只追加）。

- `runtime_v2_prompt_activations_injected` 事件新增可选 `adaptive` 事实：`resultCode`、`scored`，以及只在最终装配真的包含该 id 时才出现的 `appendedActivationId`（以最终装配为准，不以“模型选中”为准）。
- host-runtime 诊断行新增 `targetActivationId`，并新增只读的 `readAdaptiveInjectionRecords`（严格 unknown 解析、按工作区过滤、最新在前）。
- Codex pd-hook 在不改变 Native 路径的前提下记录该事实；`needs_setup` 记为 0 次评分请求。
- 设置页新增工作区入口：当前工作区、开关、最需要处理的一件事（零原则 / 读取告警阻断 / 既有替换配置 / 已开启待机会）、固定服务组合、发送数据说明、「已保存」与「已观察到宿主调用」分离、上一次结果与静态前后示例。保存配置零评分请求。
- 追加模式边界：`replaceableActivationIds` 非空时拒绝开启与改写服务配置（仍可关闭），通用开关写入同样受该边界约束。
