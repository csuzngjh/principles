/**
 * Pain Flag Detector — Dedicated pain flag detection module
 *
 * Extracts all pain flag parsing/detection logic from evolution-worker.ts into
 * a dedicated class with validated entry points, following the Phase 24 pattern.
 *
 * Design decisions:
 * - D-01: Class instantiated with workspaceDir
 * - D-02: Permissive validation (required fields only, ignore unknowns)
 * - D-03: Multi-format support: KV (primary), JSON, Key=Value fallback, Markdown
 * - D-04: Score resolution: pain_score > score > default 50
 * - D-05: Status detection via raw file content inspection (status: queued)
 */

import * as fs from 'fs';
import type { PluginLogger } from '../openclaw-sdk.js';
import { readPainFlagContract } from '../core/pain.js';
import { resolvePdPath } from '../core/paths.js';
import { EvolutionQueueStore } from './evolution-queue-store.js';
import type { RecentPainContext } from './evolution-queue-store.js';

// Re-export for backward compatibility
export type { RecentPainContext } from './evolution-queue-store.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Result of pain flag detection — returned by PainFlagDetector.detect()
 */
export interface PainFlagDetectionResult {
    exists: boolean;
    score: number | null;
    source: string | null;
    enqueued: boolean;
    skipped_reason: string | null;
    error?: string;
}

/**
 * Parsed pain values extracted from any supported format.
 */
export interface ParsedPainValues {
    score: number;
    source: string;
    reason: string;
    preview: string;
    traceId: string;
    sessionId: string;
    agentId: string;
}

// ── PainFlagDetector ─────────────────────────────────────────────────────────

export class PainFlagDetector {
    private readonly workspaceDir: string;

    constructor(workspaceDir: string) {
        this.workspaceDir = workspaceDir;
    }

    /**
     * Main entry point — detects and enqueues a pain task if warranted.
     * Handles KV (primary), JSON, Key=Value fallback, and Markdown formats.
     */
    async detect(logger?: PluginLogger): Promise<PainFlagDetectionResult> {
        const result: PainFlagDetectionResult = {
            exists: false,
            score: null,
            source: null,
            enqueued: false,
            skipped_reason: null,
        };

        try {
            const painFlagPath = resolvePdPath(this.workspaceDir, 'PAIN_FLAG');

            if (!fs.existsSync(painFlagPath)) {
                return result;
            }

            const rawPain = fs.readFileSync(painFlagPath, 'utf8');

            // Try each format in priority order: KV > JSON > Key=Value > Markdown
            const kvResult = await this.detectKV(rawPain, painFlagPath, logger);
            if (kvResult !== null) return kvResult;

            const jsonResult = await this.detectJSON(rawPain, painFlagPath, logger);
            if (jsonResult !== null) return jsonResult;

            // Key=Value and Markdown fallback (raw line parsing)
            const lines = rawPain.split('\n');
            const kvFallback = this.detectKeyValueFallback(lines);
            const mdFallback = this.detectMarkdown(lines);

            // Prefer Key=Value fallback if it found something, else Markdown
            const v = kvFallback.exists ? kvFallback : mdFallback;

            if (!v.exists) {
                return result;
            }

            return await this.enqueueFromParsedValues(painFlagPath, v, logger);

        } catch (err) {
            if (logger) logger.warn(`[PD:PainFlagDetector] Error processing pain flag: ${String(err)}`);
            result.skipped_reason = `error: ${String(err)}`;
            return result;
        }
    }

    /**
     * Extract recent pain context for attaching to sleep_reflection tasks.
     * Synchronous — reads from PAIN_FLAG file without enqueuing.
     */
    extractRecentPainContext(): RecentPainContext {
        const contract = readPainFlagContract(this.workspaceDir);
        if (contract.status !== 'valid') {
            return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
        }

        try {
            const score = parseInt(contract.data.score ?? '0', 10) || 0;
            const source = contract.data.source ?? '';
            const reason = contract.data.reason ?? '';
            const timestamp = contract.data.time ?? '';
            const sessionId = contract.data.session_id ?? '';

            if (score > 0) {
                return {
                    mostRecent: { score, source, reason, timestamp, sessionId },
                    recentPainCount: 1,
                    recentMaxPainScore: score,
                };
            }
        } catch {
            // Best effort — non-fatal
        }

        return { mostRecent: null, recentPainCount: 0, recentMaxPainScore: 0 };
    }

    // ── Format Detection (private) ─────────────────────────────────────────

