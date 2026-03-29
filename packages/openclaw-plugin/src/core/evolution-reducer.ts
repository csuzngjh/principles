import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { PathResolver } from './path-resolver.js';
import { SystemLogger } from './system-logger.js';
import { shouldIgnorePainProtocolText } from './dictionary.js';
import { TrajectoryRegistry } from './trajectory.js';
import type {
  CandidateCreatedData,
  EvolutionLoopEvent,
  PainDetectedData,
  Principle,
  PrincipleDeprecatedData,
  PrincipleDetectorSpec,
  PrincipleEvaluatorLevel,
  PrinciplePromotedData,
  PrincipleRolledBackData,
  PrincipleStatus,
} from './evolution-types.js';
import { isCompleteDetectorMetadata } from './evolution-types.js';

export interface EvolutionReducer {
  emit(event: EvolutionLoopEvent): void;
  emitSync(event: EvolutionLoopEvent): void;
  getEventLog(): EvolutionLoopEvent[];
  getCandidatePrinciples(): Principle[];
  getProbationPrinciples(): Principle[];
  getActivePrinciples(): Principle[];
  getPrincipleById(id: string): Principle | null;
  promote(principleId: string, reason?: string): void;
  deprecate(principleId: string, reason: string): void;
  rollbackPrinciple(principleId: string, reason: string): void;
  recordProbationFeedback(principleId: string, success: boolean): void;
  /**
   * Creates a new principle with generalized trigger/action from diagnostician.
   * Called after diagnostician analysis to create principle directly.
   */
  createPrincipleFromDiagnosis(params: {
    painId: string;
    painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
    triggerPattern: string;
    action: string;
    source: string;
    /** Evaluability level — defaults to 'manual_only' if omitted */
    evaluability?: PrincipleEvaluatorLevel;
    /** Detector metadata — absent or malformed = 'manual_only' evaluability */
    detectorMetadata?: PrincipleDetectorSpec;
  }): string | null;
  getStats(): {
    candidateCount: number;
    probationCount: number;
    activeCount: number;
    deprecatedCount: number;
    lastPromotedAt: string | null;
  };
}

const PROBATION_SUCCESS_THRESHOLD = 3;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const PROBATION_MAX_AGE_DAYS = 30;

export class EvolutionReducerImpl implements EvolutionReducer {
  private readonly streamPath: string;
  private readonly lockTargetPath: string;
  private readonly blacklistPath: string;
  private readonly workspaceDir: string;
  private readonly memoryEvents: EvolutionLoopEvent[] = [];
  private readonly principles = new Map<string, Principle>();
  private readonly failureStreak = new Map<string, number>();
  private lastPromotedAt: string | null = null;
  private isReplaying = false;

  constructor(opts: { workspaceDir: string }) {
    this.workspaceDir = opts.workspaceDir;
    const resolver = new PathResolver({ workspaceDir: opts.workspaceDir });
    this.streamPath = resolver.resolve('EVOLUTION_STREAM');
    this.lockTargetPath = resolver.resolve('EVOLUTION_LOCK');
    this.blacklistPath = resolver.resolve('PRINCIPLE_BLACKLIST');
    this.ensureDirs();
    this.loadFromStream();
    this.sweepExpiredProbation();
  }

  emit(event: EvolutionLoopEvent): void {
    this.emitSync(event);
  }

  emitSync(event: EvolutionLoopEvent): void {
    withLock(this.lockTargetPath, () => {
      fs.appendFileSync(this.streamPath, `${JSON.stringify(event)}\n`, 'utf8');
    }, { lockStaleMs: 15000 });
    this.applyEvent(event);
    if (event.type !== 'pain_detected') {
      try {
        TrajectoryRegistry.use(this.workspaceDir, (trajectory) => {
          trajectory.recordPrincipleEvent({
            principleId: 'principleId' in event.data && typeof event.data.principleId === 'string' ? event.data.principleId : null,
            eventType: event.type,
            payload: event.data,
            createdAt: event.ts,
          });
        });
      } catch {
        // Keep evolution loop resilient if trajectory storage is unavailable.
      }
    }
    // Performance: sweepExpiredProbation() moved to getProbationPrinciples() for lazy cleanup
  }

