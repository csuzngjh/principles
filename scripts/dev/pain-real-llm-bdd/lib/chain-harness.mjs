/**
 * PRI-1147 real-LLM BDD harness — shared helpers.
 *
 * Drives the REAL production chain end-to-end:
 *   processHookInvocation (codex-adapter) → ingestion → admission → pending
 *   → runStage2CorrectionCycle (host-runtime) with the REAL pi-ai classifier
 *   resolved from the isolated workspace's own .pd/config.yaml.
 *
 * No mocks: the Stage-2 classifier is built by the production factory
 * (createSignalClassifierForWorkspace) against a real provider; only the
 * workspace/codex-home filesystem roots are isolated per sample.
 *
 * Conventions:
 * - Every workspace/codex-home lives under a per-run temp root (os.tmpdir()).
 * - No hardcoded absolute paths (check:workspace-tools rule).
 * - All SQL is parameterized; unknown values are serialized with bounded previews.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const coreRuntime = await import('@principles/core/runtime');
const codexAdapter = await import('@principles/codex-adapter');
const hostRuntime = await import('@principles/host-runtime');
const pluginRuntime = await import('principles-disciple');

const { getDefaultPdConfig } = coreRuntime;
const { processHookInvocation } = codexAdapter;
const { runStage2CorrectionCycle, createSignalClassifierForWorkspace } = hostRuntime;
const { initTrajectorySchema } = pluginRuntime;
const { SqliteConnection } = coreRuntime;

/** sha256 hex of UTF-8 text (input_hash column of the run ledger). */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** rc-8: bounded, key-preserving serialization for logs. */
export function safePreview(value, maxLen = 300) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 400 ? v.slice(0, 400) + '…' : v));
  if (text === undefined) return String(value);
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

export function redactSecrets(text) {
  return text
    .replace(/(ZAI_API_KEY|AMD_RADEON_API_KEY|DEEPSEEK_API_KEY|apiKey|api_key)(=|["'\s:]+)[A-Za-z0-9._\-]{8,}/g, '$1$2***REDACTED***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer ***REDACTED***');
}

/** D5/G-category learned keyword seed (source=llm ⇒ never direct STRONG). */
export function writeLearnedKeywordStore(workspaceDir, keywords) {
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'correction_keywords.json'),
    JSON.stringify({ keywords }),
  );
}

/**
 * Build the workspace .pd/config.yaml from the DEFAULT config (same pattern as
 * host-runtime tests): enable host.codex + codex_conversation_ingestion +
 * signal_collector, bind the signalCollector internal agent to a pi-ai
 * profile. Provider/model come from env so the dataset stays provider-neutral.
 */
export function buildWorkspaceConfig({ provider, model, apiKeyEnv, timeoutMs, maxTokens, reasoning, baseUrl }) {
  const config = getDefaultPdConfig();
  if (config.features['host.codex']) config.features['host.codex'].enabled = true;
  config.features['codex_conversation_ingestion'] = { enabled: true, category: 'quiet' };
  config.features['signal_collector'] = { enabled: true, category: 'quiet' };
  config.internalAgents.defaultRuntime = 'pi-ai-bdd';
  config.internalAgents.agents.signalCollector = { enabled: true, runtimeProfile: 'pi-ai-bdd' };
  config.runtimeProfiles['pi-ai-bdd'] = {
    type: 'pi-ai',
    provider,
    model,
    apiKeyEnv,
    timeoutMs,
    maxTokens,
    reasoning,
    ...(baseUrl ? { baseUrl } : {}),
  };
  return config;
}

/**
 * One isolated sample environment: PD workspace + CODEX_HOME with a valid
 * rollout transcript file (rollout-<ts>-<uuid>.jsonl under sessions/).
 */
export function bootstrapSampleEnv({ runRoot, sampleId, config, learnedKeywords }) {
  const sampleRoot = path.join(runRoot, sampleId);
  const workspaceDir = path.join(sampleRoot, 'ws');
  const codexHome = path.join(sampleRoot, 'codex-home');
  const sessionsDir = path.join(codexHome, 'sessions');
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config, null, 2));

  // Production-path database initialization (same functions pd runtime init uses).
  const stateConn = new SqliteConnection({ workspaceDir, kind: 'state' });
  stateConn.getDb().close();
  initTrajectorySchema(workspaceDir);

  if (Array.isArray(learnedKeywords) && learnedKeywords.length > 0) {
    writeLearnedKeywordStore(workspaceDir, learnedKeywords);
  }

  const rolloutUuid = crypto.randomUUID();
  const rolloutFileName = `rollout-20261107T000000-${rolloutUuid}.jsonl`;
  const transcriptPath = path.join(sessionsDir, rolloutFileName);
  fs.writeFileSync(transcriptPath, '');

  return { sampleRoot, workspaceDir, codexHome, transcriptPath, rolloutIdentity: rolloutUuid.toLowerCase() };
}

