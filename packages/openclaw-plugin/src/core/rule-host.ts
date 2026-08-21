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
import { scanLegacyRuleContractDependencies } from '@principles/core/runtime-v2';
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

type RuleHostActivationMode = 'shadow' | 'live';

interface LoadedRuleActivation extends LoadedImplementation {
  readonly activationId: string;
  readonly activationMode: RuleHostActivationMode;
}

export interface RuleHostObservedDecision extends RuleHostResult {
  readonly activationId: string;
}

/**
 * PRI-491 — A structured record of an activation that was skipped at load
 * time (flag-off v2, unsupported action, unsupported context version,
 * missing target_ref, content_json not an object, no implementationCode,
 * or duplicate active activation for target_ref).
 *
 * Unlike compile/load failures (which emit rulehost_unhealthy), skipped
 * activations have a configuration/flag reason — the RuleCode itself may be
 * valid, but the runtime chose not to execute it. Duplicate activations are
 * a special case: they ALSO emit rulehost_unhealthy (for telemetry), but are
 * surfaced in skippedActivations so the owner can observe and act (rc-9).
 *
 * ERR-002 (rc-9): every skip carries a reason + nextAction, never silent.
 */
export interface SkippedActivation {
  readonly activationId: string;
  readonly ruleId: string;
  /**
   * The mode the activation WOULD have had if loaded. Optional for cases
   * where the action itself is unrecognized (neither shadow nor live).
   */
  readonly mode?: RuleHostActivationMode;
  readonly reason: string;
  readonly nextAction: string;
}

export interface RuleHostEvaluationReport {
  readonly liveDecision: RuleHostResult | undefined;
  /**
   * P1 (ISSUE-023): live 聚合决策的溯源 — 贡献该决策的 live activation id
   * (经 ruleId 反查 implementationSources)。审计开放项: 414 次 live-mode
   * 评估无法对账到具体规则,因为 live 事件不带 activationId。
   */
  readonly liveDecisionActivationId?: string;
  readonly shadowDecisions: readonly RuleHostObservedDecision[];
  /**
   * PRI-491 — Activations that were skipped at load time. Empty when all
   * active activations loaded successfully. Each entry carries a structured
   * reason + nextAction so the owner can act without reading SQLite rows.
   */
  readonly skippedActivations: readonly SkippedActivation[];
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
  private logger: RuleHostLogger;
  private readonly workspaceDir: string | null;
  private readonly implementationSources = new Map<string, { activationId: string; artifactId: string; ruleId: string }>();
  private activationFingerprint: string | null = null;
  private cachedImplementations: readonly LoadedRuleActivation[] = [];
  /**
   * PRI-491: Cached skipped activations from the last load. Returned alongside
   * cachedImplementations on fingerprint hit so evaluateDetailed can surface
   * them without re-scanning SQLite.
   */
  private cachedSkipped: readonly SkippedActivation[] = [];
  private sqliteConnection: SqliteConnection | null = null;
  /**
   * R2-RH-002: Guards the "armed but empty" warn so it fires at most once per
   * RuleHost instance. Without this, the 0-rules path (workspaceDir missing OR
   * zero active code_tool_hook activations) returns [] silently on every
   * evaluation — an observability gap (rc-9-no-silent-fallback). The warn is
   * NOT a degradation fallback (RuleHost correctly has no opinion when empty);
   * it makes the empty-armed state visible so operators can investigate why
   * no live rules are loaded.
   */
  private emptyLoadWarnEmitted: boolean = false;

  constructor(stateDir: string, logger: RuleHostLogger = console, options?: RuleHostOptions) {
    this.stateDir = stateDir;
    this.logger = logger;
    this.workspaceDir = options?.workspaceDir ?? null;
  }

  /**
   * Update the logger sink on a cached RuleHost instance.
   *
   * WorkspaceContext caches the RuleHost singleton, but each gate call may
   * pass a request-level logger. Without this update, warn/unhealthy logs
   * would forever go to the first logger sink, making the new path hard to
   * debug.
   */
  updateLogger(logger: RuleHostLogger): void {
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
    return this.evaluateDetailed(input).liveDecision;
  }

