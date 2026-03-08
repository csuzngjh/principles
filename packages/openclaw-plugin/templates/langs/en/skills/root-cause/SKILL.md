---
name: root-cause
description: Deep dive analysis into why a problem occurred. Uses the 5 Whys method and classifies the cause.
disable-model-invocation: true
---

# Root Cause Analysis

**Goal**: See through phenomena to essence, prevent repeated mistakes.

Please execute diagnosis in the following format:

## 1. Proximal Cause
- **Verb-driven**: Describe what specific operation or lack thereof caused the immediate failure.

## 2. 5 Whys (Deep Inquiry)
1. Why did the proximal cause occur?
2. ...
3. ...
4. ...
5. Trace back to systemic or cognitive root.

## 3. Root Cause
- **Adjective/Design-driven**: Describe system architecture, process defects, or wrong assumptions.
- **Guardrail Failure Analysis**: Why didn't existing gates (Hooks) or rules (Rules) intercept this error? Is it missing rules, loose matching, or logic loopholes?

## 4. Category
- [ ] **People**: Capability blind spots, habit issues.
- [ ] **Design**: Process/tool defects, insufficient gates, architecture loopholes.
- [ ] **Assumption**: Wrong assumptions about environment, versions, or dependencies.

## 5. Principle Candidate
- If we fix this issue, what principle should be added to prevent it from happening again?