  getEventLog(): EvolutionLoopEvent[] {
    return [...this.memoryEvents];
  }

  getCandidatePrinciples(): Principle[] {
    return this.getByStatus('candidate');
  }

  getProbationPrinciples(): Principle[] {
    // Lazy cleanup: sweep expired probation principles on access
    this.sweepExpiredProbation();
    return this.getByStatus('probation');
  }

  getActivePrinciples(): Principle[] {
    return this.getByStatus('active');
  }

  getPrincipleById(id: string): Principle | null {
    return this.principles.get(id) ?? null;
  }

  promote(principleId: string, reason = 'manual'): void {
    const p = this.principles.get(principleId);
    if (!p || p.status === 'active' || p.status === 'deprecated') return;

    const nextStatus: PrincipleStatus = p.status === 'candidate' ? 'probation' : 'active';
    const event: EvolutionLoopEvent = {
      ts: new Date().toISOString(),
      type: 'principle_promoted',
      data: {
        principleId,
        from: p.status,
        to: nextStatus,
        reason,
        successCount: p.validation.successCount,
      },
    };
    this.emitSync(event);
  }

  deprecate(principleId: string, reason: string): void {
    const p = this.principles.get(principleId);
    if (!p || p.status === 'deprecated') return;

    this.emitSync({
      ts: new Date().toISOString(),
      type: 'principle_deprecated',
      data: {
        principleId,
        reason,
        triggeredBy: 'manual',
      },
    });
  }

  rollbackPrinciple(principleId: string, reason: string): void {
    const p = this.principles.get(principleId);
    if (!p) return;

    this.emitSync({
      ts: new Date().toISOString(),
      type: 'principle_rolled_back',
      data: {
        principleId,
        reason,
        triggeredBy: 'user_command',
        blacklistPattern: p.trigger,
        relatedPainId: p.source.painId,
      },
    });
  }

  recordProbationFeedback(principleId: string, success: boolean): void {
    const p = this.principles.get(principleId);
    if (!p || p.status !== 'probation') return;

    if (success) {
      p.validation.successCount += 1;
      p.feedbackScore += 10;
      if (p.validation.successCount >= PROBATION_SUCCESS_THRESHOLD) {
        this.promote(principleId, 'auto_threshold');
      }
      return;
    }

    p.validation.conflictCount += 1;
    if (p.validation.conflictCount >= 1) {
      this.deprecate(principleId, 'conflict_detected');
    }
  }

