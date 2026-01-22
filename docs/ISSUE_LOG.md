# Issue Log

每次收到痛苦信号（Pain Signal）时，自动追加一条记录。

## 格式说明

```markdown
## [YYYY-MM-DD HH:MM:SS] <Title>

### Pain Signal (auto-captured)
```
time: ...
tool: ...
file_path: ...
risk: ...
test_level: ...
command: ...
exit_code: ...
```

### Diagnosis (to be filled by Claude)
- Proximal cause (verb):
- Root cause (adjective/design/assumption):
- 5 Whys:
  1.
  2.
  3.
  4.
  5.
- Category: People | Design | Assumption

### Principle Candidate
- Principle:
- Trigger:
- Exceptions:

### Guardrail Proposal
- rule / hook / test:
- minimal regression test:
```

---

<!-- 第一条记录从这里开始追加 -->

## [2026-01-22T11:25:13+08:00] Pain detected - time: 2026-01-22T11:23:18+08:00 tool: Edit file_path: /mnt/d/code/principles/tes

### Pain Signal (auto-captured)
```
time: 2026-01-22T11:23:18+08:00
tool: Edit
file_path: /mnt/d/code/principles/tests/test_hooks.sh
risk: false
test_level: smoke
command: npm test --silent
exit_code: 254
```

### Diagnosis (to be filled by Claude)
- Proximal cause (verb):
- Root cause (adjective/design/assumption):
- 5 Whys:
  1.
  2.
  3.
  4.
  5.
- Category: People | Design | Assumption

### Principle Candidate
- Principle:
- Trigger:
- Exceptions:

### Guardrail Proposal
- rule / hook / test:
- minimal regression test:

## [2026-01-22T11:27:15+08:00] Pain detected - time: 2026-01-22T11:26:19+08:00 tool: Write file_path: /mnt/d/code/principles/do

### Pain Signal (auto-captured)
```
time: 2026-01-22T11:26:19+08:00
tool: Write
file_path: /mnt/d/code/principles/docs/SHELLCHECK_GUIDE.md
risk: false
test_level: smoke
command: npm test --silent
exit_code: 254
```

### Diagnosis (to be filled by Claude)
- Proximal cause (verb):
- Root cause (adjective/design/assumption):
- 5 Whys:
  1.
  2.
  3.
  4.
  5.
- Category: People | Design | Assumption

### Principle Candidate
- Principle:
- Trigger:
- Exceptions:

### Guardrail Proposal
- rule / hook / test:
- minimal regression test:

## [2026-01-22T11:39:05+08:00] Pain detected - time: 2026-01-22T11:38:47+08:00 tool: Write file_path: /mnt/d/code/principles/do

### Pain Signal (auto-captured)
```
time: 2026-01-22T11:38:47+08:00
tool: Write
file_path: /mnt/d/code/principles/docs/CLAUDE_CODE_MASTER_REVIEW.md
risk: false
test_level: smoke
command: npm test --silent
exit_code: 254
```

### Diagnosis (to be filled by Claude)
- Proximal cause (verb):
- Root cause (adjective/design/assumption):
- 5 Whys:
  1.
  2.
  3.
  4.
  5.
- Category: People | Design | Assumption

### Principle Candidate
- Principle:
- Trigger:
- Exceptions:

### Guardrail Proposal
- rule / hook / test:
- minimal regression test:
