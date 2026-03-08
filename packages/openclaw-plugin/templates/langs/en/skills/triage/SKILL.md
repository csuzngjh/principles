---
name: triage
description: Initial problem definition and risk assessment. Use to collect environment info, reproduction steps, and logs.
disable-model-invocation: true
---

# Triage (Problem Triage)

**Goal**: Collect sufficient evidence to define the problem and assess change risk.

Please output in the following structure:

## 1. Goal
- One sentence describing the final success criteria for this task.

## 2. Problem
- What is happening now? What is the expected behavior?
- **Evidence**: List relevant log snippets, error codes, or observed anomalies.

## 3. Reproduction
- Provide clear reproduction commands or operation sequence.
- Note key variables in current environment.

## 4. Scope
- Preview of involved files or modules.
- **Risk Level**: Low / Medium / High (based on `docs/PROFILE.json` definition).

## 5. Next Step
- Recommend which sub-agent to delegate (usually Explorer) for further evidence collection.