  /**
   * Creates a new principle with generalized trigger/action from diagnostician.
   * Called after diagnostician analysis to create principle directly (no intermediate overfitted principle).
   * @returns the new principle ID, or null if creation failed
   */
  createPrincipleFromDiagnosis(params: {
    painId: string;
    painType: 'tool_failure' | 'subagent_error' | 'user_frustration';
    triggerPattern: string;
    action: string;
    source: string;
    evaluability?: PrincipleEvaluatorLevel;
    detectorMetadata?: PrincipleDetectorSpec;
  }): string | null {
    // Check blacklist first
    if (this.isBlacklisted(params.painId, params.triggerPattern)) {
      SystemLogger.log(
        this.workspaceDir,
        'PRINCIPLE_BLACKLISTED',
        `Principle creation blocked by blacklist for trigger: "${params.triggerPattern.slice(0, 50)}..."`
      );
      return null;
    }

    // Evaluability defaults to 'manual_only' — the only way to get auto-trainable
    // is to explicitly provide valid detectorMetadata.
    // Enforce: deterministic/weak_heuristic requires complete detectorMetadata to be present.
    let evaluability: PrincipleEvaluatorLevel = params.evaluability ?? 'manual_only';
    if (evaluability !== 'manual_only' && !isCompleteDetectorMetadata(params.detectorMetadata)) {
      SystemLogger.log(
        this.workspaceDir,
        'EVALUABILITY_DOWNGRADED',
        `Principle for painId "${params.painId}" requested evaluability="${evaluability}" without detectorMetadata — downgrading to "manual_only". Provide valid detectorMetadata to enable auto-training.`
      );
      evaluability = 'manual_only';
    }

    // Check if a principle already exists for this painId
    const existingPrinciple = [...this.principles.values()].find(
      p => p.source.painId === params.painId
    );

    if (existingPrinciple) {
      // Update existing principle instead of creating new one.
      // Apply the same evaluability normalization as new creation:
      // deterministic/weak_heuristic without detectorMetadata → downgraded to manual_only.
      existingPrinciple.trigger = params.triggerPattern;
      existingPrinciple.action = params.action;
      existingPrinciple.text = `When ${params.triggerPattern}, then ${params.action}.`;
      existingPrinciple.version += 1;
      if (params.evaluability !== undefined) {
        // Apply normalization (params.evaluability may be invalid without complete metadata)
        const normalizedEvaluability = (() => {
          if (params.evaluability === 'manual_only' || isCompleteDetectorMetadata(params.detectorMetadata)) {
            return params.evaluability;
          }
          SystemLogger.log(
            this.workspaceDir,
            'EVALUABILITY_DOWNGRADED',
            `Principle update for painId "${params.painId}" requested evaluability="${params.evaluability}" without detectorMetadata — downgrading to "manual_only".`
          );
          return 'manual_only';
        })();
        existingPrinciple.evaluability = normalizedEvaluability;
      }
      // Preserve detectorMetadata unless explicitly provided in this call.
      // Accept only if complete (defense in depth — subagent should already filter).
      if (isCompleteDetectorMetadata(params.detectorMetadata)) {
        existingPrinciple.detectorMetadata = structuredClone(params.detectorMetadata);
      } else if (params.detectorMetadata !== undefined) {
        // Malformed metadata provided — clear any existing metadata
        existingPrinciple.detectorMetadata = undefined;
      }
      SystemLogger.log(
        this.workspaceDir,
        'PRINCIPLE_UPDATED',
        `Principle ${existingPrinciple.id} updated from diagnostician: "${params.triggerPattern.slice(0, 50)}..." [evaluability: ${existingPrinciple.evaluability}]`
      );
      return existingPrinciple.id;
    }

    // Create new principle with generalized content
    const principleId = this.nextPrincipleId();
    const now = new Date().toISOString();
    const principle: Principle = {
      id: principleId,
      version: 1,
      text: `When ${params.triggerPattern}, then ${params.action}.`,
      source: {
        painId: params.painId,
        painType: params.painType,
        timestamp: now,
      },
      trigger: params.triggerPattern,
      action: params.action,
      contextTags: [params.source],
      validation: { successCount: 0, conflictCount: 0 },
      status: 'candidate',
      feedbackScore: 0,
      usageCount: 0,
      createdAt: now,
      evaluability,
      detectorMetadata: isCompleteDetectorMetadata(params.detectorMetadata)
        ? structuredClone(params.detectorMetadata)
        : undefined,
    };

    this.principles.set(principleId, principle);

    this.emitSync({
      ts: now,
      type: 'candidate_created',
      data: {
        painId: principle.source.painId,
        painType: params.painType,
        principleId,
        trigger: params.triggerPattern,
        action: params.action,
        status: 'candidate',
        evaluability,
        detectorMetadata: isCompleteDetectorMetadata(params.detectorMetadata)
          ? structuredClone(params.detectorMetadata)
          : undefined,
      },
    });

    // Auto-promote since it's already generalized
    this.promote(principleId, 'diagnostician_generalized');

    SystemLogger.log(
      this.workspaceDir,
      'PRINCIPLE_CREATED',
      `Principle ${principleId} created from diagnostician: "${params.triggerPattern.slice(0, 50)}..." [evaluability: ${evaluability}]`
    );

    return principleId;
  }

