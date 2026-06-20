/**
 * Rule Host — Constrained execution layer for active code implementations
 *
 * PURPOSE: Load active code implementations from the SQLite activations table
 * (code_tool_hook channel), execute them in a constrained node:vm context,
 * and merge their decisions.
 *
 * ARCHITECTURE (PRI-436):
 *   - SQLite is the SOLE production source of active RuleCode
 *   - No filesystem ledger or implementation asset reads occur during evaluation
 *   - Constructor takes stateDir for API compatibility (no longer used for impl loading)
 *   - workspaceDir enables reading code_tool_hook activations from SQLite
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

import { createRuleHostHelpers } from '@principles/core/runtime-v2';
import { mergeDecisions } from '@principles/core/runtime-v2';
import { validateRuleHostResult } from '@principles/core/runtime-v2';
import { SqliteConnection } from '@principles/core/runtime-v2';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import { EventLogService } from './event-log.js';
import type {
  RuleHostInput,
  RuleHostResult,
  RuleHostMeta,
  LoadedImplementation,
} from '@principles/core/runtime-v2';

import type { RuleHostLogger } from '@principles/core/runtime-v2';
export type { RuleHostLogger } from '@principles/core/runtime-v2';

export interface RuleHostOptions {
  /** Workspace directory for SQLite access. Required for RuleHost to load active code_tool_hook activations. */
  workspaceDir?: string;
}

/**
 * Type guard for RuleHostMeta from untrusted module exports.
 * Validates all four required string fields (EP-01: no `as` bypass at trust boundary).
 */
