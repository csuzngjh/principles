/**
 * Rule Host — Constrained execution layer for active code implementations
 *
 * PURPOSE: Load active code implementations from the principle-tree ledger,
 * execute them in a constrained node:vm context, and merge their decisions.
 *
 * ARCHITECTURE:
 *   - Constructor takes stateDir to access the principle-tree ledger
 *   - evaluate(input) loads active code implementations and runs them
 *   - Each implementation executes in an isolated vm context with minimal helpers
 *   - Decision merge: block short-circuits, requireApproval collects, allow is implicit
 *
 * SECURITY CONSTRAINTS (T-12-01, T-12-04):
 *   - Candidate code loads through a dedicated vm context, not the host realm
 *   - No importModuleDynamically callback
 *   - Helpers are a frozen object — implementations cannot modify the helper surface
 *
 * CONSERVATIVE DEGRADATION (T-12-02, D-08):
 *   - On ANY host error (load failure, eval error, vm error): return undefined
 *   - Never throw, never bypass downstream gates (Progressive Gate, Edit Verification)
 */

import * as fs from 'fs';
import {
  listImplementationsByLifecycleState,
} from './principle-tree-ledger.js';
import { loadEntrySource } from './code-implementation-storage.js';
import { createRuleHostHelpers } from './rule-host-helpers.js';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import type {
  RuleHostInput,
  RuleHostResult,
  RuleHostMeta,
  LoadedImplementation,
} from './rule-host-types.js';
import type { Implementation } from '../types/principle-tree-schema.js';

export interface RuleHostLogger {
  /* eslint-disable no-unused-vars -- Reason: logger callback param name intentionally unused - callback only invoked for side effects */
  warn?: (_message: string) => void;
  /* eslint-enable no-unused-vars */
}

export class RuleHost {
  private readonly stateDir: string;
  private readonly logger: RuleHostLogger;

  constructor(stateDir: string, logger: RuleHostLogger = console) {
    this.stateDir = stateDir;
    this.logger = logger;
  }

  /**
   * Evaluate the input against all active code implementations.
   *
   * Returns:
   *   - undefined when no active code implementations exist (no opinion)
   *   - undefined when all implementations return allow or matched=false
   *   - { decision: 'block', ... } when any implementation returns block (short-circuits)
   *   - { decision: 'requireApproval', ... } when any implementation returns requireApproval
   */
  evaluate(input: RuleHostInput): RuleHostResult | undefined {
    try {
      // Load active code implementations from the ledger
      const activeImpls = this._loadActiveCodeImplementations();

      if (activeImpls.length === 0) {
        return undefined;
      }

      // Merge decisions from all active implementations
      // eslint-disable-next-line @typescript-eslint/init-declarations -- undefined is valid zero value, checked before use
      let blocked: RuleHostResult | undefined;
      const approvals: RuleHostResult[] = [];

      for (const impl of activeImpls) {
        try {
          const result = impl.evaluate(input);

          if (!result.matched) {
            continue;
          }

          if (result.decision === 'block') {
            blocked = result;
            break; // Short-circuit on block
          }

          if (result.decision === 'requireApproval') {
            approvals.push(result);
          }
          // 'allow' is implicit — no action needed
        } catch (evalError: unknown) {
          // Individual implementation error: log and continue (D-08)
          this.logger.warn?.(
            `[RuleHost] Implementation ${impl.implId} evaluation failed: ${String(evalError)}`
          );
        }
      }

      if (blocked) {
        return blocked;
      }

      if (approvals.length > 0) {
        // Merge multiple requireApproval results
        return {
          decision: 'requireApproval',
          matched: true,
          reason: approvals.map((a) => a.reason).join('; '),
          diagnostics: approvals.reduce<Record<string, unknown>>(
            (acc, a) => ({ ...acc, ...a.diagnostics }),
            {}
          ),
        };
      }

      // All implementations returned allow or matched=false — no opinion
      return undefined;
    } catch (hostError: unknown) {
      // Conservative degradation: log and return undefined (D-08)
      this.logger.warn?.(
        `[RuleHost] Host evaluation failed, degrading conservatively: ${String(hostError)}`
      );
      return undefined;
    }
  }

