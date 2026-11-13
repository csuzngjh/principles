---
"create-principles-disciple": patch
---

安装器：release-manager 的 `@principles/install-layout` 依赖链接到 canonical 兄弟包（PRI-1201）

- 新增 `ensureReleaseManagerResolution()`，复用既有 `ensureComponentFileDependencyLinks()`，把部署树上 npm/构建期物化的实体副本替换为指向 `~/.pd/runtime/install-layout` 的链接。
- 与 `ensurePdCliResolution()` / `ensureConsoleResolution()` / `ensureCodexAdapterResolution()` / `ensureHostRuntimeResolution()` 同型；调用点在 `installReleaseManagerDependencies()` 之后、`verifyReleaseManagerAuthorityImports()` 之前。
- 修复升级后 `release-manager` 仍加载旧 `install-layout` 副本导致的版本错位。
