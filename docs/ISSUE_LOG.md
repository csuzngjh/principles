# Issue Log

每次收到痛苦信号（Pain Signal）时，自动追加一条记录。

## 记录格式说明

每条 issue 记录应包含以下字段：

### Pain Signal (auto-captured) - 自动捕获的信息
- time: ISO 8601 时间戳（如 2026-01-22T12:34:56+08:00）
- tool: 操作类型（Write/Edit/Read/etc.）
- file_path: 文件路径
- risk: 是否风险操作（true/false）
- test_level: 测试级别（smoke/unit/full）
- command: 执行的命令
- exit_code: 退出码

### Diagnosis - Claude 填写的诊断
- Proximal cause (verb): 直接原因（动词）
- Root cause (adjective/design/assumption): 根本原因
- 5 Whys: 连续问5个为什么
- Category: People | Design | Assumption

### Principle Candidate - 原则候选
- Principle: 原则描述
- Trigger: 触发条件
- Exceptions: 例外情况

### Guardrail Proposal - 护栏提案
- rule / hook / test: 护栏类型
- minimal regression test: 最小回归测试

---

<!-- 实际 issue 记录从下方追加（使用 ## [时间戳] 标题）-->

## [2026-02-13T22:56:16.570184] Pain detected - Simulated Pain

### Pain Signal (auto-captured)
```
Simulated Pain

```

### Diagnosis (Pending)
- Run /evolve-task to diagnose.

## [2026-02-13T22:57:55.232305] Pain detected - Simulated Pain

### Pain Signal (auto-captured)
```
Simulated Pain

```

### Diagnosis (Pending)
- Run /evolve-task to diagnose.

## [2026-02-15T13:18:24.498349] Pain detected -

### Pain Signal (auto-captured)
```

```

### Diagnosis (Pending)
- Run /evolve-task to diagnose.

## [2026-02-15T13:23:14.567542] Pain detected -

### Pain Signal (auto-captured)
```

```

### Diagnosis (Pending)
- Run /evolve-task to diagnose.

## [2026-02-15T13:32:22.506057] Pain detected -

### Pain Signal (auto-captured)
```

```

### Diagnosis (Pending)
- Run /evolve-task to diagnose.
