---
name: pd-runtime-v2
description: 当需要手动触发、验证或调试 Principles Disciple Runtime V2 痛苦诊断时使用。本技能强制使用 Runtime V2 入口：自动入口是高价值门控痛苦事件，手动入口是 `pd pain record`。禁止直接写 `.state/.pain_flag`。
disable-model-invocation: false
---

# PD Runtime V2 痛苦诊断

所有痛苦诊断都走 Runtime V2。不要把 legacy pain flag 文件当作诊断入口。

## 入口

自动入口：
- 工具失败先累计 GFI/摩擦。
- 只有高价值 episode 才进入 Runtime V2：高 GFI、重复同类失败、严重语义痛苦、LLM paralysis，或明确手动 pain。
- 通过门控的 `pain_detected` 进入 `PainSignalBridge`。
- Bridge 调用 `DiagnosticianRunner`，提交 candidate，并 intake 到 ledger。

手动入口：
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

禁止入口：
- 不要写 `.state/.pain_flag`。
- 不要用 `write_file`、shell 重定向、`Set-Content`、`Out-File`、`node -e` 或任何文件写入方式创建 `.state/.pain_flag`。
- 不要使用 `write_pain_flag` 工具。Runtime V2 不使用这个工具。

## 状态查看命令

运行时健康检查：
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
```

业务流策略：
```bash
pd runtime flow show --workspace "<workspace>" --json
```

候选原则：
```bash
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
```

## 成功标准

一次诊断只有在同时满足以下条件时才算成功：
- `status` 是 `succeeded`
- `candidateIds` 非空
- `ledgerEntryIds` 非空

只创建 task 不算成功。没有 candidate 或 ledger entry 的 run 是失败、重试或未完成。

## 需要手动诊断时

1. 使用 `pd pain record`。
2. 检查 JSON 输出。
3. 如果 `candidateIds` 或 `ledgerEntryIds` 为空，视为未完成。
4. 用 `pd candidate list/show` 和 `pd runtime flow show` 继续排查。
