---
name: pd-pain-signal
description: 手动触发 Principles Disciple Runtime V2 痛苦诊断。用户报告 agent 卡住、循环、无响应，或要求记录/触发痛苦信号时使用。在 OpenClaw 会话中，引导 Owner 使用 /pd-pain 命令（自动绑定真实会话）。在会话外使用 `pd pain record --session <id>`。禁止写 `.state/.pain_flag`，禁止使用 legacy write_pain_flag 工具。
disable-model-invocation: false
---

# Pain Signal（Runtime V2）

会话证据决定一条痛苦能否被诊断。未绑定会话的记录不携带任何轨迹证据，
候选 confidence 低于准入阈值（0.5），全部被 admission gate 拦为
`needs_evidence` —— Owner 的报告被保存，但不会进入内化。

## 在 OpenClaw 会话中（首选）

请 Owner 在发生问题的对话中运行主机命令：

```text
/pd-pain <描述问题>
```

`/pd-pain` 从 OpenClaw 取得经过认证的当前会话，并自动提交该会话的轨迹
证据。你自己无法取得可信的会话 ID（工具执行环境不会注入）；禁止猜测、
扫描或挑选"最新"会话。

## 在会话外（CLI）

绑定一个明确已知、本工作区已记录的会话 ID：

```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json
```

- `--session <id>` 会先对工作区轨迹做校验：会话不存在时以
  `session_not_found` 失败，不会写入任何内容。
- 不带 `--session` 的记录是允许的 unbound Owner 报告，但不附带证据，
  候选大概率被 admission gate 拦为 `needs_evidence` —— CLI 输出会明确
  提示这一点。

## 禁止

- 不要直接写 `.state/.pain_flag`。
- 不要用 `write_file`、shell 重定向、`Set-Content`、`Out-File`、`node -e` 或任何文件写入方式创建 `.state/.pain_flag`。
- 不要使用 `write_pain_flag`。这是 legacy 路径。
- 不要猜测、扫描或推断会话 ID。使用 `/pd-pain`，或使用 Owner 明确提供的 ID。

## 验证

使用：
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
```

成功标准是候选被**准入**（admitted），而不只是被生成：检查
`admissionResults` 中的 `admitted` 决策和 `ledgerEntryIds` 非空。
`needs_evidence` 或 `deferred` 的候选没有被内化 —— 若全部候选被拦截，
请用 `/pd-pain` 或 `--session` 重新记录，让诊断携带真实轨迹证据。
