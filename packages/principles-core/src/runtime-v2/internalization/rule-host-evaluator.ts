/**
 * Rule Host Evaluator — Pure decision merge logic
 *
 * PURPOSE: Iterate loaded code implementations and merge their decisions.
 * Block short-circuits, auto_correct collects (validated), requireApproval
 * collects, allow is implicit.
 *
 * Precedence: block > auto_correct > requireApproval > allow
 *
 * PRI-45: Pure function extracted from the plugin's RuleHost.evaluate().
 * PRI-114: Added auto_correct handling with fail-closed validation.
 * No filesystem, no VM, no side effects.
 */

import type {
  RuleHostInput,
  RuleHostResult,
  LoadedImplementation,
} from './rule-host-contracts.js';
import { validateCorrectionProposal } from './correction-proposal.js';

export interface DecisionMergeLogger {
  warn?: (_message: string) => void;
}

/**
 * Alias for consumers that prefer the RuleHost naming convention.
 * @deprecated Use DecisionMergeLogger instead.
 */
export type RuleHostLogger = DecisionMergeLogger;

/**
 * Merge decisions from multiple loaded implementations.
 *
 * Rules:
 *   - If any implementation returns `block`, short-circuit and return block.
 *   - `auto_correct` proposals are collected and validated.
 *     First valid proposal wins. Invalid proposals are logged and skipped.
 *   - Collect all `requireApproval` results and merge their reasons/diagnostics.
 *   - `allow` results are ignored (no opinion).
 *   - Individual implementation errors are logged and skipped.
 *   - Outer errors return undefined (conservative degradation D-08).
 */
export function mergeDecisions(
  implementations: readonly LoadedImplementation[],
  input: RuleHostInput,
  logger?: DecisionMergeLogger,
): RuleHostResult | undefined {
  if (!implementations || implementations.length === 0) {
    return undefined;
  }

  try {

    let blocked: RuleHostResult | undefined = undefined;
    const autoCorrects: RuleHostResult[] = [];
    const approvals: RuleHostResult[] = [];

    for (const impl of implementations) {
      try {
        const result = impl.evaluate(input);

        if (!result.matched) {
          continue;
        }

        if (result.decision === 'block') {
          blocked = result;
          break;
        }

        if (result.decision === 'auto_correct') {
          autoCorrects.push(result);
        } else if (result.decision === 'requireApproval') {
          approvals.push(result);
        }
        // 'allow' is implicit — no action needed
      } catch (evalError: unknown) {
        logger?.warn?.(
          `[RuleHost] Implementation ${impl.implId} evaluation failed: ${String(evalError)}`
        );
      }
    }

    if (blocked) {
      return blocked;
    }

    // auto_correct takes precedence over requireApproval
    if (autoCorrects.length > 0) {
      for (const ac of autoCorrects) {
        if (ac.correctionProposal) {
          const validation = validateCorrectionProposal(ac.correctionProposal);
          if (validation.valid) {
            return ac;
          }
          logger?.warn?.(
            `[RuleHost] auto_correct proposal from ${ac.ruleId ?? 'unknown'} failed validation: ${validation.errors.join('; ')}`
          );
        } else {
          logger?.warn?.(
            `[RuleHost] auto_correct decision from ${ac.ruleId ?? 'unknown'} missing correctionProposal`
          );
        }
      }
      // All auto_correct proposals invalid — fall through to requireApproval
    }

    if (approvals.length > 0) {
      return {
        decision: 'requireApproval',
        matched: true,
        reason: approvals.map((a) => a.reason).join('; '),
        diagnostics: approvals.reduce<Record<string, unknown>>(
          (acc, a, i) => {
            const prefix = a.ruleId ?? `approval_${i}`;
            const entries = Object.entries(a.diagnostics ?? {});
            for (const [k, v] of entries) {
              acc[`${prefix}_${k}`] = v;
            }
            return acc;
          },
          {}
        ),
      };
    }

    return undefined;
  } catch (hostError: unknown) {
    logger?.warn?.(
      `[RuleHost] Host evaluation failed, degrading conservatively: ${String(hostError)}`
    );
    return undefined;
  }
}
