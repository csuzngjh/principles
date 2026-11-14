---
"@principles/pd-cli": minor
"principles-disciple": patch
"@principles/core": patch
"@principles/workbuddy-adapter": patch
"create-principles-disciple": patch
---

让「哪些 pd 命令真的在被使用」第一次可以被回答，并堵住技能文档与真实命令树的漂移。

- 记录：`pd` 进程入口新增一次调用记录（`cli_invocation`），写入 `<workspace>/.pd/telemetry/critical-events.jsonl` —— 该 sink 不轮转；`.pd/logs/events_*.jsonl` 7 天即删，无法承载趋势。记录失败被完全吞掉，绝不改变命令退出码；退出码无法确定时写 `UNKNOWN` 而不是 `0`。
- 只读不破约：记录器只追加到 `pd runtime init` 已引导的 sink，绝不创建目录或文件 —— **未初始化**的工作区里，`pd pain recall` 这类只读命令仍让工作区逐字节不变。sink 已存在时会追加一行 `cli_invocation`（这是记录功能本身；命令 stdout 与退出码不受影响）。pain-recall golden 契约断言的是「不新建文件/目录」，未放宽任何断言。
- 来源：`PD_INVOCATION_SOURCE` 只在真实 spawn 点设置（console / companion / installer / plugin-script），缺省为 `human`。技能侧目前没有包装器会 spawn `pd`，因此没有 `agent-skill` 采集点 —— 不为打点改造调用协议。
- 读取：新增只读命令 `pd runtime usage report --days N`，按命令 × 来源输出计数与退出码分布，并把无法解析的行、窗口外记录、缺失字段分别计入 coverage 与 `UNKNOWN` 桶（不静默丢弃、不当成 0）。
- 漂移：用 `buildPdProgram()` 解析真实命令树，递归扫描全部语言模板 / pd-skills 单一源 / codex / workbuddy 技能树中的 `pd ...` 引用。首次全量扫描（24 个文档、114 处引用）发现 6 个投递文件与 core 三处 `nextAction` 引导了一个从未注册的命令 `pd principle list`。修法为改文档与引导（改为从工作区账本 `.state/principle_training_state.json` 的 `_tree.principles` 读取），不新增对外命令面。
- CI：技能投递文件变更此前只触发 installer scope，契约测试不会运行；现在同时激活 `cli` scope，模板改动即触发该守卫。
