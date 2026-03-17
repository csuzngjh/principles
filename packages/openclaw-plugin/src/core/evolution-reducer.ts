import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { PathResolver } from './path-resolver.js';
import type {
  EvolutionLoopEvent,
  Principle,
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
  }

  emit(event: EvolutionLoopEvent): void {
    this.emitSync(event);
  }

  emitSync(event: EvolutionLoopEvent): void {
    withLock(this.lockTargetPath, () => {
      fs.appendFileSync(this.streamPath, `${JSON.stringify(event)}\n`, 'utf8');
    });
    this.applyEvent(event);
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
      } catch {
        // skip malformed legacy lines
      }
    }
    this.isReplaying = false;
  }

  private applyEvent(event: EvolutionLoopEvent): void {
    this.memoryEvents.push(event);

    if (event.type === 'pain_detected') {
      this.updateFailureStreakFromPain(event);
      if (!this.isReplaying) {
        this.onPainDetected(event);
      }
      return;
    }

    if (event.type === 'candidate_created') {
      const data = event.data as any;
      const existing = this.principles.get(data.principleId);
      if (existing) {
        existing.status = 'candidate';
        return;
      }

      const principle: Principle = {
        id: String(data.principleId),
        version: 1,
        text: `When ${String(data.trigger ?? 'unknown')}, then ${String(data.action ?? 'act cautiously')}.`,
        source: {
          painId: String(data.painId ?? `pain_${Date.now()}`),
          painType: 'tool_failure',
          timestamp: event.ts,
        },
        trigger: String(data.trigger ?? 'unknown'),
        action: String(data.action ?? 'act cautiously'),
        contextTags: [String(data.source ?? 'general')],
        validation: { successCount: 0, conflictCount: 0 },
        status: 'candidate',
        feedbackScore: 0,
        usageCount: 0,
        createdAt: event.ts,
      };
      this.principles.set(principle.id, principle);
      return;
    }

    if (event.type === 'principle_promoted') {
      const data = event.data as any;
      const p = this.principles.get(data.principleId);
      if (!p) return;
      p.status = data.to;
      if (data.to === 'active') {
        p.activatedAt = event.ts;
      }
      this.lastPromotedAt = event.ts;
      return;
    }

    if (event.type === 'principle_deprecated') {
      const data = event.data as any;
      const p = this.principles.get(data.principleId);
      if (!p) return;
      p.status = 'deprecated';
      p.deprecatedAt = event.ts;
      return;
    }

    if (event.type === 'principle_rolled_back') {
      const data = event.data as any;
      const p = this.principles.get(data.principleId);
      if (p) {
        p.status = 'deprecated';
        p.deprecatedAt = event.ts;
      }
      this.persistBlacklist({
        painId: data.relatedPainId,
        pattern: data.blacklistPattern,
        reason: data.reason,
        rolledBackAt: event.ts,
      });
    }
  }

  private onPainDetected(event: EvolutionLoopEvent): void {
    const data = event.data as any;
    const trigger = String(data.reason ?? data.source ?? 'unknown trigger');
    const action = `Prevent recurrence for: ${String(data.source ?? 'unknown')}`;

    if (this.isBlacklisted(String(data.painId ?? ''), trigger)) {
      return;
    }

    const principleId = this.nextPrincipleId();
    const principle: Principle = {
      id: principleId,
      version: 1,
      text: `When ${trigger}, then ${action}.`,
      source: {
        painId: String(data.painId ?? `pain_${Date.now()}`),
        painType: (data.painType ?? 'tool_failure'),
        timestamp: event.ts,
      },
      trigger,
      action,
      contextTags: [String(data.source ?? 'general')],
      validation: { successCount: 0, conflictCount: 0 },
      status: 'candidate',
      feedbackScore: 0,
      usageCount: 0,
      createdAt: event.ts,
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
        this.emitSync({
          ts: new Date().toISOString(),
          type: 'circuit_breaker_opened',
          data: {
            taskId: key,
            painId: principle.source.painId,
            failCount: next,
            reason: 'Max retries exceeded',
            requireHuman: true,
          },
        });
      }
    }
  }

  private updateFailureStreakFromPain(event: EvolutionLoopEvent): void {
    const data = event.data as any;
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

  private persistBlacklist(entry: { painId?: string; pattern?: string; reason: string; rolledBackAt: string }): void {
    const list = this.loadBlacklist();
    list.push(entry);
    fs.writeFileSync(this.blacklistPath, JSON.stringify(list, null, 2), 'utf8');
  }

  private loadBlacklist(): Array<{ painId?: string; pattern?: string; reason: string; rolledBackAt: string }> {
    if (!fs.existsSync(this.blacklistPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(this.blacklistPath, 'utf8'));
    } catch {
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