  getStats(): {
    candidateCount: number;
    probationCount: number;
    activeCount: number;
    deprecatedCount: number;
    lastPromotedAt: string | null;
  } {
    return {
      candidateCount: this.getCandidatePrinciples().length,
      probationCount: this.getProbationPrinciples().length,
      activeCount: this.getActivePrinciples().length,
      deprecatedCount: this.getByStatus('deprecated').length,
      lastPromotedAt: this.lastPromotedAt,
    };
  }

  private ensureDirs(): void {
    fs.mkdirSync(path.dirname(this.streamPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.lockTargetPath), { recursive: true });
    fs.mkdirSync(path.dirname(this.blacklistPath), { recursive: true });
  }

  private loadFromStream(): void {
    if (!fs.existsSync(this.streamPath)) return;
    const raw = fs.readFileSync(this.streamPath, 'utf8').trim();
    if (!raw) return;

    this.isReplaying = true;
    for (const line of raw.split('\n')) {
      try {
        const event = JSON.parse(line) as EvolutionLoopEvent;
        this.applyEvent(event);
      } catch (e) {
        SystemLogger.log(this.workspaceDir, 'EVOLUTION_WARN', `skip malformed event line: ${String(e)}`);
      }
    }
    this.isReplaying = false;
  }

  private applyEvent(event: EvolutionLoopEvent): void {
    this.memoryEvents.push(event);

    switch (event.type) {
      case 'pain_detected':
        this.updateFailureStreakFromPain(event.data);
        if (!this.isReplaying) {
          this.onPainDetected(event.data, event.ts);
        }
        return;
      case 'candidate_created':
        this.onCandidateCreated(event.data, event.ts);
        return;
      case 'principle_promoted':
        this.onPrinciplePromoted(event.data, event.ts);
        return;
      case 'principle_deprecated':
        this.onPrincipleDeprecated(event.data, event.ts);
        return;
      case 'principle_rolled_back':
        this.onPrincipleRolledBack(event.data, event.ts);
        return;
      case 'circuit_breaker_opened':
      case 'legacy_import':
        return;
      default:
        return;
    }
  }

  private onCandidateCreated(data: CandidateCreatedData, ts: string): void {
    const existing = this.principles.get(data.principleId);
    if (existing) {
      existing.status = 'candidate';
      // Apply evaluability from event if present (supports event replay)
      if (data.evaluability) {
        existing.evaluability = data.evaluability;
      }
      if (data.detectorMetadata) {
        existing.detectorMetadata = structuredClone(data.detectorMetadata);
      }
      return;
    }

    const principle: Principle = {
      id: data.principleId,
      version: 1,
      text: `When ${data.trigger}, then ${data.action}.`,
      source: {
        painId: data.painId,
        painType: data.painType ?? 'tool_failure',
        timestamp: ts,
      },
      trigger: data.trigger,
      action: data.action,
      contextTags: [],
      validation: { successCount: 0, conflictCount: 0 },
      status: 'candidate',
      feedbackScore: 0,
      usageCount: 0,
      createdAt: ts,
      // Evaluability defaults to 'manual_only' for replayed events without the field
      evaluability: data.evaluability ?? 'manual_only',
      detectorMetadata: data.detectorMetadata
        ? structuredClone(data.detectorMetadata)
        : undefined,
    };
    this.principles.set(principle.id, principle);
  }

  private onPrinciplePromoted(data: PrinciplePromotedData, ts: string): void {
    const p = this.principles.get(data.principleId);
    if (!p) return;
    p.status = data.to;
    if (data.to === 'active') {
      p.activatedAt = ts;
    }
    this.lastPromotedAt = ts;
  }

  private onPrincipleDeprecated(data: PrincipleDeprecatedData, ts: string): void {
    const p = this.principles.get(data.principleId);
    if (!p) return;
    p.status = 'deprecated';
    p.deprecatedAt = ts;
  }

  private onPrincipleRolledBack(data: PrincipleRolledBackData, ts: string): void {
    const p = this.principles.get(data.principleId);
    if (p) {
      p.status = 'deprecated';
      p.deprecatedAt = ts;
    }
    this.persistBlacklist({
      painId: data.relatedPainId,
      pattern: data.blacklistPattern,
      reason: data.reason,
      rolledBackAt: ts,
    });
  }

