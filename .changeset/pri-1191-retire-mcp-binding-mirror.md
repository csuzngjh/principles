---
"create-principles-disciple": patch
"@principles/install-layout": patch
---

收回 MCP binding 形状校验的 pinned mirror，恢复 install-layout 单一实现（PRI-1191）。触发条件已满足：install-layout 0.8.1 已发布 validateMcpBinding / getCanonicalMcpServerEntry / MCP_BINDING_* 导出，且安装器依赖下限已抬到 ^0.8.1。删除 mcp-binding-shape-mirror.ts 及其 mirror parity 测试，codex-host-installer 的 isMcpBindingHealthy 改回直接 import 共享声明，并清除安装器与共享声明两侧的同源指针注释。校验行为不变：共享权威侧 launcher parity 测试（mcp-binding-contract-parity.test.ts）保留且仍全绿。