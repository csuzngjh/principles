import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  buildToolFailureObservation,
  evaluateTriage,
  evaluateTriggerController,
  resolveSourceKind,
} from '@principles/core/runtime-v2';
import type { HostEvent, HostEventResult } from '@principles/core/host';

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'write_file', 'edit_file', 'replace']);
const MAX_PREVIEW = 500;
const cooldowns = new Map<string, number>();

export interface PainEvidenceEntry {
  sourceRef: string;
  note: string;
}

export interface ProductionPainEnrichment {
  eventId?: string;
  painScore?: number;
  isRisky?: boolean;
  consecutiveErrors?: number;
  relativePath?: string;
  agentId?: string;
  errorHash?: string;
  evidence?: readonly PainEvidenceEntry[];
}

export type PainEnrichmentProvider = (event: HostEvent) => unknown | Promise<unknown>;

interface NormalizedOutcome {
  failure: boolean;
  exitCode: number;
  error?: string;
  durationMs?: number;
  params: unknown;
  result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, key)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function normalizeOutcome(event: HostEvent): NormalizedOutcome {
  const envelope = event.context.toolOutput;
  const result = field(envelope, 'result') ?? envelope;
  const errorValue = field(envelope, 'error');
  const resultExit = field(result, 'exitCode');
  const detailsExit = field(field(result, 'details'), 'exitCode');
  const exitCode = typeof resultExit === 'number' ? resultExit : typeof detailsExit === 'number' ? detailsExit : 0;
  const error = errorValue === undefined || errorValue === null || errorValue === '' ? undefined : String(errorValue);
  const durationValue = field(envelope, 'durationMs');
  return {
    failure: error !== undefined || exitCode !== 0,
    exitCode,
    ...(error ? { error: error.slice(0, MAX_PREVIEW) } : {}),
    ...(typeof durationValue === 'number' && Number.isFinite(durationValue) && durationValue >= 0 ? { durationMs: durationValue } : {}),
    params: event.context.toolInput ?? {},
    result,
  };
}

function isEvidence(value: unknown): value is readonly PainEvidenceEntry[] {
  return Array.isArray(value) && value.length <= 8 && value.every((entry) =>
    isRecord(entry) && typeof field(entry, 'sourceRef') === 'string' && String(field(entry, 'sourceRef')).trim().length > 0
      && String(field(entry, 'sourceRef')).length <= 300 && typeof field(entry, 'note') === 'string' && String(field(entry, 'note')).length <= 200);
}

function parseEnrichment(value: unknown): ProductionPainEnrichment | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const painScore = field(value, 'painScore');
  const isRisky = field(value, 'isRisky');
  const consecutiveErrors = field(value, 'consecutiveErrors');
  const evidence = field(value, 'evidence');
  const eventId = field(value, 'eventId');
  const relativePath = field(value, 'relativePath');
  const agentId = field(value, 'agentId');
  const errorHash = field(value, 'errorHash');
  if (painScore !== undefined && (typeof painScore !== 'number' || !Number.isFinite(painScore) || painScore < 0 || painScore > 100)) return null;
  if (isRisky !== undefined && typeof isRisky !== 'boolean') return null;
  if (consecutiveErrors !== undefined && (typeof consecutiveErrors !== 'number' || !Number.isInteger(consecutiveErrors) || consecutiveErrors < 0)) return null;
  for (const key of ['eventId', 'relativePath', 'agentId', 'errorHash'] as const) {
    const candidate = field(value, key);
    if (candidate !== undefined && (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.length > 500)) return null;
  }
  if (evidence !== undefined && !isEvidence(evidence)) return null;
  return {
    ...(typeof eventId === 'string' ? { eventId } : {}),
    ...(typeof painScore === 'number' ? { painScore } : {}),
    ...(typeof isRisky === 'boolean' ? { isRisky } : {}),
    ...(typeof consecutiveErrors === 'number' ? { consecutiveErrors } : {}),
    ...(typeof relativePath === 'string' ? { relativePath } : {}),
    ...(typeof agentId === 'string' ? { agentId } : {}),
    ...(typeof errorHash === 'string' ? { errorHash } : {}),
    ...(isEvidence(evidence) ? { evidence } : {}),
  };
}

function stable(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 2_000));
    if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
    return JSON.stringify(String(value));
  }
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.slice(0, 50).map((item) => stable(item, seen)).join(',')}]`;
  const keys = Object.keys(value).sort().slice(0, 50);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(field(value, key), seen)}`).join(',')}}`;
}

function preview(value: unknown): string | null {
  try {
    const text = stable(value);
    return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 3)}...` : text;
  } catch {
    return '[result_preview_unavailable]';
  }
}

function ids(event: HostEvent, outcome: NormalizedOutcome, canonicalEventId?: string): { eventId: string; painId: string } {
  const canonical = stable({
    workspaceDir: path.resolve(event.context.workspaceDir),
    sessionId: event.context.sessionId,
    turnId: event.context.turnId ?? null,
    toolName: event.context.toolName,
    source: event.source,
    params: outcome.params,
    result: outcome.result,
    error: outcome.error ?? null,
  });
  const digest = createHash('sha256').update(canonicalEventId
    ? stable({ source: event.source, sessionId: event.context.sessionId, eventId: canonicalEventId })
    : canonical).digest('hex');
  return { eventId: `host_${digest}`, painId: `pain_host_${digest}` };
}

function hasCanonicalSchema(db: Database.Database): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','tool_calls','pain_events')").all();
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_pain_events_canonical_pain_id'").get();
  return tables.length === 3 && index !== undefined;
}

