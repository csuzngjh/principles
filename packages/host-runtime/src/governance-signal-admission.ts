/**
 * Governance Signal Admission — Codex Governance Closure Slice B (PRI-623).
 *
 * The learning entrypoint above Slice A's observations, per Codex Governance
 * Closure SPEC rev 2 §12/§13 and ADR-0020 §11.3/§11.4:
 *
 *   Governance Observation → detection → admission → ONE canonical Pain
 *     → bounded evidence promotion → ONE pending Diagnostician task
 *
 * Ownership (SPEC §7):
 * - shared synchronous correction-detector semantics (keyword store, rule
 *   version, STRONG classification) extracted from the OpenClaw-only wrapper —
 *   OpenClaw and Codex consume the SAME store file and the SAME core scan;
 * - canonical pain admission through the ONE existing authority
 *   (`production-pain-evidence.ts` derivations + the unique
 *   `pain_events.canonical_pain_id` index) — never a second pain identity;
 * - the transactional STRONG-correction rate-limit bucket persisted in
 *   trajectory.db (ADR-0020 §11.3: Codex fresh-subprocess hooks make
 *   process-local state dead state; OpenClaw's in-memory bucket and the
 *   tool-pain cooldown keep their existing behavior);
 * - one admitted pain → exactly one pending Diagnostician task via
 *   PainToPrincipleService async mode (Runtime V2 task authority), with the
 *   task link persisted on the admission marker;
 * - one narrow, idempotent reconciliation pass for the cross-store crash gaps
 *   (trajectory.db ↔ .pd/state.db cannot share a transaction).
 *
 * Exactly-once reasoning: admission marker + pain insert + rate-limit
 * consumption commit in ONE trajectory.db transaction; canonical pain ids are
 * content-derived, so duplicate delivery (live + transcript replay, retries,
 * fresh subprocesses) either finds the marker, finds the pain row, or
 * re-derives the identical id — never a second pain. Ordinary conversation and
 * non-signals write NOTHING here (SPEC §18 scenario 6).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  collectSync,
  CORRECTION_SEED_KEYWORDS,
  buildToolFailureObservation,
  evaluateTriage,
  evaluateTriggerController,
  resolveSourceKind,
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  RuntimeStateManager,
  createDiagnosticianTaskId,
  disposePainSignalBridgesForWorkspace,
  sanitizeString,
  MAX_EVIDENCE_VALUE_CHARS,
  type SignalCollectorConfig,
  type SignalCollectorOutput,
  type UnifiedKeywordStore,
} from '@principles/core/runtime-v2';
import {
  deriveProductionCorrectionPainIdentity,
  deriveProductionToolPainIdentity,
  hasProductionPainSchema,
  PRODUCTION_WRITE_TOOLS,
} from './production-pain-evidence.js';
import { promoteGovernanceEvidence, ensureGovernanceSchema, type ObservationDatabaseFactory } from './governance-observation-store.js';
import { loadPdConfigForPlugin } from './pd-config.js';

// ─── Shared detector constants (one truth for both hosts) ───────────────────
export const GOVERNANCE_STRONG_PAIN_SCORE = 70;
export const GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR = 5;
export const GOVERNANCE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Sync-only detection config: ambiguous candidates are NOT signals here (§12). */
const SYNC_DETECTION_CONFIG: SignalCollectorConfig = {
  enableLlmStage: false,
  llmTimeoutMs: 0,
  promptTemplate: '',
  strongPainScore: GOVERNANCE_STRONG_PAIN_SCORE,
  strongRateLimitPerHour: GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR,
};

const MAX_REASON_BOUND = 300;

// ─── Small shared guards ────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function rowField(row: unknown, key: string): unknown {
  return isRecord(row) ? own(row, key) : undefined;
}

type Degradation = { ok: false; reason: string; nextAction: string };

// ─── Shared correction keyword store (host-neutral extraction) ──────────────

const KEYWORD_STORE_FILE = 'correction_keywords.json';

/** learned 词进入高精度 deterministic path 的权重阈值(仅 seed/owner_promoted; llm_learned 恒 ambiguous) */
export const HIGH_PRECISION_LEARNED_WEIGHT = 0.7;

/** 高精度纠正短语 overlay(已验证的确定性 STRONG 路径,不属于 learner seed 集) */
export const HIGH_PRECISION_CORRECTION_OVERLAY: readonly (readonly [string, number])[] = [
  ['这是错的', 0.9],
  ['不要自作主张', 0.9],
  ['不应该这么做', 0.9],
];

/** empathy seed overlay(检测行为不变) */
export const EMPATHY_SEED_OVERLAY: readonly (readonly [string, number])[] = [
  ['搞什么', 0.5],
];

interface LearnedKeywordShape {
  term: string;
  weight: number;
  source: string;
}

function isValidLearnedKeyword(v: unknown): v is LearnedKeywordShape {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  if (typeof k.term !== 'string' || k.term.length === 0) return false;
  if (typeof k.weight !== 'number' || !Number.isFinite(k.weight)) return false;
  return k.source === 'seed' || k.source === 'llm' || k.source === 'user';
}

function mapLearnedSource(source: string): UnifiedKeywordStore['terms'][string]['source'] {
  if (source === 'llm') return 'llm_learned';
  if (source === 'user') return 'owner_promoted';
  return 'seed';
}

function precisionFor(source: string, weight: number): 'high' | 'ambiguous' {
  if (source === 'llm') return 'ambiguous';
  return weight >= HIGH_PRECISION_LEARNED_WEIGHT ? 'high' : 'ambiguous';
}