export function buildUserPromptSubmitPayload({ workspaceDir, transcriptPath, sessionId, turnId, text }) {
  return {
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: transcriptPath,
    cwd: workspaceDir,
    hook_event_name: 'UserPromptSubmit',
    model: 'glm-5.3-flash',
    permission_mode: 'bypassPermissions',
    stop_hook_active: false,
    prompt: text,
  };
}

/**
 * Drive the REAL production hook entry (processHookInvocation) exactly like
 * the Codex runtime does: raw JSON stdin + CODEX_HOME env + cwd.
 */
export async function driveHook({ payload, workspaceDir, codexHome }) {
  const env = { ...process.env, CODEX_HOME: codexHome };
  const result = await processHookInvocation(JSON.stringify(payload), env, workspaceDir);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout ?? {},
    stderr: (result.stderr ?? []).map((line) => redactSecrets(String(line))),
  };
}

function openReadonly(ws) {
  return new Database(path.join(ws, '.state', 'trajectory.db'), { readonly: true, fileMustExist: true });
}

/** Read the full admission state for one logical observation key. */
export function readAdmissionState(workspaceDir, logicalKey) {
  const db = openReadonly(workspaceDir);
  try {
    const marker = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(logicalKey) ?? null;
    const pain = db.prepare('SELECT * FROM pain_events WHERE canonical_pain_id = ?')
      .get(marker && marker.canonical_pain_id ? marker.canonical_pain_id : '__none__') ?? null;
    const observation = db.prepare('SELECT logical_key, kind, visible_text, completeness FROM governance_observations WHERE logical_key = ?').get(logicalKey) ?? null;
    const painCount = db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()?.n ?? 0;
    return {
      marker: marker ? {
        decision: marker.decision,
        reason: marker.reason,
        ruleVersion: marker.rule_version,
        canonicalPainId: marker.canonical_pain_id,
        updatedAt: marker.updated_at,
        payloadPreview: safePreview(parseJsonSafe(marker.task_payload_json)),
      } : null,
      pain: pain ? { canonicalPainId: pain.canonical_pain_id, score: pain.score, source: pain.source, hostKind: pain.host_kind } : null,
      observation: observation ? { kind: observation.kind, completeness: observation.completeness } : null,
      painCount,
    };
  } finally {
    db.close();
  }
}