  dispose(): void {
    this.sqliteConnection?.close();
    this.sqliteConnection = null;
    this.cachedImplementations = [];
    this.cachedSkipped = [];
    this.activationFingerprint = null;
    this.implementationSources.clear();
    this.emptyLoadWarnEmitted = false;
  }

  evaluateDetailed(input: RuleHostInput): RuleHostEvaluationReport {
    try {
      const { loaded: activeImpls, skipped } = this._loadActiveCodeImplementations(input.context?.version === 2);
      const liveImpls = activeImpls.filter((impl) => impl.activationMode === 'live');
      const shadowImpls = activeImpls.filter((impl) => impl.activationMode === 'shadow');
      const shadowDecisions: RuleHostObservedDecision[] = [];
      for (const impl of shadowImpls) {
        try {
          const result = impl.evaluate(input);
          shadowDecisions.push({ ...result, activationId: impl.activationId });
        } catch (evalError: unknown) {
          const reason = `evaluation failed: ${String(evalError)}`;
          this.logger.warn?.(`[RuleHost] Shadow implementation ${impl.implId} ${reason}`);
          const source = this.implementationSources.get(impl.implId);
          if (source) {
            this._recordUnhealthy(source.activationId, source.artifactId, source.ruleId, reason,
              'Fix the RuleCode runtime error or return shape, then re-activate the rule');
          }
        }
      }
      const liveDecision = mergeDecisions(liveImpls, input, {
        warn: this.logger.warn,
        onImplementationUnhealthy: (impl, reason) => {
          const source = this.implementationSources.get(impl.implId);
          if (!source) {
            this.logger.warn?.(`[RuleHost] No source mapping for implId=${impl.implId}, cannot record unhealthy event`);
            return;
          }
          this._recordUnhealthy(
            source.activationId,
            source.artifactId,
            source.ruleId,
            reason,
            'Fix the RuleCode runtime error or return shape, then re-activate the rule',
          );
        },
      });
      // Host-liveness correction (2026-08-21): incompatible activations stay
      // visible in skippedActivations but never synthesize a global block.
      // Only RuleCode that actually evaluated may contribute liveDecision.
      // P1 (ISSUE-023): 经 ruleId 反查 live 决策的 activationId (可审计溯源)
      let liveDecisionActivationId: string | undefined;
      if (liveDecision?.ruleId) {
        for (const source of this.implementationSources.values()) {
          if (source.ruleId === liveDecision.ruleId) {
            liveDecisionActivationId = source.activationId;
            break;
          }
        }
      }
      return { liveDecision, liveDecisionActivationId, shadowDecisions, skippedActivations: skipped };
    } catch (hostError: unknown) {
      // Conservative degradation: log and return undefined (D-08)
      this.logger.warn?.(
        `[RuleHost] Host evaluation failed, degrading conservatively: ${String(hostError)}`
      );
      return { liveDecision: undefined, shadowDecisions: [], skippedActivations: [] };
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
  private _loadActiveCodeImplementations(supportsContextV2: boolean): { loaded: LoadedRuleActivation[]; skipped: SkippedActivation[] } {
    if (!this.workspaceDir) {
      this._emitEmptyLoadWarn(
        'workspaceDir not configured — RuleHost cannot load active code_tool_hook rules',
        'Provide workspaceDir when constructing RuleHost (required for code_tool_hook channel)',
      );
      return { loaded: [], skipped: [] };
    }

    try {
      const { loaded, skipped } = this._loadFromActivationsTable(this.workspaceDir, supportsContextV2);
      if (loaded.length === 0) {
        this._emitEmptyLoadWarn(
          'armed but empty — 0 active code_tool_hook activations loaded (RuleHost will not block or require approval)',
          'If this is unexpected, run `pd activation list --channel code_tool_hook` to inspect activations, or `pd activation promote --activation-id <id> --confirm` to enable a live rule',
        );
      }
      return { loaded, skipped };
    } catch (activationError: unknown) {
      this.logger.warn?.(
        `[RuleHost] Failed to load code_tool_hook activations: ${String(activationError)}`
      );
      return { loaded: [], skipped: [] };
    }
  }

  /**
   * R2-RH-002: Emit the "armed but empty" warn at most once per RuleHost
   * instance. The warn is cached via `emptyLoadWarnEmitted` so repeated
   * evaluations (which all hit the empty path) do not spam the log.
   *
   * This is an observability signal, NOT a degradation fallback — RuleHost
   * correctly returns "no opinion" when there are no active rules. The warn
   * makes the empty state visible so operators can distinguish "RuleHost is
   * working but has no rules" from "RuleHost is broken" (rc-9-no-silent-fallback).
   */
  private _emitEmptyLoadWarn(reason: string, nextAction: string): void {
    if (this.emptyLoadWarnEmitted) return;
    this.emptyLoadWarnEmitted = true;
    this.logger.warn?.(
      `[RuleHost] ${reason}. ` +
      `nextAction=${nextAction}`
    );
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
  private _loadFromActivationsTable(workspaceDir: string, supportsContextV2: boolean): { loaded: LoadedRuleActivation[]; skipped: SkippedActivation[] } {
    const sqliteConn = this.sqliteConnection ?? new SqliteConnection(workspaceDir);
    this.sqliteConnection = sqliteConn;
    {
      const db = sqliteConn.getDb();
      const rows = db.prepare(`
        SELECT a.activation_id, a.artifact_id, a.target_ref, a.action,
               c.enforcement, c.isolation_decision_id,
               p.content_json, p.source_rule_id, p.source_principle_id
        FROM activations a
        JOIN pi_artifacts p ON a.artifact_id = p.artifact_id
        LEFT JOIN activation_control_states c ON a.activation_id = c.activation_id
        WHERE a.channel = 'code_tool_hook' AND a.deactivated_at IS NULL
        ORDER BY a.activated_at ASC
      `).all() as unknown;

      if (!Array.isArray(rows)) {
        this.logger.warn?.(
          '[RuleHost] Activations table query returned non-array, skipping'
        );
        return { loaded: [], skipped: [] };
      }

      const fingerprintParts: string[] = [supportsContextV2 ? 'context-v2' : 'context-v1'];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const record = row as Record<string, unknown>;
        fingerprintParts.push([
          record['activation_id'], record['artifact_id'], record['target_ref'], record['action'], record['enforcement'], record['isolation_decision_id'], record['content_json'], record['source_rule_id'], record['source_principle_id'],
        ].map((value) => typeof value === 'string' ? value : '').join('\u0001'));
      }
      const fingerprint = fingerprintParts.join('\u0002');
      if (fingerprint === this.activationFingerprint) {
        return { loaded: [...this.cachedImplementations], skipped: [...this.cachedSkipped] };
      }
      this.implementationSources.clear();

      // PRI-436: Group active rows by target_ref to detect duplicates.
      // At most one active activation per rule (target_ref) is allowed.
      // Duplicate groups are skipped entirely (zero executions) and emit
      // structured unhealthy evidence. Non-duplicate rows proceed to compilation.
      const rowsByTargetRef = new Map<string, Record<string, unknown>[]>();
      const skipped: SkippedActivation[] = [];
      for (const row of rows) {
        if (!row || typeof row !== 'object') {
          continue;
        }
        const r = row as Record<string, unknown>;
        const targetRef = typeof r['target_ref'] === 'string' ? r['target_ref'] : '';
        const activationId = typeof r['activation_id'] === 'string' ? r['activation_id'] : '';
        const ruleId = typeof r['source_rule_id'] === 'string' ? r['source_rule_id'] : targetRef;
        const action = typeof r['action'] === 'string' ? r['action'] : '';
        const mode: RuleHostActivationMode | undefined = action === 'code_tool_hook_live_activate'
          ? 'live'
          : action === 'code_tool_hook_shadow_activate' ? 'shadow' : undefined;
        if (r['enforcement'] === 'safety_isolated') {
          const reason = 'activation_safety_isolated';
          const nextAction = 'Recover the activation to shadow after reviewing safety evidence';
          skipped.push({ activationId, ruleId, mode, reason, nextAction });
          this.logger.warn?.(`[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`);
          continue;
        }
        if (r['enforcement'] !== 'eligible') {
          const reason = 'activation_control_state_invalid';
          const nextAction = 'Repair the activation control state before RuleCode enforcement';
          skipped.push({ activationId, ruleId, mode, reason, nextAction });
          this.logger.warn?.(`[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`);
          continue;
        }
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
      // PRI-497: duplicate activations are ALSO pushed to the `skipped` array
      // so callers (gate.ts, CLI, Console) can observe them via
      // skippedActivations — not just via rulehost_unhealthy event log.
      // Both paths are populated (rc-9-no-silent-fallback): event log for
      // telemetry, skipped array for structured caller-facing observability.
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
          for (const r of group) {
            const activationId = typeof r['activation_id'] === 'string' ? r['activation_id'] : '';
            const artifactId = typeof r['artifact_id'] === 'string' ? r['artifact_id'] : '';
            if (activationId && artifactId) {
              this._recordUnhealthy(
                activationId,
                artifactId,
                targetRef,
                `duplicate active activation for target_ref ${targetRef}`,
                'Deactivate all but one activation for this target_ref',
              );
              // PRI-497: also surface in skippedActivations for caller observability
              skipped.push({
                activationId,
                ruleId: targetRef,
                mode: 'live',
                reason: 'duplicate_active_activation',
                nextAction: 'Deactivate all but one activation for this target_ref',
              });
            }
          }
        } else {
          const row = group[0];
          if (row) validRows.push(row);
        }
      }

      const loaded: LoadedRuleActivation[] = [];

      for (const r of validRows) {
        const activationId = typeof r['activation_id'] === 'string' ? r['activation_id'] : '';
        const artifactId = typeof r['artifact_id'] === 'string' ? r['artifact_id'] : '';
        const contentJson = typeof r['content_json'] === 'string' ? r['content_json'] : '';
        const sourceRuleId = typeof r['source_rule_id'] === 'string' ? r['source_rule_id'] : null;
        // R2-RH-004: Extract source_principle_id from pi_artifacts (DB lineage field).
        // Previously this column was never SELECTed, so principleId was always
        // derived from meta.ruleId (a rule ID, not a principle ID) — violating
        // rc-6-lineage-consistency. Downstream gate.ts:135/164 recorded the
        // wrong principleId in eventLog.recordRuleEnforced().
        const sourcePrincipleId = typeof r['source_principle_id'] === 'string' ? r['source_principle_id'] : null;
        const action = typeof r['action'] === 'string' ? r['action'] : '';

        if (!activationId || !artifactId || !contentJson) {
          this.logger.warn?.(
            `[RuleHost] Activation row missing required fields, skipping`
          );
          continue;
        }
        const activationMode: RuleHostActivationMode | null = action === 'code_tool_hook_shadow_activate'
          ? 'shadow'
          : action === 'code_tool_hook_live_activate'
            ? 'live'
            : null;
        if (!activationMode) {
          const reason = `unsupported action: ${action || '(missing)'}`;
          const nextAction = 'Deactivate and recreate the activation through RuleHostWriter with action code_tool_hook_shadow_activate or code_tool_hook_live_activate';
          this.logger.warn?.(
            `[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`,
          );
          const skipRecord: SkippedActivation = {
            activationId,
            ruleId: sourceRuleId ?? artifactId,
            reason,
            nextAction,
          };
          skipped.push(skipRecord);
          this._recordSkipped(activationId, artifactId, sourceRuleId ?? artifactId, undefined, reason, nextAction);
          continue;
        }
        if (activationMode === 'shadow') {
          // PRI-489 (seed-MVP readiness): shadow activations are
          // observation-only and do NOT enter mergeDecisions (no block /
          // requireApproval). Owner approval creates a shadow activation
          // first; the only shadow -> live transition is `pd activation
          // promote --activation-id ... --confirm` (atomic action rewrite
          // in SqliteActivationStateStore.promoteActivation). Surface a
          // structured reason + nextAction so the degradation is observable
          // (rc-9-no-silent-fallback), not silent. Fires once per
          // fingerprint change (cached), not per evaluation.
          this.logger.warn?.(
            `[RuleHost] Activation ${activationId}: loaded in shadow (observation-only) mode; ` +
            'it will NOT block or require approval (shadowDecisions only). ' +
            `nextAction=run \`pd activation promote --activation-id ${activationId} --confirm\` to enable live blocking, ` +
            'or leave as-is for shadow observation.',
          );
        }
        try {
          const content = JSON.parse(contentJson) as unknown;
          if (!content || typeof content !== 'object' || Array.isArray(content)) {
            const reason = 'content_json is not a valid object';
            const nextAction = 'Regenerate the rule artifact with valid JSON content_json';
            this.logger.warn?.(
              `[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`
            );
            skipped.push({
              activationId,
              ruleId: sourceRuleId ?? artifactId,
              mode: activationMode,
              reason,
              nextAction,
            });
            this._recordSkipped(activationId, artifactId, sourceRuleId ?? artifactId, activationMode, reason, nextAction);
            continue;
          }

          const contentObj = content as Record<string, unknown>;
          if (Object.hasOwn(contentObj, 'requiresContextVersion')) {
            if (contentObj['requiresContextVersion'] !== 2) {
              const reason = `unsupported context version: ${String(contentObj['requiresContextVersion'])}`;
              const nextAction = 'Regenerate the rule artifact with requiresContextVersion: 2 or omit the field for v1';
              this.logger.warn?.(
                `[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`,
              );
              skipped.push({
                activationId,
                ruleId: typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId),
                mode: activationMode,
                reason,
                nextAction,
              });
              this._recordSkipped(activationId, artifactId, typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId), activationMode, reason, nextAction);
              continue;
            }
            if (!supportsContextV2) {
              const reason = 'suspended_by_flag: rulecode_context_v2 is disabled or unavailable';
              const nextAction = 'Enable rulecode_context_v2 with valid config, or deactivate this activation';
              this.logger.warn?.(
                `[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`,
              );
              skipped.push({
                activationId,
                ruleId: typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId),
                mode: activationMode,
                reason,
                nextAction,
              });
              this._recordSkipped(activationId, artifactId, typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId), activationMode, reason, nextAction);
              continue;
            }
          }
          const implementationCode = contentObj['implementationCode'];
          if (typeof implementationCode !== 'string' || implementationCode.length === 0) {
            const reason = 'no implementationCode in artifact';
            const nextAction = 'Regenerate the rule artifact with a non-empty implementationCode field';
            this.logger.warn?.(
              `[RuleHost] Activation ${activationId}: ${reason}, skipping. nextAction=${nextAction}`
            );
            skipped.push({
              activationId,
              ruleId: typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId),
              mode: activationMode,
              reason,
              nextAction,
            });
            this._recordSkipped(activationId, artifactId, typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId), activationMode, reason, nextAction);
            continue;
          }

          // Retired-contract backstop (2026-08-19): persisted RuleCode may
          // still reference RuleHost contract symbols this runtime removed
          // (session.recentThinking, workspace.planStatus/hasPlanFile,
          // getPlanStatus()/hasPlanFile() helpers). Executing such a rule
          // would silently change owner-approved semantics (undefined reads);
          // refuse to load it and surface exactly which symbol blocks it.
          {
            const legacyFindings = scanLegacyRuleContractDependencies([{
              activationId,
              artifactId,
              ruleId: typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId),
              principleId: sourcePrincipleId ?? undefined,
              implementationCode,
            }]);
            if (legacyFindings.length > 0) {
              const symbols = legacyFindings.map(f => f.symbol).join(', ');
              const reason = `legacy_rule_contract_dependency: ${symbols}`;
              const nextAction = 'Migrate the RuleCode off the retired contract symbols, or deactivate this activation (pd activation deactivate) and re-approve a migrated rule';
              this.logger.warn?.(
                `[RuleHost] Activation ${activationId}: ${reason}, skipping (never executed). nextAction=${nextAction}`
              );
              skipped.push({
                activationId,
                ruleId: typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId),
                mode: activationMode,
                reason,
                nextAction,
              });
              this._recordSkipped(activationId, artifactId, typeof contentObj['ruleId'] === 'string' ? contentObj['ruleId'] : (sourceRuleId ?? artifactId), activationMode, reason, nextAction);
              continue;
            }
          }

          const ruleId = typeof contentObj['ruleId'] === 'string'
            ? contentObj['ruleId']
            : (sourceRuleId ?? artifactId);

          // R2-RH-004: Extract principleId from artifact content_json.
          // Previously this field was never read, so result.principleId was
          // always set to meta.ruleId (a rule ID) — violating
          // rc-6-lineage-consistency. Precedence: contentJson.principleId
          // (artifact payload) → pi_artifacts.source_principle_id (DB lineage)
          // → meta.ruleId (rule ID fallback) → ruleId (last resort).
          const contentPrincipleId = typeof contentObj['principleId'] === 'string'
            ? contentObj['principleId']
            : null;

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
          this.implementationSources.set(implId, { activationId, artifactId, ruleId });

          loaded.push({
            implId,
            ruleId,
            meta,
            activationId,
            activationMode,
            evaluate: (input: RuleHostInput): RuleHostResult => {
              const frozenHelpers = createRuleHostHelpers(input);
              // PRI-437: Execute inside vm context with timeout boundary.
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
                // R2-RH-004: principleId precedence — contentJson.principleId
                // (artifact payload) → source_principle_id (DB lineage) →
                // meta.ruleId (rule ID fallback) → ruleId (last resort).
                // Previously this was `meta.ruleId ?? ruleId`, which always
                // resolved to a rule ID (never a principle ID) because
                // isRuleHostMeta guarantees meta.ruleId is a non-empty string.
                result.principleId = contentPrincipleId ?? sourcePrincipleId ?? meta.ruleId ?? ruleId;
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

      this.activationFingerprint = fingerprint;
      this.cachedImplementations = loaded;
      this.cachedSkipped = skipped;
      return { loaded, skipped };
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

  /**
   * PRI-491: Record a skipped activation to EventLog.
   *
   * Unlike _recordUnhealthy (compile/load failures), skipped activations have
   * a configuration/flag reason — the RuleCode itself may be valid, but the
   * runtime chose not to execute it (flag-off v2, unsupported context version,
   * unsupported action, content_json not object, no implementationCode).
   *
   * ERR-002: degradation includes a reason and nextAction (rc-9-no-silent-fallback).
   * Failures in EventLog recording are caught and logged (never throw).
   */
  private _recordSkipped(
    activationId: string,
    artifactId: string,
    ruleId: string,
    mode: RuleHostActivationMode | undefined,
    reason: string,
    nextAction: string,
  ): void {
    try {
      const eventLog = EventLogService.get(this.stateDir);
      eventLog.recordRuleHostSkipped({
        activationId,
        artifactId,
        ruleId,
        mode,
        reason,
        nextAction,
      });
    } catch (recordError: unknown) {
      // EventLog recording must never break RuleHost evaluation
      this.logger.warn?.(
        `[RuleHost] Failed to record skipped event for activation ${activationId}: ${String(recordError)}`
      );
    }
  }
}