export function createProductionPainEvidenceHandler(options: { painEnrichmentProvider?: PainEnrichmentProvider } = {}) {
  return async (event: HostEvent): Promise<HostEventResult> => {
    const warnings: string[] = [];
    const dbPath = path.join(event.context.workspaceDir, '.state', 'trajectory.db');
    let enrichment: ProductionPainEnrichment | null;
    try {
      enrichment = parseEnrichment(await options.painEnrichmentProvider?.(event));
    } catch (error) {
      warnings.push(`pain_enrichment_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
      enrichment = null;
    }
    if (!enrichment) {
      return { decision: 'observe', source: event.source, warnings: warnings.length > 0 ? warnings : ['pain_enrichment_invalid'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'inspect host pain enrichment input' } };
    }
    if (!fs.existsSync(dbPath)) {
      return { decision: 'observe', source: event.source, warnings: ['trajectory_db_not_found'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'initialize the selected PD workspace before retrying the hook' } };
    }

    const outcome = normalizeOutcome(event);
    const toolName = event.context.toolName ?? '';
    const sourceObservation = buildToolFailureObservation({ toolName, error: outcome.error, exitCode: outcome.exitCode });
    const sourceKind = resolveSourceKind({
      observedAt: new Date().toISOString(), workspaceId: event.context.workspaceDir,
      sessionId: event.context.sessionId, toolName, failureSource: sourceObservation.failureSource,
      toolNotFound: sourceObservation.toolNotFound, nonZeroExit: outcome.exitCode !== 0,
    });
    const relativePath = enrichment.relativePath ?? String(field(outcome.params, 'file_path') ?? field(outcome.params, 'path') ?? 'unknown').slice(0, 500);
    const isRisky = enrichment.isRisky ?? (path.isAbsolute(relativePath) && !path.resolve(relativePath).startsWith(`${path.resolve(event.context.workspaceDir)}${path.sep}`));
    const painScore = enrichment.painScore ?? Math.min(100, (outcome.exitCode !== 0 ? 70 : 0) + (isRisky ? 20 : 0));
    const errorHash = enrichment.errorHash ?? createHash('sha256').update(outcome.error ?? String(outcome.exitCode)).digest('hex');
    const cooldownKey = `${path.resolve(event.context.workspaceDir)}:${event.context.sessionId}:${sourceObservation.failureSource}:${errorHash}`;
    const last = cooldowns.get(cooldownKey);
    const cooldownActive = last !== undefined && Date.now() - last < 15 * 60 * 1000;
    const triage = evaluateTriage({ sourceKind, score: painScore, consecutiveErrors: enrichment.consecutiveErrors, isRisky });
    const trigger = evaluateTriggerController({ triageResult: triage, isOwnerManual: false, isCooldownActive: cooldownActive, isValid: true, score: painScore, sessionId: event.context.sessionId });
    const admitted = outcome.failure && WRITE_TOOLS.has(toolName) && trigger.shouldCreateDiagnosticTask;
    const { eventId, painId } = ids(event, outcome, enrichment.eventId);
    const createdAt = new Date().toISOString();
    const paramsJson = stable({ eventId, source: event.source, toolInput: outcome.params });
    let duplicate = false;
    let duplicateAdmitted = false;

    const db = new Database(dbPath);
    try {
      db.pragma('busy_timeout = 5000');
      if (!hasCanonicalSchema(db)) {
        return { decision: 'observe', source: event.source, warnings: ['trajectory_schema_invalid'], metadata: { outcome: 'unavailable', admitted: false, duplicate: false, nextAction: 'run the supported PD workspace migration' } };
      }
      db.transaction(() => {
        if (db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ?').get(event.context.sessionId, toolName, paramsJson)) {
          duplicate = true;
          duplicateAdmitted = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined;
          return;
        }
        db.prepare(`INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`).run(event.context.sessionId, createdAt, createdAt);
        db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(event.context.sessionId, toolName, outcome.failure ? 'failure' : 'success', outcome.durationMs ?? null, outcome.exitCode, outcome.error ? outcome.error.split(/[\s:]/, 1)[0] : null, outcome.error ?? null, null, null, paramsJson, preview(outcome.result), createdAt);
        if (admitted) {
          const reason = `Tool ${toolName} failed on ${relativePath}; diagnosticGate=${trigger.reason}`;
          db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.context.sessionId, sourceObservation.failureSource ?? 'tool_failure', painScore, reason, painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild', 'system_infer', 1, enrichment.evidence?.map((entry) => `${entry.sourceRef}: ${entry.note}`).join('\n') ?? null, painId, null, createdAt);
        }
      })();
      if (admitted && !duplicate) cooldowns.set(cooldownKey, Date.now());
    } catch (error) {
      return { decision: 'observe', source: event.source, warnings: [`trajectory_write_failed:${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`], metadata: { outcome: outcome.failure ? 'failure' : 'success', admitted: false, duplicate: false, nextAction: 'inspect the workspace trajectory database and retry' } };
    } finally {
      db.close();
    }

    const effectiveAdmitted = admitted || duplicateAdmitted;
    return { decision: 'observe', source: event.source, metadata: {
      eventId, painId: effectiveAdmitted ? painId : null, outcome: outcome.failure ? 'failure' : 'success', admitted: effectiveAdmitted, duplicate,
      sourceKind, failureSource: sourceObservation.failureSource ?? null, triggerOutcome: trigger.outcome,
      triggerReason: trigger.reason, painScore, isRisky, relativePath, agentId: enrichment.agentId ?? null,
      evidence: enrichment.evidence ?? [],
    } };
  };
}

export function resetProductionPainCooldownForTest(): void {
  cooldowns.clear();
}
