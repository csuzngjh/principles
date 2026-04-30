---
name: pd-cli-operator
description: 操作 Principles Disciple `pd` CLI 时使用：运行时健康检查、手动记录痛苦、查看 task/run/candidate/artifact、intake candidate、查看 flow policy、清理 legacy state。本技能提供安全 CLI 路由，并禁止直接写 `.state/.pain_flag`。
disable-model-invocation: false
---

# PD CLI Operator

把 `pd` CLI 当作唯一受支持的操作界面。不要手工修改 PD state 文件，除非某个 CLI 命令明确要求这样做。

## Runtime V2 痛苦诊断

手动痛苦诊断：
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --json
```

成功标准：
- `status` 是 `succeeded`
- `candidateIds` 非空
- `ledgerEntryIds` 非空

禁止：
- 不要写 `.state/.pain_flag`。
- 不要用 `write_file`、shell 重定向、`Set-Content`、`Out-File` 或 `node -e` 创建 pain flag。

## 健康检查和策略

运行时探针：
```bash
pd runtime probe --runtime pi-ai --workspace "<workspace>" --json
```

业务流策略：
```bash
pd runtime flow show --workspace "<workspace>" --json
```

## 查看 Runtime V2 对象

Tasks 和 runs：
```bash
pd task show --task-id "<taskId>" --json
pd run show --run-id "<runId>" --json
```

Candidates 和 artifacts：
```bash
pd candidate list --workspace "<workspace>" --json
pd candidate show --candidate-id "<candidateId>" --workspace "<workspace>" --json
pd artifact show --artifact-id "<artifactId>" --workspace "<workspace>" --json
```

手动 intake：
```bash
pd candidate intake --candidate-id "<candidateId>" --workspace "<workspace>" --json
```

## Legacy 管理

只有在明确清理旧状态时使用：
```bash
pd legacy cleanup --workspace "<workspace>" --dry-run
pd legacy cleanup --workspace "<workspace>" --apply
```

不要把 legacy cleanup 当作诊断触发入口。