/** All admission markers (used by D6 idempotency/TTL checks). */
export function readAllMarkers(workspaceDir) {
  const db = openReadonly(workspaceDir);
  try {
    const rows = db.prepare('SELECT logical_observation_key, decision, reason, canonical_pain_id, task_payload_json, created_at, updated_at FROM governance_signal_admissions ORDER BY id').all();
    return rows.map((r) => ({
      logicalKey: r.logical_observation_key,
      decision: r.decision,
      reason: r.reason,
      canonicalPainId: r.canonical_pain_id,
      payload: parseJsonSafe(r.task_payload_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } finally {
    db.close();
  }
}

export function readPainCount(workspaceDir) {
  const db = openReadonly(workspaceDir);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM pain_events').get()?.n ?? 0;
  } finally {
    db.close();
  }
}

function parseJsonSafe(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return { unparseable: true }; }
}

/**
 * Run the REAL Stage-2 correction cycle (the exact function the production
 * workers call as their final step) until the marker reaches a terminal
 * decision, capturing per-cycle reports and per-call LLM measurements.
 *
 * classifierWrap must be the REAL classifier from createSignalClassifierForWorkspace.
 */
export async function runStage2UntilTerminal({ workspaceDir, classifierWrap, maxCycles = 8, classificationTimeoutMs = 60_000 }) {
  const cycles = [];
  for (let i = 0; i < maxCycles; i += 1) {
    const report = await runStage2CorrectionCycle({
      workspaceDir,
      classifier: classifierWrap.fn,
      classifierState: 'used',
      aggregateBudgetMs: 120_000,
      classificationTimeoutMs,
    });
    cycles.push({
      cycle: i + 1,
      ok: report.ok,
      claimed: report.claimed,
      admitted: report.admitted,
      resolvedNone: report.resolvedNone,
      abandoned: report.abandoned,
      stillPending: report.stillPending,
      skipped: report.skipped,
      expired: report.expired,
      durationMs: report.durationMs,
      ...(report.reason ? { reason: report.reason } : {}),
      degradations: report.degradations,
    });
    if (report.claimed === 0 || (report.stillPending === 0 && report.skipped === 0)) break;
    if (report.stillPending > 0 && report.skipped === 0 && report.claimed > 0) continue;
    if (report.stillPending === 0) break;
  }
  return cycles;
}

/**
 * Build the REAL classifier from the workspace's own config (production
 * resolution path) and wrap it with per-call latency/outcome measurement.
 * The wrapped function delegates to the real adapter call — nothing about
 * the request is altered.
 */
export function buildMeasuredClassifier(workspaceDir) {
  const resolution = createSignalClassifierForWorkspace(workspaceDir, {
    log: () => {},
  });
  if (!resolution.ok) {
    return { ok: false, readiness: resolution.readiness, reason: resolution.reason, nextAction: resolution.nextAction };
  }
  const realClassifier = resolution.classifier;
  const calls = [];
  const fn = async (text, options) => {
    const startedAt = Date.now();
    let result = null;
    let errorText = null;
    try {
      result = await realClassifier(text, options);
    } catch (error) {
      errorText = String(error).slice(0, 200);
    }
    const latencyMs = Date.now() - startedAt;
    calls.push({
      latencyMs,
      status: errorText !== null ? 'threw' : result === null ? 'no_verdict' : 'ok',
      ...(result ? { verdict: { is_feedback: result.is_feedback, type: result.type, confidence: result.confidence, reason: result.reason } } : {}),
      ...(errorText ? { error: redactSecrets(errorText) } : {}),
    });
    return result;
  };
  return {
    ok: true,
    profile: resolution.profile,
    fn,
    calls,
    summary: () => {
      const total = calls.length;
      const okCalls = calls.filter((c) => c.status === 'ok');
      const latencies = okCalls.map((c) => c.latencyMs).sort((a, b) => a - b);
      const p95 = latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))];
      return {
        totalCalls: total,
        okCalls: okCalls.length,
        noVerdictCalls: calls.filter((c) => c.status === 'no_verdict').length,
        threwCalls: calls.filter((c) => c.status === 'threw').length,
        avgLatencyMs: okCalls.length === 0 ? null : Math.round(okCalls.reduce((s, c) => s + c.latencyMs, 0) / okCalls.length),
        p95LatencyMs: p95,
      };
    },
  };
}

/** Unique ids per sample so logical keys never collide. */
export function sampleIds(sampleId, index) {
  const hex = crypto.randomBytes(16).toString('hex');
  return {
    sessionId: `sess-${sampleId.toLowerCase()}-${hex.slice(0, 8)}`,
    turnId: `turn-${String(index).padStart(3, '0')}-${hex.slice(8, 24)}`,
  };
}