function projectLearnedStore(raw: unknown): { terms: UnifiedKeywordStore['terms']; learnedCount: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const keywords: unknown = (raw as Record<string, unknown>).keywords;
  if (!Array.isArray(keywords)) return null;
  const terms: UnifiedKeywordStore['terms'] = {};
  let learnedCount = 0;
  for (const kw of keywords) {
    if (!isValidLearnedKeyword(kw)) continue;
    const term = kw.term.trim().toLowerCase();
    if (!term || Object.hasOwn(terms, term)) continue;
    const weight = Math.max(0, Math.min(1, kw.weight));
    terms[term] = {
      term,
      category: 'correction',
      weight,
      precision: precisionFor(kw.source, weight),
      source: mapLearnedSource(kw.source),
    };
    if (kw.source === 'llm') learnedCount += 1;
  }
  return { terms, learnedCount };
}

export function buildSharedSeedKeywordStore(): UnifiedKeywordStore {
  const terms: UnifiedKeywordStore['terms'] = {};
  for (const [term, weight] of HIGH_PRECISION_CORRECTION_OVERLAY) {
    terms[term] = { term, category: 'correction', weight, precision: 'high', source: 'seed' };
  }
  for (const [term, weight] of EMPATHY_SEED_OVERLAY) {
    terms[term] = { term, category: 'empathy', weight, precision: 'ambiguous', source: 'seed' };
  }
  for (const kw of CORRECTION_SEED_KEYWORDS) {
    if (Object.hasOwn(terms, kw.term)) continue;
    terms[kw.term] = {
      term: kw.term,
      category: 'correction',
      weight: kw.weight,
      precision: kw.weight >= HIGH_PRECISION_LEARNED_WEIGHT ? 'high' : 'ambiguous',
      source: 'seed',
    };
  }
  return { version: 2, terms };
}

export interface SharedCorrectionKeywordStore {
  resolve(): UnifiedKeywordStore;
  stats(): { totalTerms: number; learnedTerms: number; lastReloadedAt: string | null };
}

export interface SharedKeywordStoreOptions {
  readonly workspaceDir: string;
  /** Bounded degradation sink (rc-9); defaults to silent-with-stats. */
  readonly onDegradation?: (code: string, message: string) => void;
  readonly logger?: { debug?: (msg: string) => void };
}

/**
 * Host-neutral live keyword store (extracted from the OpenClaw-only wrapper,
 * SPEC §12): reads the per-workspace `<workspace>/.state/correction_keywords.json`
 * learner projection with mtime-based refresh, falling back to the seed store.
 * OpenClaw and Codex resolve detection through this SAME store. The store file
 * must stay a direct child of the workspace state directory (boundary guard).
 */
export function createSharedCorrectionKeywordStore(options: SharedKeywordStoreOptions): SharedCorrectionKeywordStore {
  const stateDirResolved = path.resolve(options.workspaceDir, '.state');
  const filePath = path.join(stateDirResolved, KEYWORD_STORE_FILE);
  if (!filePath.startsWith(stateDirResolved + path.sep) || path.basename(filePath) !== KEYWORD_STORE_FILE) {
    options.onDegradation?.('SIGNAL_KEYWORD_STORE_INVALID', `resolved store path escapes the workspace state directory; refusing to load (path=${filePath.slice(0, 120)})`);
    return {
      resolve: () => buildSharedSeedKeywordStore(),
      stats: () => ({ totalTerms: 0, learnedTerms: 0, lastReloadedAt: null }),
    };
  }

  let cached: UnifiedKeywordStore | null = null;
  let cachedMtimeMs: number | null = null;
  let learnedCount = 0;
  let lastReloadedAt: string | null = null;

  const reload = (): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    } catch {
      options.onDegradation?.('SIGNAL_KEYWORD_STORE_INVALID', `cannot read ${KEYWORD_STORE_FILE}; using seed-only store (first run before the optimizer writes is normal)`);
      cached = buildSharedSeedKeywordStore();
      learnedCount = 0;
      lastReloadedAt = new Date().toISOString();
      return;
    }
    const projected = projectLearnedStore(raw);
    if (!projected) {
      options.onDegradation?.('SIGNAL_KEYWORD_STORE_INVALID', `${KEYWORD_STORE_FILE} malformed (keywords[] missing/invalid); using seed-only store`);
      cached = buildSharedSeedKeywordStore();
      learnedCount = 0;
      lastReloadedAt = new Date().toISOString();
      return;
    }
    const store = buildSharedSeedKeywordStore();
    for (const [term, entry] of Object.entries(projected.terms)) {
      store.terms[term] = entry;
    }
    cached = store;
    ({ learnedCount } = projected);
    lastReloadedAt = new Date().toISOString();
    options.logger?.debug?.(`[PD:Signal] keyword store reloaded: ${Object.keys(store.terms).length} terms (${learnedCount} learned)`);
  };

  return {
    resolve(): UnifiedKeywordStore {
      let mtimeMs: number | null = null;
      try {
        ({ mtimeMs } = fs.statSync(filePath));
      } catch {
        // missing file keeps mtimeMs null → seed-only reload path above
      }
      if (!cached || mtimeMs !== cachedMtimeMs) {
        reload();
        cachedMtimeMs = mtimeMs;
      }
      return cached ?? buildSharedSeedKeywordStore();
    },
    stats() {
      return {
        totalTerms: cached ? Object.keys(cached.terms).length : 0,
        learnedTerms: learnedCount,
        lastReloadedAt,
      };
    },
  };
}

// ─── Synchronous detection (shared semantics) ───────────────────────────────

export interface CorrectionDetectionResult {
  readonly output: SignalCollectorOutput;
  readonly ruleVersion: number;
}

/**
 * The shared synchronous high-precision correction detection (SPEC §12):
 * one keyword store, one rule version, one STRONG classification for both
 * hosts. Codex consumes only the deterministic high-precision path — ambiguous
 * candidates are not signals in a bounded hook (LLM confirmation belongs to
 * hosts that own an async stage).
 */