    /**
     * KV format detection via readPainFlagContract.
     * Returns null if not a valid KV pain flag (file missing/empty, or JSON format).
     */
    private async detectKV(rawPain: string, painFlagPath: string, logger?: PluginLogger): Promise<PainFlagDetectionResult | null> {
        if (!rawPain.trim()) return null;

        // If it looks like JSON, skip KV path
        if (rawPain.trim().startsWith('{')) return null;

        const contract = readPainFlagContract(this.workspaceDir);

        if (contract.status === 'missing') {
            return null;
        }

        if (contract.status === 'invalid') {
            // Known invalid formats: kv, json, invalid_json — skip these
            if (contract.format === 'kv' || contract.format === 'json' || contract.format === 'invalid_json') {
                return {
                    exists: true,
                    score: null,
                    source: null,
                    enqueued: false,
                    skipped_reason: `invalid_pain_flag (${contract.missingFields.join(', ') || contract.format})`,
                };
            }
            return null;
        }

        // Valid KV format
        const score = parseInt(contract.data.score ?? '0', 10) || 0;
        const source = contract.data.source ?? 'unknown';
        const reason = contract.data.reason ?? 'Systemic pain detected';
        const preview = contract.data.trigger_text_preview ?? '';
        const isQueued = contract.data.status === 'queued';
        const traceId = contract.data.trace_id ?? '';
        const sessionId = contract.data.session_id ?? '';
        const agentId = contract.data.agent_id ?? '';

        const result: PainFlagDetectionResult = {
            exists: true,
            score,
            source,
            enqueued: isQueued,
            skipped_reason: null,
        };

        if (isQueued) {
            result.skipped_reason = 'already_queued';
            if (logger) logger.info(`[PD:PainFlagDetector] Pain flag already queued (score=${score}, source=${source})`);
            return result;
        }

        return this.enqueueFromParsedValues(painFlagPath, { score, source, reason, preview, traceId, sessionId, agentId }, logger);
    }

    /**
     * JSON format detection — handles pain skill structured output.
     * Returns null if not a valid pain JSON object.
     */
    private async detectJSON(rawPain: string, painFlagPath: string, logger?: PluginLogger): Promise<PainFlagDetectionResult | null> {
        if (!rawPain.trim().startsWith('{')) return null;

        try {
            const jsonEndIdx = rawPain.lastIndexOf('}');
            const jsonPortion = jsonEndIdx >= 0 ? rawPain.slice(0, jsonEndIdx + 1) : rawPain;
            const jsonPain = JSON.parse(jsonPortion);

            if (!this.isPainJson(jsonPain)) {
                return null;
            }

            // Score resolution: pain_score > score > default 50
            const jsonScore = typeof jsonPain.pain_score === 'number' ? jsonPain.pain_score
                : typeof jsonPain.score === 'number' ? jsonPain.score : 50;
            const jsonSource = jsonPain.source || 'human';
            const jsonReason = jsonPain.reason || jsonPain.requested_action || 'Systemic pain detected';
            const jsonPreview = (jsonPain.symptoms || []).slice(0, 2).join('; ');

            const alreadyQueued = rawPain.includes('status: queued');

            const result: PainFlagDetectionResult = {
                exists: true,
                score: jsonScore,
                source: jsonSource,
                enqueued: alreadyQueued,
                skipped_reason: null,
            };

            if (alreadyQueued) {
                result.skipped_reason = 'already_queued';
                if (logger) logger.info(`[PD:PainFlagDetector] Pain flag already queued (score=${jsonScore}, source=${jsonSource})`);
                return result;
            }

            return this.enqueueFromParsedValues(painFlagPath, {
                score: jsonScore,
                source: jsonSource,
                reason: jsonReason,
                preview: jsonPreview,
                traceId: '',
                sessionId: jsonPain.session_id || '',
                agentId: jsonPain.agent_id || '',
            }, logger);
        } catch {
            return null;
        }
    }

    /**
     * Check if a JSON object is a pain flag JSON object.
     */
    private isPainJson(json: unknown): boolean {
        return typeof json === 'object' && json !== null && (
            (json as Record<string, unknown>).pain_score !== undefined ||
            (json as Record<string, unknown>).score !== undefined ||
            (json as Record<string, unknown>).source !== undefined ||
            (json as Record<string, unknown>).reason !== undefined ||
            (json as Record<string, unknown>).session_id !== undefined ||
            (json as Record<string, unknown>).agent_id !== undefined
        );
    }

