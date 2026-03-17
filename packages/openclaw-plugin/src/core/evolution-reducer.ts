import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { PathResolver } from './path-resolver.js';
import type {
  CandidateCreatedData,
  EvolutionLoopEvent,
  PainDetectedData,
  Principle,
  PrincipleDeprecatedData,
  PrinciplePromotedData,
  PrincipleRolledBackData,
  PrincipleStatus,
} from './evolution-types.js';

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
  private readonly memoryEvents: EvolutionLoopEvent[] = [];
  private readonly principles = new Map<string, Principle>();
  private readonly failureStreak = new Map<string, number>();
  private lastPromotedAt: string | null = null;
  private isReplaying = false;

  constructor(opts: { workspaceDir: string }) {
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
    });
    this.applyEvent(event);
    this.sweepExpiredProbation();
  }

  getEventLog(): EvolutionLoopEvent[] {
    return [...this.memoryEvents];
  }

  getCandidatePrinciples(): Principle[] {
    return this.getByStatus('candidate');
  }

  getProbationPrinciples(): Principle[] {
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
        console.warn(`[PD:EvolutionReducer] skip malformed event line: ${String(e)}`);
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
      return;
    }

    const principle: Principle = {
      id: data.principleId,
      version: 1,
      text: `When ${data.trigger}, then ${data.action}.`,
      source: {
        painId: data.painId,
        painType: 'tool_failure',
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
    const action = `Prevent recurrence for: ${String(data.source ?? 'unknown')}`;

    if (this.isBlacklisted(data.painId, trigger)) {
      return;
    }

    const principleId = this.nextPrincipleId();
    const principle: Principle = {
      id: principleId,
      version: 1,
      text: `When ${trigger}, then ${action}.`,
      source: {
        painId: data.painId,
        painType: data.painType,
        timestamp: eventTs,
      },
      trigger,
      action,
      contextTags: [data.source],
      validation: { successCount: 0, conflictCount: 0 },
      status: 'candidate',
      feedbackScore: 0,
      usageCount: 0,
      createdAt: eventTs,
    };

    this.principles.set(principleId, principle);

    this.emitSync({
      ts: new Date().toISOString(),
      type: 'candidate_created',
      data: {
        painId: principle.source.painId,
        principleId,
        trigger,
        action,
        status: 'candidate',
      },
    });

    this.promote(principleId, 'auto_from_pain');

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
            painId: principle.source.painId,
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
    for (const p of this.getProbationPrinciples()) {
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
      console.warn(`[PD:EvolutionReducer] failed to parse blacklist: ${String(e)}`);
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
