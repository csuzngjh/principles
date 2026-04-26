# Phase m6-04: PD CLI Extension + Error Mapping - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** m6-04-PD-CLI-Extension-Error-Mapping
**Areas discussed:** runtimeMode CLI 传递方式, pd runtime probe 实现, CLI 错误输出格式

---

## Gray Area 1: runtimeMode CLI 传递方式

| Option | Description | Selected |
|--------|-------------|----------|
| CLI flag — --openclaw-local/--openclaw-gateway | `pd diagnose run --runtime openclaw-cli --openclaw-local --agent <id>` — HG-03 最直接满足，每个命令都显式 | ✓ |
| Config/env var — OPENCLAW_RUNTIME_MODE | 环境变量控制，适合配置在 .env 中 | |
| CLI flag + env var fallback | CLI flag 优先，缺失则读 env var，最灵活 | |

**User's choice:** CLI flag — --openclaw-local/--openclaw-gateway
**Notes:** HG-03 要求必须 explicit，CLI flag 最直接。两个 flag 互斥，都存在时报错。

---

## Gray Area 2: pd runtime probe 实现

| Option | Description | Selected |
|--------|-------------|----------|
| Adapter healthCheck() + getCapabilities() 直接调用 | CLI 直接调用 OpenClawCliRuntimeAdapter 的方法，最直接，符合 HG-1 | ✓ |
| 通过 RuntimeSelector.probe() 统一接口 | 更抽象，但 probe() 接口可能还不存在 | |
| 独立 probe 命令，不调用真实 adapter | 只检查 binary 是否存在，最轻量但不验证真实健康状态 | |

**User's choice:** Adapter healthCheck() + getCapabilities() 直接调用
**Notes:** Probe command 直接实例化 OpenClawCliRuntimeAdapter，调用 healthCheck() 和 getCapabilities()。

---

## Gray Area 3: CLI 错误输出格式

| Option | Description | Selected |
|--------|-------------|----------|
| Human-readable + exit code (默认), --json 时输出结构化 JSON | console: `error: openclaw not found (runtime_unavailable)` + exit 1; --json: 结构化 JSON — 最符合现有 CLI 风格 | ✓ |
| Always structured — console 也输出 JSON | 所有输出始终 JSON，更简单但不符合现有 CLI 风格 | |
| Human-readable 错误 + exit code (无 JSON 错误格式) | CLI-04 只要求 success output 支持 JSON，错误始终 human-readable | |

**User's choice:** Human-readable + exit code (默认), --json 时输出结构化 JSON
**Notes:** 符合现有 pd diagnose 命令的风格，--json flag 控制 JSON 输出。

---

## Claude's Discretion

无 — 所有 gray areas 都由用户明确决策。

## Deferred Ideas

无 — discussion stayed within m6-04 scope.
