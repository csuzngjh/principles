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
export { resolveCodexHome } from './ingestion/codex-home.js';
export { validateCodexTranscriptPath } from './ingestion/transcript-path.js';
export { classifyCodexVersion, CODEX_INGESTION_MIN_VERSION, CODEX_INGESTION_VERIFIED_VERSION } from './ingestion/codex-version.js';
export { ingestCodexConversation, setCodexTranscriptPortForTest } from './ingestion/ingestion.js';
export type { CodexIngestionOptions, CodexIngestionOutcome } from './ingestion/ingestion.js';
export { decodeTranscriptWindow, createNodeTranscriptPort, CODEX_INGESTION_MAX_BATCH_BYTES, CODEX_INGESTION_MAX_BATCH_RECORDS } from './ingestion/transcript-decoder.js';
export type { TranscriptPort, DecodedDelta, TranscriptDecodeStop } from './ingestion/transcript-decoder.js';
