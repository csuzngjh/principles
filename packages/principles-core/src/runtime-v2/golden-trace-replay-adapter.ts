/**
 * GoldenTrace Replay Adapter - Code-to-validator bridge with injected sandbox
 *
 * PRI-115: Provides a convenience function that loads raw code string
 * into a sandbox and runs the replay validator against GoldenTrace cases.
 *
 * The sandbox loader is injected to keep core free of node:vm imports.
 */

import type { GoldenTraceCase } from './golden-trace.js';
import {
  replayGoldenTrace,
  DEFAULT_REPLAY_VALIDATOR_CONFIG,
  type ReplayValidatorResult,
  type ReplayValidatorConfig,
  type ReplayEvaluateFn,
} from './golden-trace-replay-validator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayCodeInput {
  code: string;
  cases: readonly GoldenTraceCase[];
  config?: Partial<ReplayValidatorConfig>;
}

export type SandboxEvaluateLoader = (code: string) => ReplayEvaluateFn;

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function replayValidateCode(
  input: ReplayCodeInput,
  loadEvaluate: SandboxEvaluateLoader,
): ReplayValidatorResult {
  const config = { ...DEFAULT_REPLAY_VALIDATOR_CONFIG, ...input.config };
  const evaluateFn = loadEvaluate(input.code);
  return replayGoldenTrace(evaluateFn, input.cases, config);
}
