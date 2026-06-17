/**
 * Rule Host — Constrained execution layer for active code implementations
 *
 * PURPOSE: Load active code implementations from the principle-tree ledger
 * AND from the activations table (code_tool_hook channel), execute them in a
 * constrained node:vm context, and merge their decisions.
 *
 * ARCHITECTURE:
 *   - Constructor takes stateDir to access the principle-tree ledger
 *   - Optional workspaceDir enables reading code_tool_hook activations from SQLite
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
import { SqliteConnection } from '@principles/core/runtime-v2';
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

export interface RuleHostOptions {
  /** Workspace directory for SQLite access. When provided, RuleHost also loads code_tool_hook activations from the activations table. */
  workspaceDir?: string;
}

export class RuleHost {
  private readonly stateDir: string;
  private readonly logger: RuleHostLogger;
  private readonly workspaceDir: string | null;

  constructor(stateDir: string, logger: RuleHostLogger = console, options?: RuleHostOptions) {
    this.stateDir = stateDir;
    this.logger = logger;
    this.workspaceDir = options?.workspaceDir ?? null;
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
   * Load active code implementations from the ledger AND the activations table.
   *
   * Sources (merged, deduplicated by implId):
   *   1. principle-tree-ledger.json: implementations with lifecycleState='active' and type='code'
   *   2. activations table: code_tool_hook channel activations (when workspaceDir is provided)
   *
   * This bridges the gap between RuleHostWriter (which records activation metadata in SQLite)
   * and RuleHost enforcement (which previously only read from the ledger JSON file).
   * See BUG-001 / ERR-011 / ERR-035.
   */
  private _loadActiveCodeImplementations(): LoadedImplementation[] {
    const loaded: LoadedImplementation[] = [];
    const seenImplIds = new Set<string>();

    // Source 1: principle-tree-ledger.json (existing path)
    try {
      const activeAllTypes = listImplementationsByLifecycleState(
        this.stateDir,
        'active'
      );

      // Filter to code-type implementations only
      const codeImpls = activeAllTypes.filter((impl) => impl.type === 'code');

      for (const impl of codeImpls) {
        try {
          const loadedImpl = this._loadSingleImplementation(impl);
          if (loadedImpl && !seenImplIds.has(loadedImpl.implId)) {
            loaded.push(loadedImpl);
            seenImplIds.add(loadedImpl.implId);
          }
        } catch (loadError: unknown) {
          // Individual load failure: log and skip
          this.logger.warn?.(
            `[RuleHost] Failed to load implementation ${impl.id}: ${String(loadError)}`
          );
        }
      }
    } catch (ledgerError: unknown) {
      // Ledger access failure: log and continue to activations table
      this.logger.warn?.(
        `[RuleHost] Failed to access ledger: ${String(ledgerError)}`
      );
    }

    // Source 2: activations table (code_tool_hook channel) — bridges BUG-001
    if (this.workspaceDir) {
      try {
        const activationImpls = this._loadFromActivationsTable();
        for (const impl of activationImpls) {
          if (!seenImplIds.has(impl.implId)) {
            loaded.push(impl);
            seenImplIds.add(impl.implId);
          }
        }
      } catch (activationError: unknown) {
        // Activations table access failure: log and continue with ledger-only results
        this.logger.warn?.(
          `[RuleHost] Failed to load code_tool_hook activations: ${String(activationError)}`
        );
      }
    }

    return loaded;
  }

  /**
   * Load active code implementations from the activations table (code_tool_hook channel).
   *
   * For each activation record:
   *   1. Query the pi_artifacts table for the artifact content
   *   2. Parse content_json to extract implementationCode
   *   3. Compile via loadRuleImplementationModule (same vm isolation as ledger path)
   *
   * This mirrors the PromptActivationReader pattern for SQLite access.
   */
  private _loadFromActivationsTable(): LoadedImplementation[] {
    const sqliteConn = new SqliteConnection(this.workspaceDir!);
    try {
      const db = sqliteConn.getDb();
      const rows = db.prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref,
               p.content_json, p.source_rule_id
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
      `).all() as Array<{
        activation_id: string;
        artifact_id: string;
        target_ref: string;
        content_json: string;
        source_rule_id: string | null;
      }>;

      const loaded: LoadedImplementation[] = [];

      for (const row of rows) {
        try {
          const content = JSON.parse(row.content_json) as unknown;
          if (!content || typeof content !== 'object' || Array.isArray(content)) {
            this.logger.warn?.(
              `[RuleHost] Activation ${row.activation_id}: content_json is not an object, skipping`
            );
            continue;
          }

          const contentObj = content as Record<string, unknown>;
          const implementationCode = contentObj['implementationCode'];
          if (typeof implementationCode !== 'string' || implementationCode.length === 0) {
            this.logger.warn?.(
              `[RuleHost] Activation ${row.activation_id}: no implementationCode in artifact, skipping`
            );
            continue;
          }

          const ruleId = typeof contentObj['ruleId'] === 'string'
            ? (contentObj['ruleId'] as string)
            : (row.source_rule_id ?? row.artifact_id);

          const implId = `act-impl-${row.activation_id}`;
          const moduleExports = loadRuleImplementationModule(implementationCode, implId);

          if (!moduleExports || typeof moduleExports.evaluate !== 'function') {
            this.logger.warn?.(
              `[RuleHost] Activation ${row.activation_id}: compiled module has no evaluate function, skipping`
            );
            continue;
          }

          const fallbackMeta: RuleHostMeta = {
            name: implId,
            version: '1',
            ruleId,
            coversCondition: 'all',
          };
          const meta: RuleHostMeta =
            moduleExports.meta && typeof moduleExports.meta === 'object'
              ? (moduleExports.meta as RuleHostMeta)
              : fallbackMeta;

          const rawEvaluate = moduleExports.evaluate as (
            _input: RuleHostInput,
            _helpers: ReturnType<typeof createRuleHostHelpers>
          ) => RuleHostResult;

          loaded.push({
            implId,
            ruleId,
            meta,
            evaluate: (input: RuleHostInput): RuleHostResult => {
              const frozenHelpers = createRuleHostHelpers(input);
              const result = rawEvaluate(input, frozenHelpers);
              if (result.matched && (result.decision === 'block' || result.decision === 'requireApproval')) {
                result.ruleId = ruleId;
                result.principleId = meta.ruleId ?? ruleId;
              }
              return result;
            },
          });
        } catch (loadError: unknown) {
          this.logger.warn?.(
            `[RuleHost] Failed to load activation ${row.activation_id}: ${String(loadError)}`
          );
        }
      }

      return loaded;
    } finally {
      try {
        sqliteConn.close();
      } catch {
        // best-effort cleanup
      }
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
