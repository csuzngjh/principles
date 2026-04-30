---
name: pd-pain-signal
description: 手动触发 Principles Disciple Runtime V2 痛苦诊断。用户报告 agent 卡住、循环、无响应，或要求记录/触发痛苦信号时使用。强制路径：使用 `pd pain record`；禁止写 `.state/.pain_flag`，禁止使用 legacy write_pain_flag 工具。
disable-model-invocation: false
---

# Pain Signal（Runtime V2）

手动痛苦诊断必须通过 CLI 进入 Runtime V2：

```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

## 禁止

- 不要直接写 `.state/.pain_flag`。
- 不要用 `write_file`、shell 重定向、`Set-Content`、`Out-File`、`node -e` 或任何文件写入方式创建 `.state/.pain_flag`。
- 不要使用 `write_pain_flag`。这是 legacy 路径。

## 验证

使用：
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
pd candidate list --workspace "<workspace>" --json
pd runtime flow show --workspace "<workspace>" --json
```

成功标准是 `candidateIds` 和 `ledgerEntryIds` 都非空。