export function evaluateCorrectionSignal(input: {
  workspaceDir: string;
  text: string;
  sessionId: string;
  detectedAt: string;
  store?: UnifiedKeywordStore;
  onDegradation?: (code: string, message: string) => void;
}): CorrectionDetectionResult {
  const store = input.store ?? createSharedCorrectionKeywordStore({
    workspaceDir: input.workspaceDir,
    ...(input.onDegradation ? { onDegradation: input.onDegradation } : {}),
  }).resolve();
  const output = collectSync(input.text, input.sessionId, store, SYNC_DETECTION_CONFIG, input.detectedAt);
  return { output, ruleVersion: store.version };
}

// ─── Admission schema ───────────────────────────────────────────────────────

export type GovernanceSignalKind = 'user_correction' | 'tool_failure';

const ADMISSION_CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS governance_signal_admissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    host_kind TEXT NOT NULL,
    logical_observation_key TEXT NOT NULL,
    rollout_identity TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    signal_kind TEXT NOT NULL,
    decision TEXT NOT NULL,
    canonical_pain_id TEXT,
    diagnostician_task_id TEXT,
    rule_version INTEGER,
    reason TEXT,
    task_payload_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(logical_observation_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_governance_signal_admissions_missing_task
     ON governance_signal_admissions(decision, diagnostician_task_id)`,
  `CREATE TABLE IF NOT EXISTS governance_correction_rate_limits (
    root_session_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    window_start TEXT NOT NULL,
    count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (root_session_id, rule_version)
  )`,
];

function ensureGovernanceAdmissionSchema(db: Database.Database): void {
  db.transaction(() => {
    for (const statement of ADMISSION_CREATE_STATEMENTS) db.exec(statement);
  })();
}

interface OpenAdmissionStoreResult {
  db: Database.Database;
  close(): void;
}

function openAdmissionStore(workspaceDir: string, factory?: ObservationDatabaseFactory): OpenAdmissionStoreResult | Degradation {
  const dbPath = path.join(workspaceDir, '.state', 'trajectory.db');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: 'trajectory_db_not_found', nextAction: 'initialize the selected PD workspace (pd runtime init) before enabling conversation ingestion' };
  }
  try {
    const db = factory ? factory(dbPath) : new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    ensureGovernanceAdmissionSchema(db);
    // The reconciliation pass reads observation-owned tables (promotion
    // tails): one open makes the whole governance schema ready.
    ensureGovernanceSchema(db);
    return { db, close: () => { try { db.close(); } catch { /* write result already determined */ } } };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `trajectory_database_unavailable:${detail}`, nextAction: 'inspect or repair the selected PD trajectory database' };
  }
}

// ─── Candidates and outcomes ────────────────────────────────────────────────

export interface GovernanceCorrectionCandidate {
  readonly kind: 'user_correction';
  readonly hostKind: 'codex';
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly text: string;
  readonly observedAt: string;
}

export interface GovernanceToolFailureCandidate {
  readonly kind: 'tool_failure';
  readonly hostKind: 'codex';
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly toolName: string;
  /** Host event source (e.g. `codex:post_tool_use`) — identity parity with the live handler. */
  readonly source: string;
  readonly toolInput?: unknown;
  readonly toolOutput?: unknown;
  readonly observedAt: string;
}

export type GovernanceSignalCandidate = GovernanceCorrectionCandidate | GovernanceToolFailureCandidate;

export type GovernanceAdmissionOutcome =
  | { disposition: 'admitted'; kind: GovernanceSignalKind; logicalObservationKey: string; canonicalPainId: string; duplicate: boolean; ruleVersion: number | null }
  | { disposition: 'already_admitted'; kind: GovernanceSignalKind; logicalObservationKey: string; canonicalPainId: string; diagnosticianTaskId: string | null }
  | { disposition: 'not_a_signal'; kind: 'user_correction'; logicalObservationKey: string }
  | { disposition: 'not_admitted'; kind: 'tool_failure'; logicalObservationKey: string; reason: string }
  | { disposition: 'rate_limited'; kind: 'user_correction'; logicalObservationKey: string }
  | Degradation;

/** Internal control-flow signals thrown inside the admission transaction. */
class RateLimitedSignal extends Error {
  constructor() {
    super('rate_limited');
    this.name = 'RateLimitedSignal';
  }
}

// ─── Rate-limit bucket (transactional, SPEC §12 / ADR-0020 §11.3) ───────────

interface RateLimitArgs {
  db: Database.Database;
  rootSessionId: string;
  ruleVersion: number;
  now: Date;
}

/**
 * Fixed-window bucket counted INSIDE the admission transaction. Only admitted
 * corrections consume quota; duplicates short-circuit before the bucket check;
 * a rolled-back transaction rolls the consumption back with it.
 */
function tryConsumeRateLimit({ db, rootSessionId, ruleVersion, now }: RateLimitArgs): boolean {
  const nowMs = now.getTime();
  const row = db.prepare('SELECT * FROM governance_correction_rate_limits WHERE root_session_id = ? AND rule_version = ?').get(rootSessionId, ruleVersion);
  let windowStartMs: number;
  let count: number;
  if (isRecord(row)) {
    const start = rowField(row, 'window_start');
    windowStartMs = typeof start === 'string' ? Date.parse(start) : Number.NaN;
    count = typeof rowField(row, 'count') === 'number' ? (rowField(row, 'count') as number) : 0;
    if (!Number.isFinite(windowStartMs) || nowMs - windowStartMs >= GOVERNANCE_RATE_LIMIT_WINDOW_MS) {
      windowStartMs = nowMs;
      count = 0;
    }
  } else {
    windowStartMs = nowMs;
    count = 0;
  }
  if (count >= GOVERNANCE_STRONG_RATE_LIMIT_PER_HOUR) return false;
  db.prepare(`INSERT INTO governance_correction_rate_limits (root_session_id, rule_version, window_start, count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(root_session_id, rule_version) DO UPDATE SET window_start = excluded.window_start, count = excluded.count, updated_at = excluded.updated_at`)
    .run(rootSessionId, ruleVersion, new Date(windowStartMs).toISOString(), count + 1, now.toISOString());
  return true;
}

// ─── Pain row writers (mirroring the production handler) ────────────────────

interface CorrectionPainArgs {
  db: Database.Database;
  candidate: GovernanceCorrectionCandidate;
  workspaceDir: string;
  painId: string;
  detection: SignalCollectorOutput;
  nowIso: string;
}

function insertCorrectionPain({ db, candidate, workspaceDir, painId, detection, nowIso }: CorrectionPainArgs): string {
  const reason = detection.matchedTerms.length > 0
    ? `User correction detected: ${detection.matchedTerms.join(', ')}`
    : 'User correction detected';
  // P1-1 privacy (review round 2): the FULL raw text must pass through the
  // sanitizer BEFORE any truncation — sanitizeString's own contract is
  // redact → path-replace → bound. Slicing first would split a token that
  // crosses the 200-char boundary into a fragment that no longer matches the
  // token regex and would be persisted verbatim. `detection.evidence.excerpt`
  // is NOT used here: buildEvidence already truncated it upstream, so a token
  // straddling that cut would survive sanitization the same way.
  const excerpt = sanitizeString(candidate.text, workspaceDir);
  db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(candidate.rootSessionId, 'user_correction', GOVERNANCE_STRONG_PAIN_SCORE, reason.slice(0, MAX_REASON_BOUND), 'severe', 'system_infer', null, excerpt, painId, null, nowIso);
  return reason;
}

interface GovernanceTaskSubmissionPayload {
  readonly painType: 'user_frustration' | 'tool_failure';
  readonly source: string;
  readonly reason: string;
  readonly score: number;
  readonly sessionId: string;
  readonly hostKind: 'codex';
  readonly evidence: readonly { sourceRef: string; note: string }[];
}

function taskSubmissionPayload(candidate: GovernanceSignalCandidate, workspaceDir: string, reason: string): string {
  // P1-1 privacy (review round 2): sanitize the FULL text before any
  // truncation — a token crossing the 200-char boundary must be redacted, not
  // split into a fragment that survives verbatim. sanitizeString bounds itself.
  const payload: GovernanceTaskSubmissionPayload = candidate.kind === 'user_correction'
    ? {
      painType: 'user_frustration',
      source: 'user_correction',
      reason: reason || 'User correction detected',
      score: GOVERNANCE_STRONG_PAIN_SCORE,
      sessionId: candidate.rootSessionId,
      hostKind: 'codex',
      evidence: [{ sourceRef: `governance_observation:${candidate.logicalObservationKey}`, note: sanitizeString(candidate.text, workspaceDir) }],
    }
    : {
      painType: 'tool_failure',
      source: candidate.toolName,
      reason: reason || `tool=${candidate.toolName}`,
      score: 70,
      sessionId: candidate.rootSessionId,
      hostKind: 'codex',
      evidence: [{ sourceRef: `governance_observation:${candidate.logicalObservationKey}`, note: sanitizeString(reason || candidate.toolName, workspaceDir) }],
    };
  return JSON.stringify(payload);
}

interface AdmissionMarkerArgs {
  db: Database.Database;
  candidate: GovernanceSignalCandidate;
  workspaceDir: string;
  canonicalPainId: string;
  ruleVersion: number | null;
  reason: string;
  nowIso: string;
}

function insertAdmissionMarker({ db, candidate, workspaceDir, canonicalPainId, ruleVersion, reason, nowIso }: AdmissionMarkerArgs): void {
  const payload = taskSubmissionPayload(candidate, workspaceDir, reason);
  db.prepare(`INSERT INTO governance_signal_admissions
    (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'admitted', ?, NULL, ?, ?, ?, ?, ?)`)
    .run(candidate.hostKind, candidate.logicalObservationKey, candidate.rolloutIdentity, candidate.rootSessionId, candidate.kind, canonicalPainId,
      ruleVersion, reason.slice(0, MAX_REASON_BOUND) || null, payload, nowIso, nowIso);
}

// ─── Per-kind admission (inside one transaction each) ───────────────────────

interface AdmitCorrectionArgs {
  db: Database.Database;
  candidate: GovernanceCorrectionCandidate;
  workspaceDir: string;
  now: Date;
  nowIso: string;
  keywordStore?: UnifiedKeywordStore;
  onDegradation?: (code: string, message: string) => void;
}

function admitCorrection({ db, candidate, workspaceDir, now, nowIso, keywordStore, onDegradation }: AdmitCorrectionArgs): GovernanceAdmissionOutcome {
  // Detection runs OUTSIDE the write transaction (pure scan of the shared
  // keyword store); its outcome feeds the transaction below.
  const detection = evaluateCorrectionSignal({
    workspaceDir,
    text: candidate.text,
    sessionId: candidate.rootSessionId,
    detectedAt: nowIso,
    ...(keywordStore ? { store: keywordStore } : {}),
    ...(onDegradation ? { onDegradation } : {}),
  });
  const isStrongHighPrecision = detection.output.isSignal
    && detection.output.strength === 'STRONG'
    && detection.output.matchedPrecision === 'high';
  if (!isStrongHighPrecision) {
    // Ordinary conversation / weak negation / ambiguous candidates: no pain,
    // no task, no quota, and no marker (SPEC §18 scenario 6 — silence).
    return { disposition: 'not_a_signal', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey };
  }

  const { painId } = deriveProductionCorrectionPainIdentity({
    workspaceDir,
    sessionId: candidate.rootSessionId,
    // Codex occurrence identity = the stable host turn id (SPEC §10): retry of
    // the same real occurrence → same pain; same text in a later real turn →
    // a NEW pain occurrence.
    occurrenceId: candidate.hostTurnId,
    text: candidate.text,
  });

  let reason = '';
  let duplicate = false;
  try {
    db.transaction(() => {
      if (db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined) {
        // Live + transcript duplicate or a crash-replay: the canonical pain
        // already exists — no second row, no second quota consumption.
        duplicate = true;
      } else {
        if (!tryConsumeRateLimit({ db, rootSessionId: candidate.rootSessionId, ruleVersion: detection.ruleVersion, now })) {
          throw new RateLimitedSignal();
        }
        reason = insertCorrectionPain({ db, candidate, workspaceDir, painId, detection: detection.output, nowIso });
      }
      insertAdmissionMarker({ db, candidate, workspaceDir, canonicalPainId: painId, ruleVersion: detection.ruleVersion, reason, nowIso });
    })();
  } catch (error) {
    if (error instanceof RateLimitedSignal) {
      return { disposition: 'rate_limited', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey };
    }
    throw error;
  }
  return { disposition: 'admitted', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, canonicalPainId: painId, duplicate, ruleVersion: detection.ruleVersion };
}

interface AdmitToolFailureArgs {
  db: Database.Database;
  candidate: GovernanceToolFailureCandidate;
  workspaceDir: string;
  nowIso: string;
}

function admitToolFailure({ db, candidate, workspaceDir, nowIso }: AdmitToolFailureArgs): GovernanceAdmissionOutcome {
  const identity = deriveProductionToolPainIdentity({
    workspaceDir,
    sessionId: candidate.rootSessionId,
    turnId: candidate.hostTurnId,
    toolName: candidate.toolName,
    source: candidate.source,
    ...(candidate.toolInput !== undefined ? { toolInput: candidate.toolInput } : {}),
    ...(candidate.toolOutput !== undefined ? { toolOutput: candidate.toolOutput } : {}),
  });
  const { outcome, sanitizedParams, paramsJson, resultPreview, painId } = identity;

  // Admission gate — identical semantics to the live production handler on a
  // fresh process (ADR-0020 accepts cold in-memory cooldowns for Codex;
  // canonical idempotency is the guard).
  const sourceObservation = buildToolFailureObservation({ toolName: candidate.toolName, error: outcome.error, exitCode: outcome.exitCode });
  const sourceKind = resolveSourceKind({
    observedAt: nowIso,
    workspaceId: workspaceDir,
    sessionId: candidate.rootSessionId,
    toolName: candidate.toolName,
    failureSource: sourceObservation.failureSource,
    toolNotFound: sourceObservation.toolNotFound,
    nonZeroExit: outcome.exitCode !== 0,
  });
  // Risk evaluation mirrors the production handler: it reads the RAW params
  // (sanitized params replace paths with placeholders and would lose the
  // absolute-path risk signal). Identity still uses sanitized params.
  const rawFile = isRecord(outcome.params) ? (own(outcome.params, 'file_path') ?? own(outcome.params, 'path')) : undefined;
  const relativePath = String(rawFile ?? 'unknown').slice(0, 500);
  const isRisky = path.isAbsolute(relativePath) && !path.resolve(relativePath).startsWith(`${workspaceDir}${path.sep}`);
  const painScore = Math.min(100, (outcome.exitCode !== 0 ? 70 : 0) + (isRisky ? 20 : 0));
  const triage = evaluateTriage({ sourceKind, score: painScore, isRisky });
  const trigger = evaluateTriggerController({ triageResult: triage, isOwnerManual: false, isCooldownActive: false, isValid: true, score: painScore, sessionId: candidate.rootSessionId });
  const gateAdmitted = outcome.failure && PRODUCTION_WRITE_TOOLS.has(candidate.toolName) && trigger.shouldCreateDiagnosticTask;
  void sanitizedParams;
  if (!gateAdmitted) {
    return { disposition: 'not_admitted', kind: 'tool_failure', logicalObservationKey: candidate.logicalObservationKey, reason: trigger.reason };
  }

  let duplicate = false;
  let duplicateWithoutPain = false;
  let reason = '';
  db.transaction(() => {
    // Same duplicate probe as the production handler: an identical tool_calls
    // row means this exact call was already recorded.
    if (db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?')
      .get(candidate.rootSessionId, candidate.toolName, paramsJson, outcome.failure ? 'failure' : 'success', outcome.exitCode, outcome.error ?? null, resultPreview) !== undefined) {
      duplicate = true;
      duplicateWithoutPain = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) === undefined;
    } else {
      db.prepare(`INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(candidate.rootSessionId, nowIso, nowIso);
      db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.rootSessionId, candidate.toolName, outcome.failure ? 'failure' : 'success', outcome.durationMs ?? null, outcome.exitCode, outcome.error ? outcome.error.split(/[\s:]/, 1)[0] : null, outcome.error ?? null, null, null, paramsJson, resultPreview, nowIso);
      reason = `tool=${candidate.toolName}; error=${outcome.error ?? `exit=${outcome.exitCode}`}; path=${relativePath}`;
      db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.rootSessionId, sourceObservation.failureSource ?? 'tool_failure', painScore, reason, painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild', 'system_infer', null, null, painId, null, nowIso);
    }
    if (!duplicateWithoutPain) {
      insertAdmissionMarker({ db, candidate, workspaceDir, canonicalPainId: painId, ruleVersion: null, reason: sanitizeString(reason, workspaceDir), nowIso });
    }
    // A duplicate call row without an admitted pain mirrors the production
    // handler (no pain insert on duplicates) and records no marker, so a later
    // delivery whose gate reaches threshold can still admit.
  })();
  if (duplicateWithoutPain) {
    return { disposition: 'not_admitted', kind: 'tool_failure', logicalObservationKey: candidate.logicalObservationKey, reason: 'duplicate_tool_call_without_admitted_pain' };
  }
  return { disposition: 'admitted', kind: 'tool_failure', logicalObservationKey: candidate.logicalObservationKey, canonicalPainId: painId, duplicate, ruleVersion: null };
}

