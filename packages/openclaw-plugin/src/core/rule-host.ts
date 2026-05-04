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
import { createRuleHostHelpers } from '@principles/core/runtime-v2';
import { mergeDecisions } from '@principles/core/runtime-v2';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import type {
  RuleHostInput,
  RuleHostResult,
  RuleHostMeta,
  LoadedImplementation,
} from '@principles/core/runtime-v2';
import type { Implementation } from '../types/principle-tree-schema.js';

import type { RuleHostLogger } from '@principles/core/runtime-v2';
export type { RuleHostLogger } from '@principles/core/runtime-v2';

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
      const activeImpls = this._loadActiveCodeImplementations();
      return mergeDecisions(activeImpls, input, this.logger);
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
       
      const rawEvaluate = moduleExports.evaluate as (
        _input: RuleHostInput,
        _helpers: ReturnType<typeof createRuleHostHelpers>
      ) => RuleHostResult;
       

      return {
        implId: impl.id,
        ruleId: impl.ruleId,
        meta,
        evaluate: (input: RuleHostInput): RuleHostResult => {
          const frozenHelpers = createRuleHostHelpers(input);
          const result = rawEvaluate(input, frozenHelpers);
          // C: Enrich result with rule/principle IDs for observability
          if (result.matched && (result.decision === 'block' || result.decision === 'requireApproval')) {
            result.ruleId = impl.ruleId;
            result.principleId = meta.ruleId ?? impl.ruleId;
          }
          return result;
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
