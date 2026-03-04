---
name: root-cause
description: Deep dive analysis into why a problem occurred. Uses the 5 Whys method and classifies the cause.
disable-model-invocation: true
---

# Root Cause Analysis (根因分析)

**目标**: 穿透现象看本质，防止重复犯错。

请按以下格式执行诊断：

## 1. Proximal Cause (直接原因)
- **动词驱动**: 描述了什么具体操作或缺失导致了即时失败。

## 2. 5 Whys (深度追问)
1. 为什么直接原因会发生？
2. ...
3. ...
4. ...
5. 追问到系统性或认知性根源。

## 3. Root Cause (根本原因)
- **形容词/设计驱动**: 描述系统架构、流程缺陷或错误的假设。
- **Guardrail Failure Analysis**: 为什么现有的门禁 (Hooks) 或 规则 (Rules) 没能拦截这个错误？是规则缺失、匹配不严还是逻辑漏洞？

## 4. Category (分类)
- [ ] **People**: 能力盲区、习惯问题。
- [ ] **Design**: 流程/工具缺陷、门禁不足、架构漏洞。
- [ ] **Assumption**: 对环境、版本或依赖的错误前提假设。

## 5. Principle Candidate (原则提炼)
- 如果我们修复了这个问题，应该增加什么原则防止它再次发生？