    /**
     * Key=Value fallback format parsing.
     * Handles: Source=/Reason=/Score=/Time= (and lowercase variants).
     */
    private detectKeyValueFallback(lines: string[]): ParsedPainValues & { exists: boolean } {
        let score = 0;
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let traceId = '';
        let sessionId = '';
        let agentId = '';
        let found = false;

        for (const line of lines) {
            // KV format: "key: value"
            if (line.startsWith('score:')) {
                score = parseInt(line.split(':', 2)[1].trim(), 10) || 0;
                found = true;
            }
            if (line.startsWith('source:')) {
                source = line.split(':', 2)[1].trim();
                found = true;
            }
            if (line.startsWith('reason:')) {
                reason = line.slice('reason:'.length).trim();
                found = true;
            }
            if (line.startsWith('trigger_text_preview:')) {
                preview = line.slice('trigger_text_preview:'.length).trim();
                found = true;
            }
            if (line.startsWith('trace_id:')) {
                traceId = line.split(':', 2)[1].trim();
                found = true;
            }
            if (line.startsWith('session_id:')) {
                sessionId = line.slice('session_id:'.length).trim();
                found = true;
            }
            if (line.startsWith('agent_id:')) {
                agentId = line.slice('agent_id:'.length).trim();
                found = true;
            }

            // Key=Value fallback format: "key=value" (pain skill manual output)
            if (line.startsWith('Source=') || line.startsWith('source=')) {
                source = line.includes('Source=') ? line.slice('Source='.length).trim() : line.slice('source='.length).trim();
                found = true;
            }
            if (line.startsWith('Reason=') || line.startsWith('reason=')) {
                reason = line.includes('Reason=') ? line.slice('Reason='.length).trim() : line.slice('reason='.length).trim();
                found = true;
            }
            if (line.startsWith('Score=') || line.startsWith('score=')) {
                const scoreStr = line.includes('Score=') ? line.slice('Score='.length).trim() : line.slice('score='.length).trim();
                score = parseInt(scoreStr, 10) || 0;
                found = true;
            }
            if (line.startsWith('Time=') || line.startsWith('time=')) {
                const timeStr = line.includes('Time=') ? line.slice('Time='.length).trim() : line.slice('time='.length).trim();
                preview = `Human intervention at ${timeStr}`;
                found = true;
            }
        }

        return { exists: found, score, source, reason, preview, traceId, sessionId, agentId };
    }

    /**
     * Markdown format parsing.
     * Handles: **Source**: xxx, **Reason**: xxx, **Time**: xxx
     */
    private detectMarkdown(lines: string[]): ParsedPainValues & { exists: boolean } {
        let source = 'unknown';
        let reason = 'Systemic pain detected';
        let preview = '';
        let score = 0;
        let found = false;

        for (const line of lines) {
            const mdSource = /\*\*Source\*\*:\s*(.+)/.exec(line);
            if (mdSource) {
                source = mdSource[1].trim();
                found = true;
            }
            const mdReason = /\*\*Reason\*\*:\s*(.+)/.exec(line);
            if (mdReason) {
                reason = mdReason[1].trim();
                found = true;
            }
            const mdTime = /\*\*Time\*\*:\s*(.+)/.exec(line);
            if (mdTime) {
                preview = `Human intervention at ${mdTime[1].trim()}`;
                found = true;
            }
        }

        // Markdown format has no score — default to 50 for human intervention
        if (found && score === 0 && source !== 'unknown') {
            score = 50;
        }

        return { exists: found, score, source, reason, preview, traceId: '', sessionId: '', agentId: '' };
    }

    /**
     * Enqueue a pain task from parsed values — shared by all format paths.
     */
    private async enqueueFromParsedValues(
        painFlagPath: string,
        v: ParsedPainValues,
        logger?: PluginLogger,
    ): Promise<PainFlagDetectionResult> {
        const result: PainFlagDetectionResult = {
            exists: true,
            score: v.score,
            source: v.source,
            enqueued: false,
            skipped_reason: null,
        };

        if (v.score < 30) {
            result.skipped_reason = `score_too_low (${v.score} < 30)`;
            if (logger) logger.info(`[PD:PainFlagDetector] Pain flag score too low: ${v.score} (source=${v.source})`);
            return result;
        }

        const store = new EvolutionQueueStore(this.workspaceDir);
        const now = Date.now();
        let duplicateId: string | undefined;
        let newTaskId: string | undefined;
        let effectiveTraceId: string | undefined;

        await store.update((queue) => {
            const dup = store.findRecentDuplicate(queue, v.source, v.preview, now, v.reason);
            if (dup) {
                duplicateId = dup.id;
                return queue;
            }

            newTaskId = EvolutionQueueStore.createTaskId(v.source, v.score, v.preview, v.reason, now);
            const nowIso = new Date(now).toISOString();
            effectiveTraceId = v.traceId || newTaskId;

            queue.push({
                id: newTaskId,
                taskKind: 'pain_diagnosis',
                priority: v.score >= 70 ? 'high' : v.score >= 40 ? 'medium' : 'low',
                score: v.score,
                source: v.source,
                reason: v.reason,
                trigger_text_preview: v.preview,
                timestamp: nowIso,
                enqueued_at: nowIso,
                status: 'pending',
                session_id: v.sessionId || undefined,
                agent_id: v.agentId || undefined,
                traceId: effectiveTraceId,
                retryCount: 0,
                maxRetries: 3,
            });
            return queue;
        });

        if (duplicateId) {
            fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${duplicateId}\n`, 'utf8');
            result.enqueued = true;
            result.skipped_reason = 'duplicate';
            if (logger) logger.info(`[PD:PainFlagDetector] Duplicate pain task skipped for source=${v.source}`);
            return result;
        }

        fs.appendFileSync(painFlagPath, `\nstatus: queued\ntask_id: ${newTaskId}\n`, 'utf8');
        result.enqueued = true;
        if (logger) logger.info(`[PD:PainFlagDetector] Enqueued pain task ${newTaskId} (score=${v.score})`);

        return result;
    }
}
