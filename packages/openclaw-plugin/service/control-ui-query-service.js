import { ControlUiDatabase } from '../core/control-ui-db.js';
import { getThinkingModel, listThinkingModels } from '../core/thinking-models.js';
import { WorkspaceContext } from '../core/workspace-context.js';
/** Time window (in minutes) for querying principle events related to a sample */
const PRINCIPLE_EVENT_WINDOW_MINUTES = 10;
function parseJson(raw, fallback) {
    if (!raw)
        return fallback;
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
function roundRate(numerator, denominator) {
    if (!denominator)
        return 0;
    return Number((numerator / denominator).toFixed(4));
}
function clampPageSize(input) {
    if (!Number.isFinite(input))
        return 20;
    return Math.min(100, Math.max(1, Number(input)));
}
function summarizeRecommendation(model) {
    if (model.hits === 0)
        return 'archive';
    if (model.failureRate > model.successRate || model.correctionRate >= 0.35 || model.painRate >= 0.3) {
        return 'rework';
    }
    return 'reinforce';
}
export class ControlUiQueryService {
    workspaceDir;
    trajectory;
    uiDb;
    constructor(workspaceDir) {
        this.workspaceDir = workspaceDir;
        this.trajectory = WorkspaceContext.fromHookContext({ workspaceDir }).trajectory;
        this.uiDb = new ControlUiDatabase({ workspaceDir });
    }
    dispose() {
        this.uiDb.dispose();
    }
    getOverview() {
        const stats = this.trajectory.getDataStats();
        const regressionRows = this.uiDb.all('SELECT tool_name, error_type, occurrences FROM v_error_clusters ORDER BY occurrences DESC LIMIT 5');
        const failureStats = this.uiDb.get(`
      SELECT
        COALESCE(SUM(occurrences), 0) AS total_failures,
        COALESCE(SUM(CASE WHEN occurrences > 1 THEN occurrences ELSE 0 END), 0) AS repeated_failures
      FROM v_error_clusters
    `) ?? { total_failures: 0, repeated_failures: 0 };
        const correctionTotal = this.uiDb.get('SELECT COUNT(*) AS count FROM user_turns WHERE correction_detected = 1')?.count ?? 0;
        const principleEventCount = this.uiDb.get('SELECT COUNT(*) AS count FROM principle_events')?.count ?? 0;
        const gateBlockCount = this.uiDb.get('SELECT COUNT(*) AS count FROM gate_blocks')?.count ?? 0;
        const taskOutcomeCount = this.uiDb.get('SELECT COUNT(*) AS count FROM task_outcomes')?.count ?? 0;
        const sampleCounters = this.uiDb.all('SELECT review_status, total FROM v_sample_queue');
        const samplePreview = this.uiDb.all(`
      SELECT sample_id, session_id, quality_score, review_status, created_at
      FROM correction_samples
      ORDER BY created_at DESC
      LIMIT 5
    `);
        const coverageRow = this.uiDb.get(`
      SELECT
        COUNT(DISTINCT assistant_turn_id) AS thinking_turns,
        (SELECT COUNT(*) FROM assistant_turns) AS assistant_turns
      FROM thinking_model_events
    `) ?? { thinking_turns: 0, assistant_turns: 0 };
        const effectiveCount = this.uiDb.all('SELECT events, success_windows, failure_windows, pain_windows, correction_windows FROM v_thinking_model_effectiveness')
            .filter((row) => summarizeRecommendation({
            hits: Number(row.events),
            successRate: roundRate(Number(row.success_windows), Number(row.events)),
            failureRate: roundRate(Number(row.failure_windows), Number(row.events)),
            painRate: roundRate(Number(row.pain_windows), Number(row.events)),
            correctionRate: roundRate(Number(row.correction_windows), Number(row.events)),
        }) === 'reinforce').length;
        const dailyTrend = this.uiDb.all(`
      WITH thinking_daily AS (
        SELECT substr(created_at, 1, 10) AS day, COUNT(DISTINCT assistant_turn_id) AS thinking_turns
        FROM thinking_model_events
        GROUP BY substr(created_at, 1, 10)
      )
      SELECT
        dm.day AS day,
        dm.tool_calls AS tool_calls,
        dm.failures AS failures,
        dm.user_corrections AS user_corrections,
        COALESCE(td.thinking_turns, 0) AS thinking_turns
      FROM v_daily_metrics dm
      LEFT JOIN thinking_daily td ON td.day = dm.day
      ORDER BY dm.day DESC
      LIMIT 14
    `).reverse();
        const counters = Object.fromEntries(sampleCounters.map((row) => [row.review_status, Number(row.total)]));
        const activeModels = this.uiDb.get('SELECT COUNT(DISTINCT model_id) AS count FROM thinking_model_events')?.count ?? 0;
        return {
            workspaceDir: this.workspaceDir,
            generatedAt: new Date().toISOString(),
            dataFreshness: stats.lastIngestAt,
            dataSource: 'trajectory_db_analytics',
            runtimeControlPlaneSource: 'pd_evolution_status',
            summary: {
                repeatErrorRate: roundRate(Number(failureStats.repeated_failures), Number(failureStats.total_failures)),
                userCorrectionRate: roundRate(correctionTotal, stats.userTurns),
                pendingSamples: stats.pendingSamples,
                approvedSamples: stats.approvedSamples,
                thinkingCoverageRate: roundRate(coverageRow.thinking_turns, coverageRow.assistant_turns),
                painEvents: stats.painEvents,
                principleEventCount,
                gateBlocks: Number(gateBlockCount),
                taskOutcomes: Number(taskOutcomeCount),
            },
            dailyTrend: dailyTrend.map((row) => ({
                day: row.day,
                toolCalls: Number(row.tool_calls),
                failures: Number(row.failures),
                userCorrections: Number(row.user_corrections),
                thinkingTurns: Number(row.thinking_turns),
            })),
            topRegressions: regressionRows.map((row) => ({
                toolName: row.tool_name,
                errorType: row.error_type,
                occurrences: Number(row.occurrences),
            })),
            sampleQueue: {
                counters,
                preview: samplePreview.map((row) => ({
                    sampleId: row.sample_id,
                    sessionId: row.session_id,
                    qualityScore: Number(row.quality_score),
                    reviewStatus: row.review_status,
                    createdAt: row.created_at,
                })),
            },
            thinkingSummary: {
                activeModels,
                dormantModels: Math.max(0, listThinkingModels().length - activeModels),
                effectiveModels: effectiveCount,
                coverageRate: roundRate(coverageRow.thinking_turns, coverageRow.assistant_turns),
            },
        };
    }
    listSamples(filters = {}) {
        const page = Math.max(1, Number(filters.page ?? 1));
        const pageSize = clampPageSize(filters.pageSize);
        const offset = (page - 1) * pageSize;
        const where = [];
        const params = [];
        if (filters.status && filters.status !== 'all') {
            where.push('cs.review_status = ?');
            params.push(filters.status);
        }
        if (Number.isFinite(filters.qualityMin)) {
            where.push('cs.quality_score >= ?');
            params.push(Number(filters.qualityMin));
        }
        if (filters.dateFrom) {
            where.push('cs.created_at >= ?');
            params.push(filters.dateFrom);
        }
        if (filters.dateTo) {
            where.push('cs.created_at <= ?');
            params.push(filters.dateTo);
        }
        if (filters.failureMode) {
            where.push(`
        COALESCE(
          (
            SELECT COALESCE(tc.error_type, tc.tool_name)
            FROM tool_calls tc
            WHERE tc.session_id = cs.session_id
              AND tc.outcome = 'failure'
              AND tc.created_at <= ut.created_at
            ORDER BY tc.created_at DESC
            LIMIT 1
          ),
          'unknown'
        ) = ?
      `);
            params.push(filters.failureMode);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const total = Number(this.uiDb.get(`
      SELECT COUNT(*) AS count
      FROM correction_samples cs
      JOIN user_turns ut ON ut.id = cs.user_correction_turn_id
      ${whereClause}
    `, ...params)?.count ?? 0);
        const items = this.uiDb.all(`
      SELECT
        cs.sample_id,
        cs.session_id,
        cs.review_status,
        cs.quality_score,
        cs.created_at,
        cs.updated_at,
        cs.diff_excerpt,
        COALESCE(
          (
            SELECT COALESCE(tc.error_type, tc.tool_name)
            FROM tool_calls tc
            WHERE tc.session_id = cs.session_id
              AND tc.outcome = 'failure'
              AND tc.created_at <= ut.created_at
            ORDER BY tc.created_at DESC
            LIMIT 1
          ),
          'unknown'
        ) AS failure_mode,
        (
          SELECT COUNT(*)
          FROM thinking_model_events tme
          JOIN assistant_turns at2 ON at2.id = cs.bad_assistant_turn_id
          WHERE tme.session_id = cs.session_id
            AND tme.created_at >= at2.created_at
            AND tme.created_at <= ut.created_at
        ) AS related_thinking_count
      FROM correction_samples cs
      JOIN user_turns ut ON ut.id = cs.user_correction_turn_id
      ${whereClause}
      ORDER BY cs.created_at DESC
      LIMIT ? OFFSET ?
    `, ...params, pageSize, offset);
        const counters = this.uiDb.all(`
      SELECT review_status, COUNT(*) AS count
      FROM correction_samples
      GROUP BY review_status
    `);
        return {
            counters: Object.fromEntries(counters.map((row) => [row.review_status, Number(row.count)])),
            items: items.map((row) => ({
                sampleId: row.sample_id,
                sessionId: row.session_id,
                reviewStatus: row.review_status,
                qualityScore: Number(row.quality_score),
                failureMode: row.failure_mode,
                relatedThinkingCount: Number(row.related_thinking_count),
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                diffExcerpt: row.diff_excerpt,
            })),
            pagination: {
                page,
                pageSize,
                total,
                totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
            },
        };
    }
    getSampleDetail(sampleId) {
        const row = this.uiDb.get(`
      SELECT
        cs.sample_id,
        cs.session_id,
        cs.review_status,
        cs.quality_score,
        cs.created_at,
        cs.updated_at,
        cs.recovery_tool_span_json,
        cs.principle_ids_json,
        at.id AS bad_turn_id,
        at.raw_text AS bad_raw_text,
        at.blob_ref AS bad_blob_ref,
        at.sanitized_text AS bad_sanitized_text,
        at.created_at AS bad_created_at,
        ut.id AS user_turn_id,
        ut.raw_text AS user_raw_text,
        ut.blob_ref AS user_blob_ref,
        ut.correction_cue AS user_correction_cue,
        ut.created_at AS user_created_at
      FROM correction_samples cs
      JOIN assistant_turns at ON at.id = cs.bad_assistant_turn_id
      JOIN user_turns ut ON ut.id = cs.user_correction_turn_id
      WHERE cs.sample_id = ?
    `, sampleId);
        if (!row)
            return null;
        const reviewHistory = this.uiDb.all(`
      SELECT review_status, note, created_at
      FROM sample_reviews
      WHERE sample_id = ?
      ORDER BY created_at DESC
    `, sampleId);
        const relatedThinkingHits = this.uiDb.all(`
      SELECT id, model_id, matched_pattern, scenario_json, created_at, trigger_excerpt
      FROM thinking_model_events
      WHERE session_id = ?
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT 20
    `, row.session_id, row.bad_created_at, row.user_created_at);
        const relatedPrinciples = this.uiDb.all(`
      SELECT principle_id, event_type, created_at
      FROM principle_events
      WHERE created_at >= ?
        AND created_at <= datetime(?, '+' || ? || ' minutes')
      ORDER BY created_at DESC
      LIMIT 20
    `, row.bad_created_at, row.user_created_at, PRINCIPLE_EVENT_WINDOW_MINUTES);
        const seededPrincipleIds = parseJson(row.principle_ids_json, []).map((principleId) => ({
            principleId,
            eventType: 'seeded_from_sample',
            createdAt: row.created_at,
        }));
        return {
            sampleId: row.sample_id,
            sessionId: row.session_id,
            reviewStatus: row.review_status,
            qualityScore: Number(row.quality_score),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            badAttempt: {
                assistantTurnId: Number(row.bad_turn_id),
                rawText: this.uiDb.restoreRawText(row.bad_raw_text, row.bad_blob_ref),
                sanitizedText: row.bad_sanitized_text,
                createdAt: row.bad_created_at,
            },
            userCorrection: {
                userTurnId: Number(row.user_turn_id),
                rawText: this.uiDb.restoreRawText(row.user_raw_text, row.user_blob_ref),
                correctionCue: row.user_correction_cue,
                createdAt: row.user_created_at,
            },
            recoveryToolSpan: parseJson(row.recovery_tool_span_json, []),
            relatedPrinciples: [
                ...seededPrincipleIds,
                ...relatedPrinciples.map((item) => ({
                    principleId: item.principle_id,
                    eventType: item.event_type,
                    createdAt: item.created_at,
                })),
            ],
            relatedThinkingHits: relatedThinkingHits.map((item) => ({
                id: Number(item.id),
                modelId: item.model_id,
                modelName: getThinkingModel(item.model_id)?.name ?? item.model_id,
                matchedPattern: item.matched_pattern,
                scenarios: parseJson(item.scenario_json, []),
                createdAt: item.created_at,
                triggerExcerpt: item.trigger_excerpt,
            })),
            reviewHistory: reviewHistory.map((item) => ({
                reviewStatus: item.review_status,
                note: item.note,
                createdAt: item.created_at,
            })),
        };
    }
    reviewSample(sampleId, decision, note) {
        return this.trajectory.reviewCorrectionSample(sampleId, decision, note);
    }
    exportCorrections(mode) {
        return this.trajectory.exportCorrections({ mode, approvedOnly: true });
    }
    getThinkingOverview() {
        const topModels = this.loadThinkingModelSummaries();
        const knownModels = listThinkingModels();
        const activeIds = new Set(topModels.filter((model) => model.hits > 0).map((model) => model.modelId));
        const dormantModels = knownModels
            .filter((model) => !activeIds.has(model.id))
            .map((model) => ({
            modelId: model.id,
            name: model.name,
            description: model.description,
        }));
        const coverageRow = this.uiDb.get(`
      SELECT
        COUNT(DISTINCT assistant_turn_id) AS thinking_turns,
        (SELECT COUNT(*) FROM assistant_turns) AS assistant_turns
      FROM thinking_model_events
    `) ?? { thinking_turns: 0, assistant_turns: 0 };
        const coverageTrend = this.uiDb.all(`
      WITH assistant_daily AS (
        SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS assistant_turns
        FROM assistant_turns
        GROUP BY substr(created_at, 1, 10)
      ),
      thinking_daily AS (
        SELECT substr(created_at, 1, 10) AS day, COUNT(DISTINCT assistant_turn_id) AS thinking_turns
        FROM thinking_model_events
        GROUP BY substr(created_at, 1, 10)
      )
      SELECT
        assistant_daily.day AS day,
        assistant_daily.assistant_turns AS assistant_turns,
        COALESCE(thinking_daily.thinking_turns, 0) AS thinking_turns
      FROM assistant_daily
      LEFT JOIN thinking_daily ON thinking_daily.day = assistant_daily.day
      ORDER BY assistant_daily.day ASC
    `);
        const scenarioMatrix = this.uiDb.all('SELECT model_id, scenario, hits FROM v_thinking_model_scenarios ORDER BY hits DESC, model_id ASC');
        return {
            summary: {
                totalModels: knownModels.length,
                activeModels: activeIds.size,
                dormantModels: dormantModels.length,
                effectiveModels: topModels.filter((model) => model.recommendation === 'reinforce').length,
                coverageRate: roundRate(coverageRow.thinking_turns, coverageRow.assistant_turns),
            },
            topModels,
            dormantModels,
            effectiveModels: topModels.filter((model) => model.recommendation === 'reinforce'),
            scenarioMatrix: scenarioMatrix.map((row) => ({
                modelId: row.model_id,
                modelName: getThinkingModel(row.model_id)?.name ?? row.model_id,
                scenario: row.scenario,
                hits: Number(row.hits),
            })),
            coverageTrend: coverageTrend.map((row) => ({
                day: row.day,
                assistantTurns: Number(row.assistant_turns),
                thinkingTurns: Number(row.thinking_turns),
                coverageRate: roundRate(Number(row.thinking_turns), Number(row.assistant_turns)),
            })),
        };
    }
    getThinkingModelDetail(modelId) {
        if (!getThinkingModel(modelId)) {
            return null;
        }
        const summary = this.loadThinkingModelSummaries().find((item) => item.modelId === modelId) ?? {
            modelId,
            name: getThinkingModel(modelId)?.name ?? modelId,
            description: getThinkingModel(modelId)?.description ?? 'Unknown thinking model.',
            hits: 0,
            coverageRate: 0,
            successRate: 0,
            failureRate: 0,
            painRate: 0,
            correctionRate: 0,
            correctionSampleRate: 0,
            commonScenarios: [],
            recommendation: 'archive',
        };
        const usageTrend = this.uiDb.all(`
      SELECT day, hits
      FROM v_thinking_model_daily_trend
      WHERE model_id = ?
      ORDER BY day ASC
    `, modelId);
        const scenarioDistribution = this.uiDb.all(`
      SELECT scenario, hits
      FROM v_thinking_model_scenarios
      WHERE model_id = ?
      ORDER BY hits DESC, scenario ASC
    `, modelId);
        const effect = this.uiDb.get('SELECT * FROM v_thinking_model_effectiveness WHERE model_id = ?', modelId) ?? {
            events: 0,
            success_windows: 0,
            failure_windows: 0,
            pain_windows: 0,
            correction_windows: 0,
            correction_sample_windows: 0,
        };
        const recentEvents = this.uiDb.all(`
      SELECT id, created_at, matched_pattern, scenario_json, trigger_excerpt,
             tool_context_json, pain_context_json, principle_context_json
      FROM thinking_model_events
      WHERE model_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `, modelId);
        return {
            modelMeta: {
                modelId: summary.modelId,
                name: summary.name,
                description: summary.description,
                hits: summary.hits,
                coverageRate: summary.coverageRate,
                recommendation: summary.recommendation,
            },
            usageTrend: usageTrend.map((row) => ({
                day: row.day,
                hits: Number(row.hits),
            })),
            scenarioDistribution: scenarioDistribution.map((row) => ({
                scenario: row.scenario,
                hits: Number(row.hits),
            })),
            outcomeStats: {
                events: Number(effect.events),
                successRate: roundRate(Number(effect.success_windows), Number(effect.events)),
                failureRate: roundRate(Number(effect.failure_windows), Number(effect.events)),
                painRate: roundRate(Number(effect.pain_windows), Number(effect.events)),
                correctionRate: roundRate(Number(effect.correction_windows), Number(effect.events)),
                correctionSampleRate: roundRate(Number(effect.correction_sample_windows), Number(effect.events)),
            },
            recentEvents: recentEvents.map((row) => ({
                id: Number(row.id),
                createdAt: row.created_at,
                matchedPattern: row.matched_pattern,
                scenarios: parseJson(row.scenario_json, []),
                triggerExcerpt: row.trigger_excerpt,
                toolContext: parseJson(row.tool_context_json, []),
                painContext: parseJson(row.pain_context_json, []),
                principleContext: parseJson(row.principle_context_json, []),
            })),
        };
    }
    loadThinkingModelSummaries() {
        const knownModels = listThinkingModels();
        const usageRows = new Map(this.uiDb.all('SELECT model_id, hits, coverage_rate FROM v_thinking_model_usage').map((row) => [row.model_id, row]));
        const effectRows = new Map(this.uiDb.all('SELECT * FROM v_thinking_model_effectiveness').map((row) => [row.model_id, row]));
        const scenarioRows = this.uiDb.all('SELECT model_id, scenario, hits FROM v_thinking_model_scenarios ORDER BY hits DESC');
        return knownModels.map((model) => {
            const usage = usageRows.get(model.id);
            const effect = effectRows.get(model.id);
            const events = Number(effect?.events ?? usage?.hits ?? 0);
            const successRate = roundRate(Number(effect?.success_windows ?? 0), events);
            const failureRate = roundRate(Number(effect?.failure_windows ?? 0), events);
            const painRate = roundRate(Number(effect?.pain_windows ?? 0), events);
            const correctionRate = roundRate(Number(effect?.correction_windows ?? 0), events);
            const correctionSampleRate = roundRate(Number(effect?.correction_sample_windows ?? 0), events);
            return {
                modelId: model.id,
                name: model.name,
                description: model.description,
                hits: Number(usage?.hits ?? 0),
                coverageRate: Number(usage?.coverage_rate ?? 0),
                successRate,
                failureRate,
                painRate,
                correctionRate,
                correctionSampleRate,
                commonScenarios: scenarioRows
                    .filter((row) => row.model_id === model.id)
                    .slice(0, 3)
                    .map((row) => row.scenario),
                recommendation: summarizeRecommendation({
                    hits: Number(usage?.hits ?? 0),
                    successRate,
                    failureRate,
                    painRate,
                    correctionRate,
                }),
            };
        }).sort((left, right) => right.hits - left.hits || left.modelId.localeCompare(right.modelId));
    }
}
