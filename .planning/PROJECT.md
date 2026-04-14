# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- Runtime `Rule Host`, replay evaluation, and manual implementation lifecycle flows exist
- Nocturnal background reflection pipeline exists and can emit production-facing artifacts
- Minimal rule bootstrap and live replay validation shipped in `v1.12`
- CI and lint baseline are green from `v1.9.3`

## Active

- Production stabilization is more important than new surface features
- Boundary contracts around workspace resolution, runtime capability checks, and critical state-file parsing are the current bottleneck
- End-to-end trust in nocturnal depends on fail-fast behavior, not silent fallback

## Out of Scope

- Thinking Models page improvements during this milestone
- New UI/dashboard work
- LoRA or full fine-tune internalization paths
- General cleanup not tied to boundary risk reduction

## Context

- Main runtime lives in `packages/openclaw-plugin/src/`
- Primary production path under scrutiny: pain -> queue -> nocturnal -> replay -> promotion
- Recent production debugging showed repeated failures from wrong workspace resolution, runtime capability guessing, and format drift
- Existing milestone state had drifted; `v1.13` resets planning to the actual current problem

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stabilize production path before new UI work | A richer UI is low value if the underlying loop is not trustworthy | Active |
| Prefer fail-fast over fallback | Silent fallback caused hidden corruption and delayed failures | Active |
| Introduce one contract per boundary type | Path, runtime, and schema logic must stop being reimplemented ad hoc | Active |
| Use end-to-end tests for boundary protection | Unit tests did not catch integration drift with OpenClaw | Active |

## Current Milestone: v1.14 Keyword Learning Engine

**Goal:** 为 correction cue 检测创建动态关键词学习机制，复用 empathy engine 的抽象模式

**Target features:**
- 创建 `KeywordLearningEngine` 抽象层，支持多类型关键词（empathy、correction）
- correction cue 替换硬编码关键词为动态存储
- 实现学习循环：匹配 → 反馈 → FPR 跟踪 → LLM 优化
- 持久化到 `correction_keywords.json`

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. "What This Is" still accurate? Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check
3. Audit Out of Scope
4. Update Context with current state

*Last updated: 2026-04-14 after v1.14 milestone started*
