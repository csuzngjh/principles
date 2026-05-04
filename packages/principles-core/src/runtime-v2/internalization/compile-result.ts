/**
 * Compile Result — Pure type for principle compilation outcomes
 *
 * PRI-44: Pure type, zero infrastructure dependency.
 */

export interface CompileResult {
  success: boolean;
  principleId: string;
  ruleId?: string;
  implementationId?: string;
  code?: string;
  reason?: string;
}
