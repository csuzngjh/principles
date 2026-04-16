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

## Validated (Phase 39)

- Correction keyword learning loop: FPR/TP counters, weighted confidence scoring, CorrectionObserverWorkflowManager, keyword_optimization trigger system
- CR-01 fix: correction cue detection correctly records true positives (not false positives)
- keyword_optimization periodic trigger fires independently of trigger_mode

## Active

- Production stabilization is more important than new surface features
- God classes (evolution-worker.ts 2689L, nocturnal-trinity.ts 2429L) are the primary maintenance bottleneck
- Type safety (`as any` casts) causes missed compile-time errors and runtime bugs
- Queue integration tests are missing — bugs in enqueue/dequeue/migration go undetected

## Out of Scope

- New UI/dashboard work
- New feature surface areas
- LoRA or full fine-tune internalization paths
- General cleanup not tied to debt reduction

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

## Current Milestone: v1.19 Tech Debt Remediation

**Goal:** 逐步清理技术债，提升代码质量、可维护性和系统稳定性

**Target features:**
- Quick Wins: 修复 busy-wait loop、JSON parse 安全、constant-time token compare
- God Class 拆分: 将 `evolution-worker.ts` (2689L) 和 `nocturnal-trinity.ts` (2429L) 拆分为专注模块
- Type Safety: 清理 `as any`/`as unknown` casts，建立 proper 类型接口
- Queue Integration Tests: 为 enqueue/dequeue/migration 路径添加集成测试
- Security Hardening: constant-time token compare, JSON validate before parse

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

*Last updated: 2026-04-14 after Phase 39 (learning-loop) completion*
