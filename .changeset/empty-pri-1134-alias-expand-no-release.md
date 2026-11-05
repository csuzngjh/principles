---
---

PRI-1104 Stage 0 (PR-1 / PRI-1134): 内部读取兼容层，无用户可见行为变化，明确声明 no-release。

- `output-schema-registry` 新增双向 version-neutral ↔ versioned ref 别名；写入侧 13 个 registry key 与所有 runner 不变。
- `prompt-injection-budget-observation` 增加 budgetPolicyVersion 读取白名单（当前两个值相同，零行为变更）。
- `io-seam-registry.json` 增加 namingPolicy 豁免段；新增 warn-only 命名守门脚本与 `docs/audit/` 收敛报告。