  /**
   * Load active code implementations from the ledger.
   * Filters by type=code and lifecycleState=active, then attempts to
   * compile each implementation's code asset via node:vm.
   */
  private _loadActiveCodeImplementations(): LoadedImplementation[] {
    try {
      const activeAllTypes = listImplementationsByLifecycleState(
        this.stateDir,
        'active'
      );

      // Filter to code-type implementations only
      const codeImpls = activeAllTypes.filter((impl) => impl.type === 'code');

      if (codeImpls.length === 0) {
        return [];
      }

      const loaded: LoadedImplementation[] = [];

      for (const impl of codeImpls) {
        try {
          const loadedImpl = this._loadSingleImplementation(impl);
          if (loadedImpl) {
            loaded.push(loadedImpl);
          }
        } catch (loadError: unknown) {
          // Individual load failure: log and skip
          this.logger.warn?.(
            `[RuleHost] Failed to load implementation ${impl.id}: ${String(loadError)}`
          );
        }
      }

      return loaded;
    } catch (ledgerError: unknown) {
      // Ledger access failure: log and return empty
      this.logger.warn?.(
        `[RuleHost] Failed to access ledger: ${String(ledgerError)}`
      );
      return [];
    }
  }

  /**
   * Load and compile a single implementation from its code asset path.
   *
   * The implementation file is expected to export:
   *   - meta: { name, version, ruleId, coversCondition }
   *   - evaluate(input: RuleHostInput): RuleHostResult
   *
   * Uses the shared isolated runtime loader so candidate code does not execute
   * in the host global realm.
   */
  private _loadSingleImplementation(
    impl: Implementation
  ): LoadedImplementation | null {
    let sourceCode = loadEntrySource(this.stateDir, impl.id);
    if (!sourceCode) {
      const assetPath = impl.path;
      if (!assetPath || !fs.existsSync(assetPath)) {
        return null;
      }

      try {
        sourceCode = fs.readFileSync(assetPath, 'utf-8');
      } catch {
        return null;
      }
    }

    try {
      const moduleExports = loadRuleImplementationModule(sourceCode, impl.id);

      if (!moduleExports || typeof moduleExports.evaluate !== 'function') {
        return null;
      }

      const fallbackMeta: RuleHostMeta = {
        name: impl.id,
        version: impl.version,
        ruleId: impl.ruleId,
        coversCondition: impl.coversCondition,
      };
      const meta: RuleHostMeta =
        moduleExports.meta && typeof moduleExports.meta === 'object'
          ? (moduleExports.meta as RuleHostMeta)
          : fallbackMeta;

      // Return a loaded implementation that wraps the compiled evaluate
      // with the actual helpers from the input at evaluation time
      /* eslint-disable no-unused-vars -- Reason: type cast params intentionally unused - they're just type annotations, actual function uses different params */
      const rawEvaluate = moduleExports.evaluate as (
        _input: RuleHostInput,
        _helpers: ReturnType<typeof createRuleHostHelpers>
      ) => RuleHostResult;
      /* eslint-enable no-unused-vars */

      return {
        implId: impl.id,
        ruleId: impl.ruleId,
        meta,
        evaluate: (input: RuleHostInput): RuleHostResult => {
          const frozenHelpers = createRuleHostHelpers(input);
          return rawEvaluate(input, frozenHelpers);
        },
      };
    } catch (compileError: unknown) {
      // Compilation failure: log and skip
      this.logger.warn?.(
        `[RuleHost] Failed to compile implementation ${impl.id}: ${String(compileError)}`
      );
      return null;
    }
  }
}
