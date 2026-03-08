---
name: reflection-log
description: Final task reflection and evolution logging. Use to capture pain signals, update profiles, and propose new principles.
disable-model-invocation: true
---

# Reflection & Evolution

**Goal**: Transform single-task experience into system's permanent memory.

Please execute the following closing operations:

## 1. Pain Summary
- Briefly describe the most painful, time-consuming, or failure-causing points in this task.

## 2. Issue Logging
- **Action**: Append detailed Pain Signal and diagnosis results to `docs/ISSUE_LOG.md`.

## 3. Evolution Candidates
- **Principle**: Propose a new principle (P-XX).
- **Guardrail**: Suggest a specific Hook, Rule, or Test.
  - **Path Interception**: Suggest adding sensitive directories to `risk_paths` in `docs/PROFILE.json`.
  - **Behavior Interception**: Suggest adding regex to `custom_guards` in `docs/PROFILE.json` to intercept dangerous calls of specific tools (e.g., `Edit.*SYSTEM`).

## 4. Positive Reinforcement
- **Check Excellence Signals**: 
  1. User's explicit praise (Quote user).
  2. Objective performance/quality metric improvements (Cite data).
  3. Reviewer's high evaluation (Excellent/Elegant).
- **Extract Pattern**: If above signals exist, record `achievement` field in `docs/.user_verdict.json` describing the successful behavioral pattern.

## 5. Attribution
- **Agent Scorecard**: Evaluate sub-agent performance used in this task, write to `docs/.verdict.json`. Format follows `@docs/schemas/agent_verdict_schema.json`.
- **User Profile**: Evaluate user instruction quality and preferences, write to `docs/.user_verdict.json`. Format follows `@docs/schemas/user_verdict_schema.json`.

## 6. Cleanup
- Clean up all intermediate marker files (e.g., `.pain_flag`, `.verdict.json`, etc.).
