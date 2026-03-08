---
name: reflection
description: Perform a deep metacognitive reflection on the current task status, user sentiment, and systemic issues. Use this before context compaction or when stuck.
disable-model-invocation: false
---

# Metacognitive Reflection

**Trigger Scenario**: Context about to be compacted (Memory Loss Imminent) or Task long-term stalled.
**Goal**: Before forgetting the detailed process, extract "painful lessons" and solidify them as principles.

Please execute the following reflection steps:

## 1. Status Scan
- **Goal**: What was our original objective? (Check `docs/PLAN.md` or early conversation)
- **Status**: How much is completed now? Where are we stuck?
- **Cost**: We've consumed significant tokens. Is the output matching the cost?

## 2. Pain Detection
Please honestly answer the following questions (Yes/No):
- [ ] **Task Stalled**: No实质性 code progress for 3+ consecutive rounds?
- [ ] **Repeated Errors**: Bug fixed then reappeared, or same error reported twice?
- [ ] **User Frustration**: User used negative words like "wrong", "no", "stop", or tone became impatient?
- [ ] **Blind Action**: Modified code directly without PLAN or AUDIT?
- [ ] **Architecture Degradation**: Is code more chaotic than when we started?

## 3. Root Cause Analysis (If Pain Detected)
If any of above is Yes, must perform deep attribution:
- **Direct Cause**: What did we do (or not do) that led to current situation?
- **Root Cause**: Where did our mental model go wrong? (Too eager? Ignored existing files? Disregarded tests?)

## 4. Evolution Logging
If pain detected, must execute:
1. **Record**: Write analysis results to `docs/ISSUE_LOG.md`.
2. **Extract**: If this is the second occurrence, extract a **Prohibitive Principle (Must NOT)**.
3. **Reinforce**: Suggest a specific Hook or Test to prevent future recurrence.

## 5. Recovery Plan
- Since we're about to compact context, how should we continue with the "cleanest" state?
- Update `docs/PLAN.md`, mark current progress, ensure seamless continuation after compaction.