function isRuleHostMeta(value: unknown): value is RuleHostMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    typeof v['version'] === 'string' &&
    typeof v['ruleId'] === 'string' &&
    typeof v['coversCondition'] === 'string'
  );
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
   * Load active code implementations from the SQLite activations table.
   *
   * PRI-436: SQLite is the SOLE production source. The filesystem ledger
   * (principle-tree-ledger) and implementation asset paths have been deleted.
   * No fallback, no dual-source, no deprecated adapter.
   *
   * Source: activations table (code_tool_hook channel, deactivated_at IS NULL)
   *   → JOIN pi_artifacts for content_json → extract implementationCode → compile
   */
  private _loadActiveCodeImplementations(): LoadedImplementation[] {
    if (!this.workspaceDir) {
      return [];
    }

    try {
      return this._loadFromActivationsTable(this.workspaceDir);
    } catch (activationError: unknown) {
      this.logger.warn?.(
        `[RuleHost] Failed to load code_tool_hook activations: ${String(activationError)}`
      );
      return [];
    }
  }

  /**
   * Load active code implementations from the activations table (code_tool_hook channel).
   *
   * For each activation record:
   *   1. Query the pi_artifacts table for the artifact content
   *   2. Parse content_json to extract implementationCode (treated as unknown, EP-01)
   *   3. Compile via loadRuleImplementationModule (isolated vm context)
   *
   * PRI-436 invariant: at most one active activation per rule (target_ref).
   * Duplicate active activations for the same target_ref are ALL skipped
   * (zero executions) and emit structured unhealthy evidence via logger.warn
   * (Runtime Contract Rule 9: graceful degradation includes a reason).
   *
   * All data from SQLite is treated as unknown and validated before use.
   */
  private _loadFromActivationsTable(workspaceDir: string): LoadedImplementation[] {
    const sqliteConn = new SqliteConnection(workspaceDir);
    try {
      const db = sqliteConn.getDb();
      const rows = db.prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref,
               p.content_json, p.source_rule_id
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
      `).all() as unknown;

      if (!Array.isArray(rows)) {
        this.logger.warn?.(
          '[RuleHost] Activations table query returned non-array, skipping'
        );
        return [];
      }

      // PRI-436: Group active rows by target_ref to detect duplicates.
      // At most one active activation per rule (target_ref) is allowed.
      // Duplicate groups are skipped entirely (zero executions) and emit
      // structured unhealthy evidence. Non-duplicate rows proceed to compilation.
      const rowsByTargetRef = new Map<string, Record<string, unknown>[]>();
      for (const row of rows) {
        if (!row || typeof row !== 'object') {
          continue;
        }
        const r = row as Record<string, unknown>;
        const targetRef = typeof r['target_ref'] === 'string' ? r['target_ref'] : '';
        const activationId = typeof r['activation_id'] === 'string' ? r['activation_id'] : '';
        if (!targetRef) {
          this.logger.warn?.(
            `[RuleHost] Activation ${activationId}: missing target_ref, skipping`
          );
          continue;
        }
        const group = rowsByTargetRef.get(targetRef);
        if (group) {
          group.push(r);
        } else {
          rowsByTargetRef.set(targetRef, [r]);
        }
      }

      // Emit structured unhealthy evidence for duplicate groups; collect valid (non-duplicate) rows.
      const validRows: Record<string, unknown>[] = [];
      for (const [targetRef, group] of rowsByTargetRef) {
        if (group.length > 1) {
          const activationIds: string[] = [];
          const artifactIds: string[] = [];
          for (const r of group) {
            if (typeof r['activation_id'] === 'string') activationIds.push(r['activation_id']);
            if (typeof r['artifact_id'] === 'string') artifactIds.push(r['artifact_id']);
          }
          this.logger.warn?.(
            `[RuleHost] Duplicate active activations detected — skipping all executions for this rule. ` +
            `targetRef=${targetRef} count=${group.length} ` +
            `activationIds=[${activationIds.join(', ')}] ` +
            `artifactIds=[${artifactIds.join(', ')}] ` +
            `reason=at most one active activation per rule is allowed ` +
            `nextAction=deactivate all but one activation for this target_ref`
          );
        } else {
          validRows.push(group[0]);
        }
      }

      const loaded: LoadedImplementation[] = [];

      for (const r of validRows) {
        const activationId = typeof r['activation_id'] === 'string' ? r['activation_id'] : '';
        const artifactId = typeof r['artifact_id'] === 'string' ? r['artifact_id'] : '';
        const contentJson = typeof r['content_json'] === 'string' ? r['content_json'] : '';
        const sourceRuleId = typeof r['source_rule_id'] === 'string' ? r['source_rule_id'] : null;

        if (!activationId || !artifactId || !contentJson) {
          this.logger.warn?.(
            `[RuleHost] Activation row missing required fields, skipping`
          );
          continue;
        }
        try {
          const content = JSON.parse(contentJson) as unknown;
          if (!content || typeof content !== 'object' || Array.isArray(content)) {
            this.logger.warn?.(
              `[RuleHost] Activation ${activationId}: content_json is not an object, skipping`
            );
            continue;
          }

          const contentObj = content as Record<string, unknown>;
          const implementationCode = contentObj['implementationCode'];
          if (typeof implementationCode !== 'string' || implementationCode.length === 0) {
            this.logger.warn?.(
              `[RuleHost] Activation ${activationId}: no implementationCode in artifact, skipping`
            );
            continue;
          }

          const ruleId = typeof contentObj['ruleId'] === 'string'
            ? contentObj['ruleId']
            : (sourceRuleId ?? artifactId);

          const implId = `act-impl-${activationId}`;
          const moduleExports = loadRuleImplementationModule(implementationCode, implId);

          if (!moduleExports || typeof moduleExports.callEvaluate !== 'function') {
            const reason = 'compiled module has no evaluate function';
            this.logger.warn?.(
              `[RuleHost] Activation ${activationId}: ${reason}, skipping`
            );
            this._recordUnhealthy(activationId, artifactId, ruleId, reason,
              'Fix the RuleCode to export an evaluate(input, helpers) function, then re-activate');
            continue;
          }

          const fallbackMeta: RuleHostMeta = {
            name: implId,
            version: '1',
            ruleId,
            coversCondition: 'all',
          };
          const meta: RuleHostMeta = isRuleHostMeta(moduleExports.meta)
            ? moduleExports.meta
            : fallbackMeta;

          // PRI-437: Use callEvaluate (vm-context-bounded) instead of raw evaluate.
          // callEvaluate runs the invocation INSIDE the vm context with a time
          // boundary, terminating infinite loops and excessive computation.
          const boundedCallEvaluate = moduleExports.callEvaluate;

          loaded.push({
            implId,
            ruleId,
            meta,
            evaluate: (input: RuleHostInput): RuleHostResult => {
              const frozenHelpers = createRuleHostHelpers(input);
              // PRI-437: Execute inside vm context with timeout boundary.
              // If the RuleCode infinite-loops or exceeds the time budget,
              // vm throws an error that is caught by the caller (mergeDecisions
              // try/catch), resulting in conservative degradation (undefined).
              const rawResult = boundedCallEvaluate(input, frozenHelpers);
              const validation = validateRuleHostResult(rawResult);
              if (!validation.valid) {
                throw new Error(
                  `[RuleHost] Activation ${activationId} returned invalid RuleHostResult: ${validation.errors.join('; ')}`
                );
              }
              const result = rawResult as RuleHostResult;
              if (result.matched && (result.decision === 'block' || result.decision === 'requireApproval')) {
                result.ruleId = ruleId;
                result.principleId = meta.ruleId ?? ruleId;
              }
              return result;
            },
          });
        } catch (loadError: unknown) {
          const reason = `compilation failed: ${String(loadError)}`;
          this.logger.warn?.(
            `[RuleHost] Failed to load activation ${activationId}: ${reason}`
          );
          // ruleId is declared inside the try block and may not be assigned yet;
          // fall back to sourceRuleId or artifactId (both available in scope)
          this._recordUnhealthy(activationId, artifactId,
            sourceRuleId ?? artifactId,
            reason,
            'Fix the RuleCode syntax/compilation error, then re-activate the rule');
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
   * PRI-437: Record an unhealthy activation state to EventLog.
   *
   * This makes compile/load failures visible to CLI (pd runtime health) and
   * Console API — NOT just a logger.warn that's silently skipped.
   *
   * ERR-002: degradation includes a reason and nextAction (not silent).
   * Failures in EventLog recording are caught and logged (never throw).
   */
  private _recordUnhealthy(
    activationId: string,
    artifactId: string,
    ruleId: string,
    reason: string,
    nextAction: string,
  ): void {
    try {
      // Pass undefined as logger: RuleHostLogger only has warn(), but EventLog
      // calls this.logger.error() without optional chaining. Passing the
      // RuleHostLogger directly would cause TypeError if EventLog tried to
      // log an internal error. EventLog's logger is optional; RuleHost already
      // logs its own warnings for the unhealthy event.
      const eventLog = EventLogService.get(this.stateDir);
      eventLog.recordRuleHostUnhealthy({
        activationId,
        artifactId,
        ruleId,
        reason,
        nextAction,
      });
    } catch (recordError: unknown) {
      // EventLog recording must never break RuleHost evaluation
      this.logger.warn?.(
        `[RuleHost] Failed to record unhealthy event for activation ${activationId}: ${String(recordError)}`
      );
    }
  }
}
