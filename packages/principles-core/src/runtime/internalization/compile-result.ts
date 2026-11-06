/**
 * Compile Result - Pure type for principle compilation outcomes
 *
 * PRI-44: Pure type, zero infrastructure dependency.
 * PRI-115: Extended with replay validation result and degradation flag.
 */

import type { ReplayValidatorResult } from '../golden-trace-replay-validator.js';

export interface CompileResult {
  success: boolean;
  principleId: string;
  ruleId?: string;
  implementationId?: string;
  code?: string;
  reason?: string;
  /** PRI-115: Structured replay validation result when GoldenTrace gate runs */
  replayResult?: ReplayValidatorResult;
  /** PRI-115: True when replay failed and compiler degraded to L1 artifact */
  degraded?: boolean;
}
