---
"@principles/core": minor
---

诊断上下文接入 promoted 治理证据窗口（只读）。

- `SqliteContextAssembler` 在存在 `sourcePainId` 时，通过已注册的 `diagnosis-evidence-read`
  seam 读取 `trajectory.db` 中 `retention_class='promoted'` 且 `promotion_ref` 等于该
  pain id 的证据窗口，作为本次诊断的会话证据；读取失败、窗口为空、被截断、无可读文本
  都写入 `ambiguityNotes`，不会静默退化成“没有证据”。
- 该 reader 只读、不建库、不写库、不新增 schema；窗口按 `source_order` 升序，无位置的
  实时行排在有位置的行之后，超出预算时保留最近的条目。
- 同时兼容两种已落库的 tool facts 形态：实时 hook 的 `{params, result}` 与转录回放的
  `{command, stdout, stderr, exitCode}`，避免 Codex 主路径的 tool 命令与输出丢失。
