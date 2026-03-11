---
name: deductive-audit
description: Rigorous safety and logic check of a proposed solution. Evaluates against axioms, system impact, and edge cases.
disable-model-invocation: true
---

# Deductive Audit (演绎审计)

**目标**: 在执行前拦截逻辑错误和潜在风险。

请对当前提议的修复方案进行三审：

## 1. Axiom Test (公理审计)
- 语言规范、库的 API 契约、项目既定约定是否被违反？
- 输入输出类型是否对齐？

## 2. System Test (系统审计)
- 是否引入了新的技术债？
- 是否影响了性能、延迟或稳定性？
- 是否引入了循环依赖？

## 3. Entropy Audit (熵减审计) - *New*
- **必要性**: 这个修改是绝对必要的吗？有没有更简单的解法？
- **最小化**: 是否触碰了不该触碰的文件？（最小接触面原则）
- **反博弈**: 这是一个真实的修复，还是为了过门禁而做的“形式主义”？

## 4. Via Negativa (否定审计)
- 最坏的情况下（网络断开、磁盘满、恶意输入）会发生什么？
- 是否有安全红线（Token 泄露、越权）风险？

## 5. Verdict (裁决)
- **RESULT**: PASS | FAIL
- **Must Fix**: 如果失败，列出必须修正的点。

---
**动作**: 请将以上结果更新至 `AUDIT.md`。
