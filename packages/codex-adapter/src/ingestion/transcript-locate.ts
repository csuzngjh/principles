/**
 * Codex transcript locator — Slice D (PRI-625) moved the implementation to
 * @principles/host-runtime (codex-transcript-locate) so the §15 health
 * service computes per-rollout lag with the SAME locator the catch-up path
 * uses. This module re-exports it for compatibility with existing importers.
 */
export { locateCodexTranscriptByRolloutIdentity, parseRolloutFileName } from '@principles/host-runtime';
export type { CodexTranscriptLookup } from '@principles/host-runtime';
