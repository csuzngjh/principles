---
"@principles/core": minor
---

PD-SPEC-001 Prompt V2：六个学习链 Agent 的提示词增量优化（Schema/Runner/Feature Flag/输出契约零改动）。RootCause 因果链改为证据有界（不强制五层、禁止用无关证据补层、反事实检查与置信度校准）；Distiller 增加双向验证、scope 校准与空洞原则反例，公理引用默认空数组；Router 修复 raw 输出契约冲突——raw 响应在任何后处理前就要过完整 V2 Schema，提示词改为明确要求逐字复制 diagnosisId/rootCause/evidence/confidence（Runner 保留权威覆盖权），示例改为单一 principle 推荐（不再示范五种 kind 与手写 abstractedPrinciple）；Dreamer 候选上限改为全局 1-5 并要求实质差异；Philosopher 增加候选批判与冲突处理；Scribe executionConditions 示例默认 requiredFacts 空数组（契约版本 v10→v11）。