  private onPainDetected(data: PainDetectedData, eventTs: string): void {
    const trigger = String(data.reason ?? data.source ?? 'unknown trigger');

    // Defense in depth: protocol/system tokens must never become principles,
    // even if a pain_detected event is emitted from a new callsite in the future.
    if (shouldIgnorePainProtocolText(trigger)) {
      return;
    }

    if (this.isBlacklisted(data.painId, trigger)) {
      return;
    }

    // NOTE: Principle creation is now deferred to diagnostician analysis.
    // The diagnostician will read conversation context, generalize the trigger pattern,
    // and create a principle via createPrincipleFromDiagnosis() after analysis.

    // Record pain for tracking purposes (but don't create principle yet)
    this.emitSync({
      ts: new Date().toISOString(),
      type: 'pain_recorded',
      data: {
        painId: data.painId,
        painType: data.painType,
        source: data.source,
        reason: data.reason,
        sessionId: data.sessionId,
        agentId: data.agentId,
      },
    });

    // Circuit breaker logic remains for subagent errors
    if (data.painType === 'subagent_error') {
      const key = String(data.taskId ?? data.source ?? 'subagent');
      const next = this.failureStreak.get(key) ?? 0;
      if (next >= CIRCUIT_BREAKER_THRESHOLD) {
        const nextRetryAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        this.emitSync({
          ts: new Date().toISOString(),
          type: 'circuit_breaker_opened',
          data: {
            taskId: key,
            painId: data.painId,
            failCount: next,
            reason: 'Max retries exceeded',
            requireHuman: true,
            nextRetryAt,
          },
        });
      }
    }
  }

  private updateFailureStreakFromPain(data: PainDetectedData): void {
    if (data.painType !== 'subagent_error') return;

    const key = String(data.taskId ?? data.source ?? 'subagent');
    const next = (this.failureStreak.get(key) ?? 0) + 1;
    this.failureStreak.set(key, next);
  }

  private nextPrincipleId(): string {
    const ids = [...this.principles.keys()]
      .map((id) => Number(id.replace(/^P_/, '')))
      .filter((n) => Number.isFinite(n));
    const next = (ids.length ? Math.max(...ids) : 0) + 1;
    return `P_${String(next).padStart(3, '0')}`;
  }

  private getByStatus(status: PrincipleStatus): Principle[] {
    return [...this.principles.values()].filter((p) => p.status === status);
  }

  private sweepExpiredProbation(): void {
    const now = Date.now();
    const maxAgeMs = PROBATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    // Use getByStatus directly to avoid infinite recursion with getProbationPrinciples()
    for (const p of this.getByStatus('probation')) {
      const age = now - new Date(p.createdAt).getTime();
      if (age > maxAgeMs) {
        this.deprecate(p.id, 'probation_expired');
      }
    }
  }

  private persistBlacklist(entry: { painId?: string; pattern?: string; reason: string; rolledBackAt: string }): void {
    const list = this.loadBlacklist();
    list.push(entry);
    fs.writeFileSync(this.blacklistPath, JSON.stringify(list, null, 2), 'utf8');
  }

  private loadBlacklist(): Array<{ painId?: string; pattern?: string; reason: string; rolledBackAt: string }> {
    if (!fs.existsSync(this.blacklistPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.blacklistPath, 'utf8')) as Array<{
        painId?: string;
        pattern?: string;
        reason: string;
        rolledBackAt: string;
      }>;
    } catch (e) {
      SystemLogger.log(this.workspaceDir, 'EVOLUTION_WARN', `failed to parse blacklist: ${String(e)}`);
      return [];
    }
  }

  private isBlacklisted(painId: string, trigger: string): boolean {
    return this.loadBlacklist().some((entry) =>
      (entry.painId && entry.painId === painId) ||
      (entry.pattern && trigger.includes(entry.pattern))
    );
  }
}

export function stableContentHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}
