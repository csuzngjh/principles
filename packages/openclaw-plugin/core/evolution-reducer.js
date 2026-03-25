import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withLock } from '../utils/file-lock.js';
import { PathResolver } from './path-resolver.js';
import { SystemLogger } from './system-logger.js';
import { shouldIgnorePainProtocolText } from './dictionary.js';
import { TrajectoryRegistry } from './trajectory.js';
const PROBATION_SUCCESS_THRESHOLD = 3;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const PROBATION_MAX_AGE_DAYS = 30;
export class EvolutionReducerImpl {
    streamPath;
    lockTargetPath;
    blacklistPath;
    workspaceDir;
    memoryEvents = [];
    principles = new Map();
    failureStreak = new Map();
    lastPromotedAt = null;
    isReplaying = false;
    constructor(opts) {
        this.workspaceDir = opts.workspaceDir;
        const resolver = new PathResolver({ workspaceDir: opts.workspaceDir });
        this.streamPath = resolver.resolve('EVOLUTION_STREAM');
        this.lockTargetPath = resolver.resolve('EVOLUTION_LOCK');
        this.blacklistPath = resolver.resolve('PRINCIPLE_BLACKLIST');
        this.ensureDirs();
        this.loadFromStream();
        this.sweepExpiredProbation();
    }
    emit(event) {
        this.emitSync(event);
    }
    emitSync(event) {
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
            }
            catch {
                // Keep evolution loop resilient if trajectory storage is unavailable.
            }
        }
        // Performance: sweepExpiredProbation() moved to getProbationPrinciples() for lazy cleanup
    }
    getEventLog() {
        return [...this.memoryEvents];
    }
    getCandidatePrinciples() {
        return this.getByStatus('candidate');
    }
    getProbationPrinciples() {
        // Lazy cleanup: sweep expired probation principles on access
        this.sweepExpiredProbation();
        return this.getByStatus('probation');
    }
    getActivePrinciples() {
        return this.getByStatus('active');
    }
    getPrincipleById(id) {
        return this.principles.get(id) ?? null;
    }
    promote(principleId, reason = 'manual') {
        const p = this.principles.get(principleId);
        if (!p || p.status === 'active' || p.status === 'deprecated')
            return;
        const nextStatus = p.status === 'candidate' ? 'probation' : 'active';
        const event = {
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
    deprecate(principleId, reason) {
        const p = this.principles.get(principleId);
        if (!p || p.status === 'deprecated')
            return;
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
    rollbackPrinciple(principleId, reason) {
        const p = this.principles.get(principleId);
        if (!p)
            return;
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
    recordProbationFeedback(principleId, success) {
        const p = this.principles.get(principleId);
        if (!p || p.status !== 'probation')
            return;
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
    createPrincipleFromDiagnosis(params) {
        // Check blacklist first
        if (this.isBlacklisted(params.painId, params.triggerPattern)) {
            SystemLogger.log(this.workspaceDir, 'PRINCIPLE_BLACKLISTED', `Principle creation blocked by blacklist for trigger: "${params.triggerPattern.slice(0, 50)}..."`);
            return null;
        }
        // Check if a principle already exists for this painId
        const existingPrinciple = [...this.principles.values()].find(p => p.source.painId === params.painId);
        if (existingPrinciple) {
            // Update existing principle instead of creating new one
            existingPrinciple.trigger = params.triggerPattern;
            existingPrinciple.action = params.action;
            existingPrinciple.text = `When ${params.triggerPattern}, then ${params.action}.`;
            existingPrinciple.version += 1;
            SystemLogger.log(this.workspaceDir, 'PRINCIPLE_UPDATED', `Principle ${existingPrinciple.id} updated from diagnostician: "${params.triggerPattern.slice(0, 50)}..."`);
            return existingPrinciple.id;
        }
        // Create new principle with generalized content
        const principleId = this.nextPrincipleId();
        const now = new Date().toISOString();
        const principle = {
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
        };
        this.principles.set(principleId, principle);
        this.emitSync({
            ts: now,
            type: 'candidate_created',
            data: {
                painId: principle.source.painId,
                principleId,
                trigger: params.triggerPattern,
                action: params.action,
                status: 'candidate',
            },
        });
        // Auto-promote since it's already generalized
        this.promote(principleId, 'diagnostician_generalized');
        SystemLogger.log(this.workspaceDir, 'PRINCIPLE_CREATED', `Principle ${principleId} created from diagnostician: "${params.triggerPattern.slice(0, 50)}..."`);
        return principleId;
    }
    getStats() {
        return {
            candidateCount: this.getCandidatePrinciples().length,
            probationCount: this.getProbationPrinciples().length,
            activeCount: this.getActivePrinciples().length,
            deprecatedCount: this.getByStatus('deprecated').length,
            lastPromotedAt: this.lastPromotedAt,
        };
    }
    ensureDirs() {
        fs.mkdirSync(path.dirname(this.streamPath), { recursive: true });
        fs.mkdirSync(path.dirname(this.lockTargetPath), { recursive: true });
        fs.mkdirSync(path.dirname(this.blacklistPath), { recursive: true });
    }
    loadFromStream() {
        if (!fs.existsSync(this.streamPath))
            return;
        const raw = fs.readFileSync(this.streamPath, 'utf8').trim();
        if (!raw)
            return;
        this.isReplaying = true;
        for (const line of raw.split('\n')) {
            try {
                const event = JSON.parse(line);
                this.applyEvent(event);
            }
            catch (e) {
                SystemLogger.log(this.workspaceDir, 'EVOLUTION_WARN', `skip malformed event line: ${String(e)}`);
            }
        }
        this.isReplaying = false;
    }
    applyEvent(event) {
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
    onCandidateCreated(data, ts) {
        const existing = this.principles.get(data.principleId);
        if (existing) {
            existing.status = 'candidate';
            return;
        }
        const principle = {
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
    onPrinciplePromoted(data, ts) {
        const p = this.principles.get(data.principleId);
        if (!p)
            return;
        p.status = data.to;
        if (data.to === 'active') {
            p.activatedAt = ts;
        }
        this.lastPromotedAt = ts;
    }
    onPrincipleDeprecated(data, ts) {
        const p = this.principles.get(data.principleId);
        if (!p)
            return;
        p.status = 'deprecated';
        p.deprecatedAt = ts;
    }
    onPrincipleRolledBack(data, ts) {
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
    onPainDetected(data, eventTs) {
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
    updateFailureStreakFromPain(data) {
        if (data.painType !== 'subagent_error')
            return;
        const key = String(data.taskId ?? data.source ?? 'subagent');
        const next = (this.failureStreak.get(key) ?? 0) + 1;
        this.failureStreak.set(key, next);
    }
    nextPrincipleId() {
        const ids = [...this.principles.keys()]
            .map((id) => Number(id.replace(/^P_/, '')))
            .filter((n) => Number.isFinite(n));
        const next = (ids.length ? Math.max(...ids) : 0) + 1;
        return `P_${String(next).padStart(3, '0')}`;
    }
    getByStatus(status) {
        return [...this.principles.values()].filter((p) => p.status === status);
    }
    sweepExpiredProbation() {
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
    persistBlacklist(entry) {
        const list = this.loadBlacklist();
        list.push(entry);
        fs.writeFileSync(this.blacklistPath, JSON.stringify(list, null, 2), 'utf8');
    }
    loadBlacklist() {
        if (!fs.existsSync(this.blacklistPath))
            return [];
        try {
            return JSON.parse(fs.readFileSync(this.blacklistPath, 'utf8'));
        }
        catch (e) {
            SystemLogger.log(this.workspaceDir, 'EVOLUTION_WARN', `failed to parse blacklist: ${String(e)}`);
            return [];
        }
    }
    isBlacklisted(painId, trigger) {
        return this.loadBlacklist().some((entry) => (entry.painId && entry.painId === painId) ||
            (entry.pattern && trigger.includes(entry.pattern)));
    }
}
export function stableContentHash(input) {
    return crypto.createHash('sha1').update(input).digest('hex');
}
