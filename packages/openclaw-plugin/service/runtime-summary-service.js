import * as fs from 'fs';
import * as path from 'path';
import { readPainFlagData } from '../core/pain.js';
import { resolvePdPath } from '../core/paths.js';
import { listSessions } from '../core/session-tracker.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { evaluatePhase3Inputs } from './phase3-input-filter.js';
const MAX_SOURCE_EVENTS = 5;
const LEGACY_TRUST_REWARD_POLICY = 'frozen_all_positive';
const GFI_PARTIAL_WARNING = 'GFI source attribution remains partial in Phase 2b because only the empathy slice is source-attributed; most non-empathy friction still lacks full per-source attribution.';
const DAILY_GFI_WARNING = 'daily-stats.gfi is not authoritative in Phase 1 and is used only as a fallback reference.';
const EVENT_BUFFER_WARNING = 'Live event buffer is unavailable in this context, so status may lag until events.jsonl flushes.';
function pushWarning(warnings, message) {
    if (!warnings.includes(message)) {
        warnings.push(message);
    }
}
export class RuntimeSummaryService {
    static getSummary(workspaceDir, options) {
        const generatedAt = new Date().toISOString();
        const warnings = [];
        const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
        const sessions = this.mergeSessionSnapshots(this.readSessions(wctx.resolve('SESSION_DIR'), warnings), workspaceDir);
        const selectedSession = this.selectSession(sessions, options?.sessionId ?? null);
        const selectedSessionId = selectedSession.session?.sessionId ?? null;
        const persistedEvents = this.readEvents(path.join(wctx.stateDir, 'logs', 'events.jsonl'), warnings);
        const hasBufferedEventAccess = typeof wctx.eventLog.getBufferedEvents === 'function';
        const bufferedEvents = hasBufferedEventAccess
            ? wctx.eventLog.getBufferedEvents()
            : [];
        const events = this.mergeEvents(persistedEvents, bufferedEvents);
        const dailyStats = this.readJsonFile(path.join(wctx.stateDir, 'logs', 'daily-stats.json'), warnings, false);
        const today = generatedAt.slice(0, 10);
        const dailyGfiPeak = dailyStats?.[today]?.gfi?.peak;
        const gfiCurrent = selectedSession.session && Number.isFinite(selectedSession.session.currentGfi)
            ? Number(selectedSession.session.currentGfi)
            : null;
        const sessionPeak = selectedSession.session && Number.isFinite(selectedSession.session.dailyGfiPeak)
            ? Number(selectedSession.session.dailyGfiPeak)
            : null;
        const gfiPeak = sessionPeak ?? (Number.isFinite(dailyGfiPeak) ? Number(dailyGfiPeak) : null);
        pushWarning(warnings, GFI_PARTIAL_WARNING);
        if (sessionPeak === null && Number.isFinite(dailyGfiPeak)) {
            pushWarning(warnings, DAILY_GFI_WARNING);
        }
        if (!hasBufferedEventAccess) {
            pushWarning(warnings, EVENT_BUFFER_WARNING);
        }
        if (!selectedSession.session) {
            pushWarning(warnings, 'No persisted session state was found; current session GFI is unavailable.');
        }
        const queue = this.readJsonFile(wctx.resolve('EVOLUTION_QUEUE'), warnings, false);
        const directive = this.readJsonFile(wctx.resolve('EVOLUTION_DIRECTIVE'), warnings, false);
        const queueStats = this.buildQueueStats(queue);
        const directiveSummary = this.buildDirectiveSummary(queue, directive, generatedAt, warnings);
        const painFlag = readPainFlagData(workspaceDir);
        const painCandidates = this.readJsonFile(wctx.resolve('PAIN_CANDIDATES'), warnings, false);
        const legacyTrust = this.readLegacyTrust(resolvePdPath(workspaceDir, 'AGENT_SCORECARD'), wctx, warnings);
        const phase3Inputs = evaluatePhase3Inputs(queue ?? [], legacyTrust.phase3Input);
        const lastPainSignal = this.findLastPainSignal(events, selectedSessionId);
        const gfiSources = this.buildGfiSources(events, selectedSessionId);
        const gateStats = this.buildGateStats(events, selectedSessionId, warnings);
        return {
            gfi: {
                current: gfiCurrent,
                peak: gfiPeak,
                sources: gfiSources,
                dataQuality: 'partial',
            },
            legacyTrust: legacyTrust.summary,
            evolution: {
                queue: queueStats,
                directive: directiveSummary,
                dataQuality: this.resolveEvolutionDataQuality(queue),
            },
            phase3: {
                queueTruthReady: phase3Inputs.queueTruthReady,
                trustInputReady: phase3Inputs.trustInputReady,
                phase3ShadowEligible: phase3Inputs.phase3ShadowEligible,
                evolutionEligible: phase3Inputs.evolution.eligible.length,
                evolutionRejected: phase3Inputs.evolution.rejected.length,
                evolutionRejectedReasons: phase3Inputs.evolution.rejected.flatMap((entry) => entry.reasons),
                trustRejectedReasons: phase3Inputs.trust.rejectedReasons,
            },
            pain: {
                activeFlag: Object.keys(painFlag).length > 0,
                activeFlagSource: painFlag.source || null,
                candidates: painCandidates?.candidates && typeof painCandidates.candidates === 'object'
                    ? Object.keys(painCandidates.candidates).length
                    : null,
                lastSignal: lastPainSignal,
            },
            gate: gateStats,
            metadata: {
                generatedAt,
                workspaceDir,
                sessionId: selectedSessionId,
                selectedSessionReason: selectedSession.reason,
                warnings,
            },
        };
    }
    static readSessions(sessionDir, warnings) {
        if (!fs.existsSync(sessionDir)) {
            pushWarning(warnings, 'No persisted session directory exists yet; session-scoped runtime state is unavailable.');
            return [];
        }
        const sessions = [];
        for (const file of fs.readdirSync(sessionDir)) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const raw = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed?.sessionId) {
                    sessions.push(parsed);
                }
            }
            catch {
                pushWarning(warnings, `Failed to parse session snapshot: ${file}`);
            }
        }
        return sessions.sort((a, b) => this.resolveSessionSortTime(b) - this.resolveSessionSortTime(a));
    }
    static selectSession(sessions, explicitSessionId) {
        if (explicitSessionId) {
            const explicit = sessions.find((session) => session.sessionId === explicitSessionId) ?? null;
            return { session: explicit, reason: explicit ? 'explicit' : 'none' };
        }
        if (sessions.length === 0) {
            return { session: null, reason: 'none' };
        }
        return { session: sessions[0], reason: 'latest_active' };
    }
    static mergeSessionSnapshots(persistedSessions, workspaceDir) {
        const merged = new Map();
        for (const session of persistedSessions) {
            merged.set(session.sessionId, { ...session });
        }
        for (const live of listSessions(workspaceDir)) {
            const persisted = merged.get(live.sessionId);
            merged.set(live.sessionId, {
                sessionId: live.sessionId,
                currentGfi: Number.isFinite(live.currentGfi) ? Number(live.currentGfi) : persisted?.currentGfi,
                dailyGfiPeak: Number.isFinite(live.dailyGfiPeak) ? Number(live.dailyGfiPeak) : persisted?.dailyGfiPeak,
                lastActivityAt: Number.isFinite(live.lastActivityAt) ? Number(live.lastActivityAt) : persisted?.lastActivityAt,
                lastControlActivityAt: Number.isFinite(live.lastControlActivityAt)
                    ? Number(live.lastControlActivityAt)
                    : persisted?.lastControlActivityAt,
            });
        }
        return [...merged.values()].sort((a, b) => this.resolveSessionSortTime(b) - this.resolveSessionSortTime(a));
    }
    static buildQueueStats(queue) {
        const stats = { pending: 0, inProgress: 0, completed: 0 };
        if (!queue)
            return stats;
        for (const item of queue) {
            if (item?.status === 'completed') {
                stats.completed++;
            }
            else if (item?.status === 'in_progress') {
                stats.inProgress++;
            }
            else {
                stats.pending++;
            }
        }
        return stats;
    }
    static buildDirectiveSummary(queue, directive, generatedAt, warnings) {
        const inProgressTask = this.selectInProgressTask(queue);
        if (!inProgressTask) {
            if (directive) {
                this.warnOnLegacyDirectiveMismatch(directive, null, warnings);
            }
            return {
                exists: false,
                active: null,
                ageSeconds: null,
                taskPreview: null,
            };
        }
        const derivedTaskPreview = this.buildDirectiveTaskPreview(inProgressTask);
        const timestampMs = this.resolveDirectiveTimestamp(inProgressTask);
        const ageSeconds = Number.isFinite(timestampMs)
            ? Math.max(0, Math.floor((new Date(generatedAt).getTime() - timestampMs) / 1000))
            : null;
        if (directive) {
            this.warnOnLegacyDirectiveMismatch(directive, {
                active: true,
                taskPreview: derivedTaskPreview,
                taskId: inProgressTask.taskId ?? inProgressTask.id ?? null,
            }, warnings);
        }
        return {
            exists: true,
            active: true,
            ageSeconds,
            taskPreview: derivedTaskPreview,
        };
    }
    static readLegacyTrust(scorecardPath, wctx, warnings) {
        const scorecard = this.readJsonFile(scorecardPath, warnings, false);
        const score = Number.isFinite(scorecard?.trust_score) ? Number(scorecard?.trust_score) : null;
        const rawFrozen = scorecard?.frozen === true ? true : false;
        const settings = wctx.config.get('trust');
        const stageThresholds = settings?.stages ?? {
            stage_1_observer: 30,
            stage_2_editor: 60,
            stage_3_developer: 80,
        };
        let stage = null;
        if (score !== null) {
            if (score < (stageThresholds.stage_1_observer ?? 30)) {
                stage = 1;
            }
            else if (score < (stageThresholds.stage_2_editor ?? 60)) {
                stage = 2;
            }
            else if (score < (stageThresholds.stage_3_developer ?? 80)) {
                stage = 3;
            }
            else {
                stage = 4;
            }
        }
        return {
            summary: {
                score,
                stage,
                frozen: true,
                lastUpdated: scorecard?.last_updated ?? null,
                rewardPolicy: LEGACY_TRUST_REWARD_POLICY,
            },
            phase3Input: {
                score,
                frozen: rawFrozen,
                lastUpdated: scorecard?.last_updated ?? null,
            },
        };
    }
    static readEvents(eventsPath, warnings) {
        if (!fs.existsSync(eventsPath)) {
            warnings.push('No events.jsonl file exists yet; recent pain and gate summaries are partial.');
            return [];
        }
        try {
            const raw = fs.readFileSync(eventsPath, 'utf8').trim();
            if (!raw)
                return [];
            let parseFailures = 0;
            const entries = raw
                .split('\n')
                .map((line) => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    parseFailures += 1;
                    return null;
                }
            })
                .filter((entry) => entry !== null);
            if (parseFailures > 0) {
                pushWarning(warnings, `Skipped ${parseFailures} malformed event line${parseFailures === 1 ? '' : 's'} while reading events.jsonl.`);
            }
            return entries;
        }
        catch {
            pushWarning(warnings, 'Failed to read events.jsonl; recent pain and gate summaries are partial.');
            return [];
        }
    }
    static buildGfiSources(events, sessionId) {
        const filtered = events
            .filter((entry) => {
            if (sessionId && entry.sessionId !== sessionId)
                return false;
            return (entry.type === 'pain_signal' ||
                (entry.type === 'tool_call' && entry.category === 'failure'));
        })
            .slice(-MAX_SOURCE_EVENTS)
            .reverse();
        return filtered.map((entry) => {
            if (entry.type === 'pain_signal') {
                return {
                    source: String(entry.data?.source ?? 'pain_signal'),
                    score: this.asFiniteNumber(entry.data?.score),
                    ts: entry.ts,
                    confidence: this.asFiniteNumber(entry.data?.confidence),
                    origin: typeof entry.data?.origin === 'string' ? entry.data.origin : undefined,
                };
            }
            return {
                source: `tool_failure:${String(entry.data?.toolName ?? 'unknown')}`,
                score: this.asFiniteNumber(entry.data?.gfi),
                ts: entry.ts,
            };
        });
    }
    static findLastPainSignal(events, sessionId) {
        for (let i = events.length - 1; i >= 0; i--) {
            const entry = events[i];
            if (entry.type !== 'pain_signal')
                continue;
            if (sessionId && entry.sessionId !== sessionId)
                continue;
            return {
                source: String(entry.data?.source ?? 'pain_signal'),
                ts: entry.ts ?? null,
                reason: typeof entry.data?.reason === 'string' ? entry.data.reason : null,
            };
        }
        return null;
    }
    static buildGateStats(events, sessionId, warnings) {
        const scoped = events.filter((entry) => {
            if (sessionId && entry.sessionId !== sessionId)
                return false;
            return entry.type === 'gate_block' || entry.type === 'gate_bypass';
        });
        if (scoped.length === 0) {
            pushWarning(warnings, 'Gate block counts before Phase 1 may be incomplete because older block events were not recorded to event-log.');
        }
        return {
            recentBlocks: scoped.filter((entry) => entry.type === 'gate_block').length,
            recentBypasses: scoped.filter((entry) => entry.type === 'gate_bypass').length,
            dataQuality: scoped.length > 0 ? 'authoritative' : 'partial',
        };
    }
    static resolveSessionSortTime(session) {
        return session.lastControlActivityAt ?? session.lastActivityAt ?? 0;
    }
    static mergeEvents(persistedEvents, bufferedEvents) {
        const merged = new Map();
        for (const entry of [...persistedEvents, ...bufferedEvents]) {
            merged.set(this.getEventDedupKey(entry), entry);
        }
        return [...merged.values()].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
    }
    static getEventDedupKey(entry) {
        const eventId = typeof entry.data?.eventId === 'string' ? entry.data.eventId : null;
        if (eventId) {
            return `${entry.type}:${entry.sessionId ?? 'none'}:${eventId}`;
        }
        return [
            entry.ts ?? 'no-ts',
            entry.type ?? 'no-type',
            entry.category ?? 'no-category',
            entry.sessionId ?? 'no-session',
            typeof entry.data?.source === 'string' ? entry.data.source : 'no-source',
            typeof entry.data?.toolName === 'string' ? entry.data.toolName : 'no-tool',
            typeof entry.data?.reason === 'string' ? entry.data.reason : 'no-reason',
        ].join('::');
    }
    static resolveEvolutionDataQuality(queue) {
        return queue ? 'authoritative' : 'partial';
    }
    static selectInProgressTask(queue) {
        if (!queue || queue.length === 0)
            return null;
        const inProgress = queue.filter((item) => item?.status === 'in_progress');
        if (inProgress.length === 0)
            return null;
        for (const item of [...inProgress].sort((a, b) => this.getQueuePriority(b) - this.getQueuePriority(a))) {
            if (this.isResolvableEvolutionTask(item)) {
                return item;
            }
        }
        return null;
    }
    static getQueuePriority(item) {
        return Number.isFinite(item.score) ? Number(item.score) : 0;
    }
    static isResolvableEvolutionTask(item) {
        const rawTask = typeof item.task === 'string' ? item.task.trim() : '';
        if (rawTask && rawTask.toLowerCase() !== 'undefined') {
            return true;
        }
        return typeof item.id === 'string' && item.id.trim().length > 0;
    }
    static resolveDirectiveTimestamp(item) {
        const candidate = item.started_at || item.enqueued_at || item.timestamp || null;
        return candidate ? new Date(candidate).getTime() : NaN;
    }
    static buildDirectiveTaskPreview(item) {
        const task = typeof item.task === 'string' ? item.task.trim() : '';
        if (task && task.toLowerCase() !== 'undefined') {
            return task.slice(0, 160);
        }
        const triggerTextPreview = typeof item.trigger_text_preview === 'string' ? item.trigger_text_preview.trim() : '';
        const taskId = typeof item.taskId === 'string' && item.taskId.trim()
            ? item.taskId.trim()
            : typeof item.id === 'string' && item.id.trim()
                ? item.id.trim()
                : 'unknown';
        const source = typeof item.source === 'string' && item.source.trim() ? item.source.trim() : 'unknown';
        const reason = typeof item.reason === 'string' && item.reason.trim() ? item.reason.trim() : 'Systemic pain detected';
        const preview = triggerTextPreview || 'N/A';
        return `Diagnose systemic pain [ID: ${taskId}]. Source: ${source}. Reason: ${reason}. Trigger text: "${preview}"`.slice(0, 160);
    }
    static warnOnLegacyDirectiveMismatch(directive, derived, warnings) {
        const legacyActive = typeof directive.active === 'boolean' ? directive.active : null;
        const legacyTask = typeof directive.task === 'string' && directive.task.trim() ? directive.task.trim().slice(0, 160) : null;
        const legacyTaskId = typeof directive.taskId === 'string' && directive.taskId.trim() ? directive.taskId.trim() : null;
        const mismatchDetails = [];
        if (derived === null) {
            if (legacyActive === true || legacyTask || legacyTaskId) {
                mismatchDetails.push('legacy directive exists but queue has no in_progress task');
            }
        }
        else {
            if (legacyActive !== null && legacyActive !== derived.active) {
                mismatchDetails.push(`active=${String(legacyActive)} vs queue=${String(derived.active)}`);
            }
            if (legacyTask && derived.taskPreview && legacyTask !== derived.taskPreview) {
                mismatchDetails.push('task text differs');
            }
            if (legacyTaskId && derived.taskId && legacyTaskId !== derived.taskId) {
                mismatchDetails.push('task id differs');
            }
        }
        if (mismatchDetails.length > 0) {
            pushWarning(warnings, `Legacy directive file disagrees with queue-derived evolution state; queue is authoritative (${mismatchDetails.join(', ')}).`);
        }
    }
    static readJsonFile(filePath, warnings, warnOnMissing) {
        if (!fs.existsSync(filePath)) {
            if (warnOnMissing) {
                pushWarning(warnings, `Missing expected file: ${path.basename(filePath)}`);
            }
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
        catch {
            pushWarning(warnings, `Failed to parse ${path.basename(filePath)}.`);
            return null;
        }
    }
    static asFiniteNumber(value) {
        return Number.isFinite(value) ? Number(value) : undefined;
    }
}
