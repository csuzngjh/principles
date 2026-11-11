---
'@principles/codex-adapter': patch
'@principles/host-runtime': patch
---

把 Codex `UserPromptSubmit` 宿主的 5 秒 hook 窗口接到 Adaptive 有效截止上。

此前 Codex hook 只按 `10s 首字节 + 10s 生成` 计时，宿主会在 5 秒到点时直接终止子进程并丢弃输出；
实测中自适应选择跨过宿主截止（5060 ms），Native 正文与诊断一起被截断，传输也没有收到中止。

现在 hook 入口按 `5000 − 800 ms` 建立绝对截止，并复用既有 `AbortSignal` 贯通准入、生成、
授权重验与装配：截止到达即取消传输、忽略迟到结果、保留 Native 正文；诊断新增
`TURN_DEADLINE_EXCEEDED`，与生成超时 `SELECTION_EXPIRED`、正常弃选 `no_increment` 区分。
未提供外层截止的既有调用方（OpenClaw）行为不变。
