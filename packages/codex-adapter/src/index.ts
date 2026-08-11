/**
 * @principles/codex-adapter — Codex CLI Host Adapter (ADR-0020)
 *
 * Implements HostAdapter for OpenAI Codex CLI's stdin/stdout JSON hook model.
 * This package is INDEPENDENT of `packages/openclaw-plugin/` — the two hosts
 * have different extension models (Codex: subprocess; OpenClaw: in-process).
 */
export { CodexHooksHostAdapter } from './host-adapter.js';
export { processHookInvocation } from './pd-hook.js';
export type { PdHookResult } from './pd-hook.js';
export * from './codec/index.js';
