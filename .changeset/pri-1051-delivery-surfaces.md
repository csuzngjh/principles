---
'@principles/pd-cli': minor
---

PRI-1051：`pd version --delivery` 一次给出四个交付面（正式运行时 / OpenClaw 扩展 / Codex 插件 / Companion）的并列结论，让「发版完成」变成可机器判定的口径，而不是内部三链全绿。起因是 2026-10-27 的真实事故：正式运行时与 OpenClaw 扩展已是 core 1.297.2，Codex 插件运行时仍是 1.296.2，Owner 只能逐个核版本才发现。

每面只读各自既有权威（`active.json` + 实时 `~/.pd/runtime` 清单、扩展 shell 的 `package.json`、marketplace pin + plugin data 运行时、Companion 独立发版轨道），不缓存、不落新状态、不访问网络（「是否有更新版本发布」仍归更新频道）。结论值：`ok` / `stale`（附刷新命令）/ `ready_needs_host_restart`（字节已新、宿主未重启；宿主启动时刻读不到时为 `unknown`）/ `not_applicable`（本机没装该宿主）/ `unknown`（带结构化 reason + nextAction）。`--json` 仍只输出一个 JSON 对象，`--delivery` 作为附加字段；任一必需面不是 `ok` 时退出码非 0。不带 `--delivery` 时默认输出与退出语义不变。回滚方式：撤回本改动（纯增量、无持久化）。
