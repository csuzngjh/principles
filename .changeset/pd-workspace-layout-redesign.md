---
'@principles/core': minor
'@principles/install-layout': minor
'@principles/host-runtime': minor
'@principles/codex-adapter': minor
'@principles/workbuddy-adapter': minor
'@principles/pd-mcp-server': patch
'@principles/pd-cli': minor
'create-principles-disciple': minor
'principles-disciple': patch
---

PD Home 单一路径权威收敛（Workspace Layout Redesign）：三宿主配置根与治理工作区彻底隔离，备份根迁至 `<PD_HOME>/.pd/backups`。

- **install-layout**: `PdHomePaths` 增加 `runtimeDir`/`pdRuntimeBackupsDir`/`openclawExtensionDir`/`codexWorkspaceDir`/`workbuddyConfigDir`/`workbuddyWorkspaceDir`；生产模式解析 `CODEX_HOME`/`WORKBUDDY_CONFIG_DIR` 覆盖，实验模式对其绝对性与边界 fail-closed（新增 `codex_home_not_absolute`/`codex_home_outside_experiment`/`workbuddy_config_dir_not_absolute`/`workbuddy_config_dir_outside_experiment`）；新增 `getInstallLayoutPathsFromPdHome()` 与 `getWorkbuddyHostConfigPathsFromPdHome()` 供已解析 PD Home 复用，消除同一操作内的双重解析。
- **install-layout / mcp-binding**: `getHostDefaultWorkspaceDirs` 支持 `openclawHome`/`workbuddyConfigDir` 覆盖；launcher-only 拒绝理由新增 `experiment_host_config_invalid`/`openclaw_state_dir_not_absolute`；三份 launcher.cjs 与 `findForeignWorkspaceHost` 保持字节级同源判定。
- **create-principles-disciple**: 备份 canonical 根从 `<openclawHome>/pd-backups` 迁至 `<PD_HOME>/.pd/backups`；`migrateLegacyPdBackups()` 由安装器显式搬迁两处遗留位置（旧 OpenClaw 备份根整体 + extensions/ 兄弟目录），返回可审计结果（保留原名、冲突加确定性后缀、失败保留原件、旧根仅在清空后移除）；卸载器 PD-owned 路径与 release-manager overlay 标记改经 PD Home 权威。
- **pd-console**: 只使用 canonical 备份根；启动期隐式迁移逻辑移除（迁移职责归安装器，Console 不再在启动时搬迁 Owner 文件）。
- **codex-adapter / workbuddy-adapter / host-runtime / pd-cli / pd-mcp-server**: 全部宿主 hook、ingestion、health、setup、worker、telemetry 与 MCP log 路径改经 `resolvePdHome()` 单一权威；实验环境读/写全部落在 lab 根内，非法配置 fail-closed（结构化 reason + nextAction，rc-9），无 os.homedir() 静默回退。
- **core**: `runtime/storage-paths` 扩展为全量工作区相对路径契约（`PD_DIRS`/`PD_FILES`/`resolvePdPath`），openclaw-plugin 的私有副本改为 re-export 该单一权威；物理布局不变（ADR-0023 §2.6）。
