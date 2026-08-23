---
title: FAQ | Principles Disciple
description: What is Principles Disciple? Is it an AI memory system or a prompt tool? Does it train the model or only inject prompts? Answers to the most common questions about the AI Agent Governance System.
---

# Frequently Asked Questions

## What is Principles Disciple?

Principles Disciple is an **AI Agent Governance System** that helps owners turn repeated agent corrections into reusable behavioral principles.

Every principle is owner-approved, reviewable, and reversible, and its effect on future agent behavior stays observable.

## What is a principle in Principles Disciple?

A principle is not a simple rule.

It is a reusable behavioral insight extracted from experience — abstract enough to guide decisions across situations, concrete enough to change the agent's next action. See [What is a Principle?](/docs/principles).

## Is PD an AI memory system?

No.

Memory stores information. PD focuses on transforming validated experience into behavioral principles.

Memory answers *"what happened?"*. PD answers *"what should change because of what happened?"*. See [PD vs AI Memory](/comparisons).

## Does PD automatically modify my AI agent?

No.

PD proposes principles, but activation requires owner review.

The system brings evidence and proposals; the Owner keeps judgment. Every activation is reversible, and its effect stays observable.

## Who should use PD?

Developers and AI-native builders who frequently use AI agents and want consistent behavior across sessions.

If you find yourself correcting the same agent behavior again and again, PD turns that repeated correction into a lasting, governed principle.

## Is PD a prompt management tool?

No.

Prompt engineering tells agents what to do before execution. PD learns from actual interactions and validated experience after execution — then converts them into owner-approved principles. See [PD vs Prompt Engineering](/comparisons).

## Does PD automatically generate rules?

No.

PD extracts principles from experience. Specific rules or runtime constraints are only one possible expression of those principles — created selectively, only when the Owner approves promoting a validated bottom line into an executable rule.

## Which environments does PD support?

PD currently integrates with OpenClaw and Codex hosts. See the [installation guide](/install) for details.

## Does PD train the AI model?

No.

PD does not modify model weights. It governs agent behavior through owner-approved principles and runtime mechanisms — a layer around the agent, never inside the model.

## Does PD only inject prompts?

No.

Prompt guidance is only one governance channel. The core idea is **principle internalization**: experience becomes owner-approved principles, and those principles are applied through governance mechanisms — including, for a few vital bottom lines, executable runtime rules that the Owner has explicitly promoted.

## How is PD different from AGENTS.md or CLAUDE.md?

Those files provide static instructions.

PD creates an evolving governance layer based on actual experience: real behavior produces evidence, evidence becomes owner-approved principles, and principles are applied through the governance runtime — reviewable, reversible, observable at every step.

## Where can I read the full product definition?

See the [canonical definition](https://github.com/csuzngjh/principles/blob/main/docs/concepts/pd-canonical-definition.md) in the repository, or the [comparisons page](/comparisons) for how PD differs from adjacent categories.