interface AdmitOneArgs {
  db: Database.Database;
  candidate: GovernanceSignalCandidate;
  workspaceDir: string;
  now: Date;
  nowIso: string;
  keywordStore?: UnifiedKeywordStore;
  onDegradation?: (code: string, message: string) => void;
}

function admitOne({ db, candidate, workspaceDir, now, nowIso, keywordStore, onDegradation }: AdmitOneArgs): GovernanceAdmissionOutcome {
  if (candidate.hostKind !== 'codex') {
    return { ok: false, reason: 'unsupported_host_kind', nextAction: 'governance signal admission currently accepts codex observations only' };
  }

  const marker = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(candidate.logicalObservationKey);
  if (isRecord(marker)) {
    const canonicalPainId = rowField(marker, 'canonical_pain_id');
    const taskId = rowField(marker, 'diagnostician_task_id');
    return {
      disposition: 'already_admitted',
      kind: candidate.kind,
      logicalObservationKey: candidate.logicalObservationKey,
      canonicalPainId: typeof canonicalPainId === 'string' ? canonicalPainId : '',
      diagnosticianTaskId: typeof taskId === 'string' ? taskId : null,
    };
  }

  if (candidate.kind === 'user_correction') {
    return admitCorrection({ db, candidate, workspaceDir, now, nowIso, ...(keywordStore ? { keywordStore } : {}), ...(onDegradation ? { onDegradation } : {}) });
  }
  return admitToolFailure({ db, candidate, workspaceDir, nowIso });
}

