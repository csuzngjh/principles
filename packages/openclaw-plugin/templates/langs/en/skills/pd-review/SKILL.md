---
name: pd-review
description: Use when the Owner wants to inspect PD diagnoses, principle candidates, or governance state, or asks to approve, reject, or activate a principle. Every Owner decision must be completed by the Owner in the official Web Console.
disable-model-invocation: false
---

# PD Review

## Purpose

Help the Owner inspect real evidence and reach the official PD governance interface. The skill may query, explain, and open the Console, but it cannot make the decision for the Owner.

## Workflow

1. Confirm the task concerns PD pain, diagnosis, candidates, or principle governance—not ordinary code review.
2. Use `pd-cli-operator` or an existing real receipt to verify state. Distinguish the Owner's statement, host trajectory, model diagnosis, admission decision, and completed governance action.
3. Open the Console using the workspace confirmed by the current OpenClaw host: `pd console open --workspace "<workspace>"`. Never guess the workspace.
4. Report that the Console started only when the command returns real success. If it fails, preserve the error and route host-installation diagnosis to `pd-control`.
5. Ask the Owner to inspect the evidence and personally complete approval, rejection, or another governance action in the Console.

## State boundaries

- A candidate's existence does not mean it was approved.
- Opening the Console does not mean it was approved.
- The Owner saying "approve" does not prove the Console action has completed.
- Approval, activation, and a subsequent behavior change are separate stages and must be verified separately.

## Never

- Approve, reject, or activate a principle through CLI, scripts, databases, files, or another skill.
- Fall back to CLI approval when the Console is unavailable.
- Fabricate an Owner decision or describe candidate generation/admission as activation.
