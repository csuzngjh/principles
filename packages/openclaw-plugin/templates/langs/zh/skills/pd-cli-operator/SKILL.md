---
name: pd-cli-operator
description: 操作 Principles Disciple `pd` CLI 时使用：运行时健康检查、手动记录痛苦、查看 task/run/candidate/artifact、intake candidate、查看 flow policy、追踪痛苦到原则的证据链。本技能提供安全 CLI 路由，并禁止直接写 `.state/.pain_flag`。
disable-model-invocation: false
---

# PD CLI Operator

把 `pd` CLI 当作唯一受支持的操作界面。不要手工修改 PD state 文件，除非某个 CLI 命令明确要求这样做。

## Runtime V2 痛苦诊断

手动痛苦诊断（绑定已记录的会话，让诊断携带真实轨迹证据）：
```bash
pd pain record --reason "<reason>" --score <0-100> --workspace "<workspace>" --session "<session-id>" --json
```

- 不带 `--session` 的记录是诚实的 unbound Owner 报告：没有轨迹证据，
  候选大概率被准入阈值拦为 `needs_evidence` —— CLI 输出会明确警告。
- `--session <id>` 会先校验；会话不存在时以 `session_not_found` 失败，
  不会写入任何内容。

成功标准：
- `status` 是 `succeeded`
- 候选被**准入**而非仅被生成：检查 `admissionResults` /
  `candidateOutcomes` 中的 `admitted` 决策和 `ledgerEntryIds` 非空

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

## 追踪痛苦到原则链（PRI-455 提升）

追踪从痛苦信号到原则账本的完整证据链：
```bash
pd trace show --pain-id "<painId>" --workspace "<workspace>" --json
```

## 激活管理（PRI-455 提升）

列出当前激活：
```bash
pd activation list --workspace "<workspace>" --json
```

停用（回滚）激活：
```bash
pd activation deactivate --activation-id "<activationId>" --workspace "<workspace>" --json
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
