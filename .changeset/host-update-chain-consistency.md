---
"create-principles-disciple": patch
"@principles/pd-cli": patch
---

修复三宿主更新一致性：升级与首装都会覆盖本机已安装的宿主，Codex 插件载荷与 PLUGIN_DATA 运行时原地对齐（无需卸载重装），并让 `pd-status` 如实报出载荷、运行时与市场源 checkout 的漂移。

- 安装器新增 `detectInstalledHosts` / `planUpgradeHosts`：按已有安装清单与宿主注册事实（OpenClaw 扩展目录、Codex marketplace 注册与缓存、WorkBuddy 插件注册表）判定已安装宿主，升级与首装都纳入刷新范围；新发现的宿主显式打印一行提示，不静默多改。
- 安装结束输出逐宿主摘要 `Install summary:`，并写入 `InstallResult.hostSummary`：这次实际动过的宿主、落到的运行时版本与配置动作；未触碰的宿主不出现。
- Codex：当插件载荷 pin 落后于规范运行时，用 `codex plugin add` 原地刷新载荷（Codex 缓存据此发现新版本），再由 `pd-setup.cjs` 把 PLUGIN_DATA 运行时对齐到自身 pin；失败时给出 `manualActionRequired` 与 `codex plugin add` 下一步，不再建议卸载。
- `pd-status` 快照检查：载荷 pin 落后已安装发布、或本地 marketplace 源 checkout 落后 `origin/main` 时报 degraded 并给出可执行的下一步，不再在源已落后时谎报「与市场源一致」。
