---
"@principles/pd-cli": minor
---

`pd runtime compatibility-scan` 支持新增的 `incomplete` 状态（5B-C）。

- 文本输出在 `incomplete` 时不再打印"没有任何规则引用退役符号"这类等同
  clean 的结论，改为明写扫描不完整、相关规则兼容性未验证，并按 reason 列出
  `reason=count (sample: …)`。
- 退出码保持 0：`incomplete` 是警告不是闸门（`ok` 仍为 true）；只有
  `legacy_dependency` / `scan_failed` 退 1。
- `--json` 原样透传 `status=incomplete` 与 `skipped`。

Minor：命令的机器可读输出契约里 `status` 是枚举，新增成员会让按枚举穷举解析
的消费者失败（例如只接受 `clean | no_state_db` 的预检实现）；文本措辞变化本身
只需 patch。
