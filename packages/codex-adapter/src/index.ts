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
export { resolveCodexHome, canonicalizePath } from './ingestion/codex-home.js';
export { validateCodexTranscriptPath } from './ingestion/transcript-path.js';
export type { TranscriptPathValidation, TranscriptFileIdentity } from './ingestion/transcript-path.js';
export { classifyCodexVersion, CODEX_INGESTION_MIN_VERSION, CODEX_INGESTION_VERIFIED_VERSION } from './ingestion/codex-version.js';
export { ingestCodexConversation, setCodexTranscriptPortForTest, ingestCodexTranscriptFromPath } from './ingestion/ingestion.js';
export type { CodexIngestionOptions, CodexIngestionOutcome, CodexTranscriptFromPathArgs } from './ingestion/ingestion.js';
export { decodeTranscriptWindow, createNodeTranscriptPort, TranscriptReplacedError, CODEX_INGESTION_MAX_BATCH_BYTES, CODEX_INGESTION_MAX_BATCH_RECORDS } from './ingestion/transcript-decoder.js';
export type { TranscriptPort, TranscriptExpectedIdentity, DecodedDelta, TranscriptDecodeStop } from './ingestion/transcript-decoder.js';
// PRI-624 Slice C: bounded catch-up + per-workspace worker cycle.
export { catchUpCodexIngestion, CODEX_CATCH_UP_NEXT_ACTION } from './ingestion/catch-up.js';
export type { CodexCatchUpOptions, CodexCatchUpResult, CodexCatchUpRolloutResult } from './ingestion/catch-up.js';
export { locateCodexTranscriptByRolloutIdentity } from './ingestion/transcript-locate.js';
export type { CodexTranscriptLookup } from './ingestion/transcript-locate.js';
export { runCodexWorkspaceWorkerCycle, computeCodexWorkerStatusMode } from './worker/workspace-worker.js';
export type { CodexWorkerMode, CodexWorkerCycleResult, CodexWorkerCycleStepReport, CodexWorkerCycleOptions, CodexWorkerStatusEvaluation } from './worker/workspace-worker.js';