// ─── Admission entrypoint ───────────────────────────────────────────────────

export interface AdmitGovernanceSignalsInput {
  readonly workspaceDir: string;
  readonly candidates: readonly GovernanceSignalCandidate[];
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
  readonly keywordStore?: UnifiedKeywordStore;
  readonly onDegradation?: (code: string, message: string) => void;
}

export type AdmitGovernanceSignalsResult =
  | { ok: true; outcomes: readonly GovernanceAdmissionOutcome[] }
  | Degradation;

/**
 * Admit governance signal candidates. Each candidate commits in its own
 * trajectory.db transaction (marker + pain row + quota together), so one
 * failing candidate never rolls back another's admission.
 */
export function admitGovernanceSignals(input: AdmitGovernanceSignalsInput): AdmitGovernanceSignalsResult {
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  if (!hasProductionPainSchema(db)) {
    close();
    return { ok: false, reason: 'trajectory_schema_invalid', nextAction: 'run the supported PD workspace migration before enabling conversation ingestion' };
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const workspaceDir = path.resolve(input.workspaceDir);

  const outcomes: GovernanceAdmissionOutcome[] = [];
  try {
    for (const candidate of input.candidates) {
      outcomes.push(admitOne({ db, candidate, workspaceDir, now, nowIso, ...(input.keywordStore ? { keywordStore: input.keywordStore } : {}), ...(input.onDegradation ? { onDegradation: input.onDegradation } : {}) }));
    }
    return { ok: true, outcomes };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_admission_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; committed candidates remain durable' };
  } finally {
    close();
  }
}

// ─── Diagnostician continuation (one pain → exactly one pending task) ───────

function isGovernanceTaskPayload(value: unknown): value is GovernanceTaskSubmissionPayload {
  if (!isRecord(value)) return false;
  const painType = own(value, 'painType');
  if (painType !== 'user_frustration' && painType !== 'tool_failure') return false;
  for (const key of ['source', 'reason', 'sessionId'] as const) {
    const candidate = own(value, key);
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
  }
  if (typeof own(value, 'score') !== 'number') return false;
  if (own(value, 'hostKind') !== 'codex') return false;
  const evidence = own(value, 'evidence');
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 8) return false;
  for (const entry of evidence) {
    if (!isRecord(entry)) return false;
    const sourceRef = own(entry, 'sourceRef');
    const note = own(entry, 'note');
    if (typeof sourceRef !== 'string' || sourceRef.length === 0 || sourceRef.length > 300) return false;
    // The note is produced by sanitizeString, whose own contract bounds the
    // output to MAX_EVIDENCE_VALUE_CHARS plus the truncation marker — so the
    // validator must accept that real output bound, not the pre-sanitizer
    // input bound. (Review round 3 P1-1: sanitize FIRST, then let the
    // sanitizer truncate; a stricter check here would reject valid payloads.)
    const MAX_SANITIZED_NOTE_CHARS = MAX_EVIDENCE_VALUE_CHARS + '___TRUNCATED___'.length;
    if (typeof note !== 'string' || note.length > MAX_SANITIZED_NOTE_CHARS) return false;
  }
  return true;
}

