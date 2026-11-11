---
"create-principles-disciple": patch
---

Codex 更新链在插件载荷换代后自动补写 `mcp-binding.json`：此前只在运行时 cohort 变化时才运行 `pd-setup`，pin 未变时绑定永远不会补写，launcher 以 `binding_missing` fail-closed，`pd-recall` 从 `tools/list` 中消失。现在绑定缺失或不再指向本载荷 runtime/pin 时也会触发修复，并在修复后校验。
