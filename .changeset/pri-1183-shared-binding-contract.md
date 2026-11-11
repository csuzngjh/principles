---
"@principles/install-layout": minor
"@principles/pd-cli": patch
"@principles/pd-mcp-server": patch
---

收敛 `mcp-binding.json` 的校验为单一声明。`@principles/install-layout` 新增 `mcp-binding-contract`：schema 常量、三宿主 canonical 入口、`validateMcpBinding` 形状校验、reason 码枚举与表驱动夹具。Codex 安装器的自愈判断与 `pd health` 的内部判定都改为复用该函数，不再各自维护一套更宽松的判据；launcher 仍是无依赖 `.cjs`，由 `pd-mcp-server` 的平价测试实跑真实 launcher 逐条比对各宿主的 reason 字符串（新增码无样例即红）。`pd health` 对外输出码保持不变（`binding_paths_not_absolute`、`server_entry_not_canonical` 等），映射留在 pd-cli 侧并有表征测试。`pd-mcp-server` 的 manifest 变化仅是测试期 `file:` devDependency（不进入运行时依赖图，发布产物不变）。