export interface EnsureGovernanceTaskInput {
  readonly workspaceDir: string;
  readonly logicalObservationKey: string;
  readonly canonicalPainId: string;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type EnsureGovernanceTaskResult =
  | { ok: true; taskId: string; created: boolean; duplicate: boolean; linkRepaired: boolean }
  | Degradation;

/**
 * Ensure exactly one pending Diagnostician task exists for an admitted
 * canonical pain (SPEC §13). Idempotent across hook retries, reconciliation,
 * and crash restarts: deterministic task id + task-store PK + marker link.
 * Never awaits an LLM — PainToPrincipleService async mode only enqueues.
 *
 * `linkRepaired` is true ONLY when this call actually wrote the marker task
 * link because the task already existed (Case B recovery). A marker that
 * already carried the link reports linkRepaired=false — no fake repair.
 */
export async function ensureGovernanceDiagnosticianTask(input: EnsureGovernanceTaskInput): Promise<EnsureGovernanceTaskResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;

  try {
    const marker = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ? AND canonical_pain_id = ?').get(input.logicalObservationKey, input.canonicalPainId);
    const existingTaskId = rowField(marker, 'diagnostician_task_id');
    if (isRecord(marker) && typeof existingTaskId === 'string' && existingTaskId.length > 0) {
      return { ok: true, taskId: existingTaskId, created: false, duplicate: true, linkRepaired: false };
    }
    if (!isRecord(marker)) {
      return { ok: false, reason: 'admission_marker_not_found', nextAction: 'admit the signal before ensuring its Diagnostician continuation' };
    }
    const payloadRaw = rowField(marker, 'task_payload_json');
    let payloadParsed: unknown;
    try {
      payloadParsed = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : null;
    } catch {
      payloadParsed = null;
    }
    if (!isGovernanceTaskPayload(payloadParsed)) {
      return { ok: false, reason: 'admission_task_payload_invalid', nextAction: 're-admit the signal or run reconciliation after repairing the workspace state' };
    }

    const taskId = createDiagnosticianTaskId(input.canonicalPainId);

    // Cross-store crash recovery (SPEC §13): a task may already exist from a
    // crashed prior attempt (crash-after-create, before the link write).
    // PRI-624: the state manager MUST be closed on every exit — the Slice C
    // worker calls this seam every cycle, and a leaked handle would pin the
    // workspace state.db for the life of the worker process.
    const stateManager = new RuntimeStateManager({ workspaceDir });
    try {
      await stateManager.initialize();
      const existing = await stateManager.getTask(taskId);
      if (existing === null) {
        const stateDir = path.join(workspaceDir, '.state');
        const config = loadPdConfigForPlugin(workspaceDir);
        if (!config.ok) {
          return { ok: false, reason: `pd_config_invalid:${config.errors[0]?.reason ?? 'unknown'}`, nextAction: config.errors[0]?.nextAction ?? 'Repair .pd/config.yaml and run reconciliation.' };
        }
        const service = new PainToPrincipleService({
          workspaceDir,
          stateDir,
          ledgerAdapter: new PrincipleTreeLedgerAdapter({ stateDir }),
          owner: 'codex-governance',
          asyncMode: true,
          effectiveConfig: config.effective,
          getEnvVar: (name: string) => process.env[name],
        });
        const result = await service.recordPain({
          painId: input.canonicalPainId,
          painType: payloadParsed.painType,
          source: payloadParsed.source,
          reason: payloadParsed.reason,
          score: payloadParsed.score,
          sessionId: payloadParsed.sessionId,
          provenance: 'host_context_bound',
          hostKind: 'codex',
          evidence: [...payloadParsed.evidence],
          recordObservability: true,
        });
        // recordPain (async) leaves a cached bridge holding open SQLite
        // handles; this seam runs per reconciliation cycle under the Slice C
        // worker, so release it immediately (hook processes exit anyway).
        await disposePainSignalBridgesForWorkspace(workspaceDir).catch(() => undefined);
        if (result.status === 'failed') {
          return { ok: false, reason: `task_submit_failed:${(result.message ?? result.failureCategory ?? 'unknown').slice(0, 160)}`, nextAction: 'inspect the diagnostician runtime profile; reconciliation retries task creation without losing the admitted pain' };
        }
      }
      db.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = ?, updated_at = ? WHERE logical_observation_key = ?')
        .run(taskId, new Date().toISOString(), input.logicalObservationKey);
      return {
        ok: true,
        taskId,
        created: existing === null,
        duplicate: existing !== null,
        // The link was just written because the task already existed → a real
        // Case B repair (not a no-op on an already-linked marker).
        linkRepaired: existing !== null,
      };
    } finally {
      await stateManager.close().catch(() => undefined);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_task_ensure_failed:${detail}`, nextAction: 'inspect the workspace state database; reconciliation retries task creation' };
  } finally {
    close();
  }
}

// ─── Evidence promotion for an admitted pain ────────────────────────────────

export type PromoteAdmittedEvidenceResult =
  | { ok: true; promoted: number; tailState: 'completed' | 'pending' }
  | Degradation;

/**
 * Promote the bounded evidence window (≤12 preceding turns + trigger + next
 * completed assistant turn) for an admitted pain, using Slice A's promotion
 * substrate with the canonical pain id as the caller-provided pain reference.
 */
export function promoteAdmittedGovernanceEvidence(input: {
  workspaceDir: string;
  rolloutIdentity: string;
  triggerLogicalKey: string;
  canonicalPainId: string;
  databaseFactory?: ObservationDatabaseFactory;
}): PromoteAdmittedEvidenceResult {
  const result = promoteGovernanceEvidence({
    workspaceDir: input.workspaceDir,
    hostKind: 'codex',
    rolloutIdentity: input.rolloutIdentity,
    triggerLogicalKey: input.triggerLogicalKey,
    painRef: input.canonicalPainId,
    ...(input.databaseFactory ? { databaseFactory: input.databaseFactory } : {}),
  });
  if (!result.ok) return { ok: false, reason: result.reason, nextAction: result.nextAction };
  return { ok: true, promoted: result.promoted, tailState: result.tailState };
}

// ─── Single ensure path: task + evidence promotion ──────────────────────────

export interface EnsureGovernanceContinuationInput {
  readonly workspaceDir: string;
  readonly logicalObservationKey: string;
  readonly canonicalPainId: string;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type EnsureGovernanceContinuationResult =
  | { ok: true; taskId: string; taskCreated: boolean; linkRepaired: boolean; promoted: number; tailState: 'completed' | 'pending' }
  | { ok: false; reason: string; nextAction: string };

/**
 * Given an admitted canonical pain (identified by its marker), ensure both
 * the Diagnostician task AND the evidence promotion exist idempotently.
 * Single ensure path for both fresh admits and crash recovery (already_admitted
 * redelivery). The marker row carries rollout_identity so the function is
 * self-contained (caller only needs workspaceDir, logicalObservationKey, painId).
 */
export async function ensureGovernanceContinuation(input: EnsureGovernanceContinuationInput): Promise<EnsureGovernanceContinuationResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const marker = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ? AND canonical_pain_id = ?').get(input.logicalObservationKey, input.canonicalPainId);
    if (!isRecord(marker)) {
      return { ok: false, reason: 'admission_marker_not_found', nextAction: 'admit the signal before ensuring its continuation' };
    }
    const rolloutIdentity = rowField(marker, 'rollout_identity');
    if (typeof rolloutIdentity !== 'string' || rolloutIdentity.length === 0) {
      return { ok: false, reason: 'marker_missing_rollout_identity', nextAction: 're-admit the signal' };
    }
    // 1. Ensure task (idempotent)
    const ensured = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: input.logicalObservationKey, canonicalPainId: input.canonicalPainId });
    if (!ensured.ok) {
      return { ok: false, reason: ensured.reason, nextAction: ensured.nextAction };
    }
    // 2. Ensure promotion (idempotent substrate — already promoted = no-op,
    //    pending tail = re-complete, never started = start now).
    const promoted = promoteAdmittedGovernanceEvidence({
      workspaceDir,
      rolloutIdentity,
      triggerLogicalKey: input.logicalObservationKey,
      canonicalPainId: input.canonicalPainId,
    });
    if (!promoted.ok) {
      return { ok: false, reason: promoted.reason, nextAction: promoted.nextAction };
    }
    return { ok: true, taskId: ensured.taskId, taskCreated: ensured.created, linkRepaired: ensured.linkRepaired, promoted: promoted.promoted, tailState: promoted.tailState };
  } finally {
    close();
  }
}

// ─── Reconciliation (SPEC §13 crash-gap pass; Slice C worker calls this) ────

export interface ReconcileGovernanceContinuationInput {
  readonly workspaceDir: string;
  /** Bounded work per pass (default 50 admitted pains). */
  readonly limit?: number;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export interface ReconcileGovernanceContinuationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly tasksEnsured: number;
  readonly linksRepaired: number;
  readonly pendingTails: number;
  readonly completedTails: number;
  readonly staleTails: number;
  readonly degradations: readonly string[];
}

/**
 * Narrow idempotent reconciliation between the trajectory admission markers
 * and the Runtime V2 task store (separate SQLite databases — no cross-store
 * transaction exists, SPEC §13). Recovers:
 *  - Case A: pain admitted, crash before task creation → create the task now;
 *  - Case B: task exists, crash before the link write → repair the link;
 *  - Case C: pain+task, crash before promotion → promote evidence now;
 *  - Case D: promotion started → pending tail → retry completion once; stale
 *    tails are reported (never silently dropped).
 * Not a background worker — Slice C's Companion worker and the CLI call this.
 */
export async function reconcileGovernanceContinuation(input: ReconcileGovernanceContinuationInput): Promise<ReconcileGovernanceContinuationResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) {
    return { ok: false, reason: opened.reason, nextAction: opened.nextAction, tasksEnsured: 0, linksRepaired: 0, pendingTails: 0, completedTails: 0, staleTails: 0, degradations: [opened.reason] };
  }
  const { db, close } = opened;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const degradations: string[] = [];
  let tasksEnsured = 0;
  let linksRepaired = 0;
  let pendingTails = 0;
  let completedTails = 0;

  try {
    // Scan ONLY admitted markers that need recovery (bounded). A healthy marker
    // — task linked AND promotion started (observation promoted) — does NOT
    // match this predicate, so it leaves the working set and the pass advances
    // past it. Without this, LIMIT always starts at the oldest admitted marker
    // and markers beyond the batch starve forever (review round 3 P1-2).
    //
    // Recovery needed:
    //   Case A/B: task link missing (crash before task, or before the link write)
    //   Case C:   promotion never started (no observation carries this painRef)
    //
    // A pending tail (promotion started, waiting for the next assistant turn)
    // is NOT a recovery need — it's a forward-looking state resolved by future
    // evidence. The live already_admitted redelivery path (ensureContinuation
    // → promote) handles tail completion when new data arrives; reconcile does
    // not retry pending tails, so pending-tail markers do not block later
    // markers. Stale tails are NOT auto-recoverable (substrate refuses to
    // re-arm them): they are counted separately below and reported.
    const markers = db.prepare(`SELECT a.logical_observation_key, a.canonical_pain_id
      FROM governance_signal_admissions a
      WHERE a.decision = 'admitted'
        AND (
          a.diagnostician_task_id IS NULL
          OR NOT EXISTS (SELECT 1 FROM governance_observations o
              WHERE o.promotion_ref = a.canonical_pain_id)
        )
      ORDER BY a.id LIMIT ?`).all(limit);
    for (const row of markers) {
      const key = rowField(row, 'logical_observation_key');
      const painId = rowField(row, 'canonical_pain_id');
      if (typeof key !== 'string' || typeof painId !== 'string') continue;
      const cont = await ensureGovernanceContinuation({ workspaceDir, logicalObservationKey: key, canonicalPainId: painId });
      if (cont.ok) {
        // Only count REAL actions: a task actually created, a link actually
        // repaired (task existed but the marker link was missing). Healthy
        // no-op markers are excluded by the predicate above, so a healthy
        // pass reports 0/0 (review round 2 P2).
        if (cont.taskCreated) tasksEnsured += 1;
        if (cont.linkRepaired) linksRepaired += 1;
        if (cont.tailState === 'pending') pendingTails += 1;
        else if (cont.tailState === 'completed') completedTails += 1;
      } else {
        degradations.push(`${key}:${cont.reason}`);
      }
    }
    // Also report stale tails scoped to governance admissions.
    const stale = db.prepare(`SELECT COUNT(*) AS n FROM governance_pending_promotion_tails t
      WHERE t.state = 'stale'
        AND EXISTS (SELECT 1 FROM governance_signal_admissions a WHERE a.canonical_pain_id = t.pain_ref)`).get();
    const staleTails = typeof rowField(stale, 'n') === 'number' ? (rowField(stale, 'n') as number) : 0;
    return {
      ok: degradations.length === 0,
      ...(degradations.length > 0 ? { reason: 'reconciliation_degradations', nextAction: 'inspect the per-item degradations; admitted pains and evidence remain durable' } : {}),
      tasksEnsured, linksRepaired, pendingTails, completedTails, staleTails,
      degradations: degradations.slice(0, 10),
    };
  } finally {
    close();
  }
}
