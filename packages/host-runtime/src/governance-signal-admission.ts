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
  computeFeatureFlagsFromConfig,
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
  boundCorrectionEvidenceText,
  MAX_EVIDENCE_VALUE_CHARS,
  type GovernanceHostKind,
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

/** CR-07: rate-limit bucket key for explicit Owner statements (no keyword rule version). */
const EXPLICIT_OWNER_STATEMENT_RULE_VERSION = 9001;
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

/** seed/owner_promoted 词进入高精度 deterministic path 的权重阈值 */
export const HIGH_PRECISION_LEARNED_WEIGHT = 0.7;

/** PRI-788 G3: llm 学习词 earned precision 的 TP 门槛（且要求零 FP） */
export const EARNED_PRECISION_MIN_TP = 3;

/** 高精度纠正短语 overlay(已验证的确定性 STRONG 路径,不属于 learner seed 集) */
export const HIGH_PRECISION_CORRECTION_OVERLAY: readonly (readonly [string, number])[] = [
  ['这是错的', 0.9],
  ['不要自作主张', 0.9],
  ['不应该这么做', 0.9],
  // PRI-788 G3(Owner 批准清单):中文高精度纠正句式
  ['我说的是', 0.9],
  ['不是让你', 0.85],
  ['谁让你', 0.85],
  ['又搞错', 0.8],
  ['都说了', 0.8],
];

/** empathy seed overlay(检测行为不变) */
export const EMPATHY_SEED_OVERLAY: readonly (readonly [string, number])[] = [
  ['搞什么', 0.5],
];

interface LearnedKeywordShape {
  term: string;
  weight: number;
  source: string;
  /** 确认/误报计数（correction-cue-learner 维护）——earned precision 的证据源 */
  truePositiveCount?: number;
  falsePositiveCount?: number;
}

function isValidLearnedKeyword(v: unknown): v is LearnedKeywordShape {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  if (typeof k.term !== 'string' || k.term.length === 0) return false;
  if (typeof k.weight !== 'number' || !Number.isFinite(k.weight)) return false;
  // earned precision 的计数是安全门（tp >= 3 才升 high），必须先约束数值形状：
  // `correction_keywords.json` 里被篡改/损坏的 `truePositiveCount: 3.1` 若放行，
  // 会让只有 3 条样本（甚至根本没有样本）的词项挤进 high 确定性路径。
  // 缺失按可选字段语义放行，存在则必须是【非负安全整数】。
  const isCount = (value: unknown): boolean =>
    value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if (!isCount(k.truePositiveCount) || !isCount(k.falsePositiveCount)) return false;
  return k.source === 'seed' || k.source === 'llm' || k.source === 'user';
}

function mapLearnedSource(source: string): UnifiedKeywordStore['terms'][string]['source'] {
  if (source === 'llm') return 'llm_learned';
  if (source === 'user') return 'owner_promoted';
  return 'seed';
}

/**
 * PRI-788 G3 earned precision：llm 学习词不再恒为 ambiguous——确认证据达标
 * （TP ≥ 3 且零 FP）时升 high，出现任一 FP 即降回 ambiguous。安全姿态不变：
 * LLM 单次建议无法自升 STRONG，必须积累 LLM 确认的正例。owner_promoted 仍按
 * 权重判定（Owner 显式决策不受证据门槛约束）。
 */
function precisionFor(
  source: string,
  weight: number,
  stats?: { truePositiveCount?: number; falsePositiveCount?: number },
): 'high' | 'ambiguous' {
  if (source === 'llm') {
    const tp = stats?.truePositiveCount ?? 0;
    const fp = stats?.falsePositiveCount ?? 0;
    return tp >= EARNED_PRECISION_MIN_TP && fp === 0 ? 'high' : 'ambiguous';
  }
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
      precision: precisionFor(kw.source, weight, kw),
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
    // SPEC-CODEX-PAIN-CLOSURE-001 CR-01: this store also writes tool_calls
    // (admitToolFailure); make sure the host tool-use-id join column exists on
    // workspaces whose base schema predates it (idempotent additive ALTER —
    // only when the table itself exists: governance-only databases without a
    // tool_calls table are a valid pre-existing state, not an error).
    const hasToolCalls = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'").get() !== undefined;
    if (hasToolCalls) {
      try {
        db.exec('ALTER TABLE tool_calls ADD COLUMN tool_use_id TEXT');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('duplicate column name')) throw err;
      }
      try {
        // Additive project scope for live Codex admission rows. Existing rows
        // deliberately remain NULL because their originating cwd is unknown.
        db.exec('ALTER TABLE tool_calls ADD COLUMN project_dir TEXT');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('duplicate column name')) throw err;
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_session_tool_use_id ON tool_calls(session_id, tool_use_id)');
    }
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
  let db: Database.Database | undefined;
  try {
    db = factory ? factory(dbPath) : new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    ensureGovernanceAdmissionSchema(db);
    // The reconciliation pass reads observation-owned tables (promotion
    // tails): one open makes the whole governance schema ready.
    ensureGovernanceSchema(db);
    return { db, close: () => { try { db?.close(); } catch { /* write result already determined */ } } };
  } catch (error) {
    // PRI-624 discipline: a half-opened handle (e.g. a corrupt/non-SQLite
    // file that passes the lazy open but fails the first pragma) must be
    // closed here — the worker retries every cycle, so a leaked handle would
    // pin the workspace trajectory.db (and its temp dir) forever.
    try { db?.close(); } catch { /* best-effort cleanup of an unusable handle */ }
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `trajectory_database_unavailable:${detail}`, nextAction: 'inspect or repair the selected PD trajectory database' };
  }
}

// ─── Candidates and outcomes ────────────────────────────────────────────────

export interface GovernanceCorrectionCandidate {
  readonly kind: 'user_correction';
  readonly hostKind: 'codex' | 'workbuddy';
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly text: string;
  readonly observedAt: string;
  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-02/CR-07: the text is an EXPLICIT Owner
   * statement (native current-user `PD记录痛苦：` prefix). Explicit submissions bypass the
   * STRONG+high-precision keyword gate — the Owner's explicit request is the
   * signal; nothing is inferred. Rate limiting and the unique observation-key
   * dedup still apply unchanged.
   */
  readonly explicitOwnerStatement?: boolean;
  /**
   * Provenance distinction for explicit Codex statements: the native
   * `PD记录痛苦：` prefix (hook-read Owner text, the default) vs the
   * agent-assisted no-prefix entry (`pd pain explicit`, model-transcribed
   * Owner words bound to the host-written live turn context). Audit-only:
   * admission, rate limit and idempotency are identical either way.
   */
  readonly explicitChannel?: 'codex_explicit_prefix' | 'codex_explicit_agent';
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
  /**
   * I1 identity parity: the host's real per-call id (`tool_use_id`). The live
   * handler's canonical derivation includes it, so candidate builders MUST
   * supply it when the host provided one — a candidate without it would derive
   * a second canonical pain for a call the live path already recorded.
   */
  readonly toolCallId?: string;
  /** Host tool-call id (SPEC-CODEX-PAIN-CLOSURE-001 CR-01) — same id the live PostToolUse path records into tool_calls.tool_use_id for the dedup join. */
  readonly toolUseId?: string;
  /** Native host cwd, when supplied by a live hook; absent for transcript catch-up. */
  readonly projectDir?: string;
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
  detection: SignalCollectorOutput | undefined;
  nowIso: string;
}

function insertCorrectionPain({ db, candidate, workspaceDir, painId, detection, nowIso }: CorrectionPainArgs): string {
  const reason = candidate.explicitOwnerStatement === true
    ? candidate.explicitChannel === 'codex_explicit_agent'
      ? 'Codex explicit owner statement (agent-assisted, no prefix)'
      : `${candidate.hostKind === 'workbuddy' ? 'WorkBuddy' : 'Codex'} explicit owner statement (PD记录痛苦 prefix)`
    : detection !== undefined && detection.matchedTerms.length > 0
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
  db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(candidate.rootSessionId, 'user_correction', GOVERNANCE_STRONG_PAIN_SCORE, reason.slice(0, MAX_REASON_BOUND), 'severe', 'system_infer', null, excerpt, painId, null, candidate.hostKind, nowIso);
  return reason;
}

interface GovernanceTaskSubmissionPayload {
  readonly painType: 'user_frustration' | 'tool_failure';
  readonly source: string;
  readonly reason: string;
  readonly score: number;
  readonly sessionId: string;
  /** The admitting host — part of the payload so the Diagnostician sees the real origin. */
  readonly hostKind: GovernanceHostKind;
  readonly evidence: readonly { sourceRef: string; note: string }[];
  /**
   * SPEC-CODEX-PAIN-CLOSURE-001 CR-02: the explicit Owner statement rides as
   * correction evidence (verbatim, classified) — never inside evidence[]
   * pseudo-trace entries and never summarized by an AI.
   */
  readonly correctionEvidence?: { text: string; classification: 'owner_statement'; channel: 'codex_explicit_prefix' | 'codex_explicit_agent' | 'workbuddy_explicit_prefix' };
}

/**
 * ONE builder for the tool_failure task payload shape — the Codex inline
 * admission path and the WorkBuddy bare-pain sweep must produce the SAME
 * shape, differing only in the attributed host and the pain facts.
 */
function toolFailureTaskPayload(fields: {
  hostKind: GovernanceHostKind;
  logicalObservationKey: string;
  sessionId: string;
  toolName: string;
  reason: string;
  score: number;
  workspaceDir: string;
}): string {
  // P1-1 privacy (review round 2): sanitize the FULL text before any
  // truncation — a token crossing the 200-char boundary must be redacted, not
  // split into a fragment that survives verbatim. sanitizeString bounds itself.
  const payload: GovernanceTaskSubmissionPayload = {
    painType: 'tool_failure',
    source: fields.toolName,
    reason: fields.reason || `tool=${fields.toolName}`,
    score: fields.score,
    sessionId: fields.sessionId,
    hostKind: fields.hostKind,
    evidence: [{ sourceRef: `governance_observation:${fields.logicalObservationKey}`, note: sanitizeString(fields.reason || fields.toolName, fields.workspaceDir) }],
  };
  return JSON.stringify(payload);
}

function taskSubmissionPayload(candidate: GovernanceSignalCandidate, workspaceDir: string, details: { reason: string; canonicalPainId?: string }): string {
  const {reason,canonicalPainId} = details;
  if (candidate.kind === 'user_correction') {
    // P1-1 privacy (review round 2): sanitize the FULL text before any
    // truncation — a token crossing the 200-char boundary must be redacted, not
    // split into a fragment that survives verbatim. sanitizeString bounds itself.
    const payload: GovernanceTaskSubmissionPayload = {
      painType: 'user_frustration',
      source: 'user_correction',
      reason: reason || 'User correction detected',
      score: GOVERNANCE_STRONG_PAIN_SCORE,
      sessionId: candidate.rootSessionId,
      hostKind: candidate.hostKind,
      // WorkBuddy explicit intake has no transcript observation to promote.
      // The classified Owner statement is its input basis, not a pseudo-trace.
      evidence: candidate.hostKind === 'workbuddy'
        ? candidate.explicitOwnerStatement === true ? [] : [{
          // WorkBuddy has no governance_observation, anchor to the canonical
          // Pain persisted in this same trajectory.db transaction.
          sourceRef: 'pain_event:' + (canonicalPainId ?? ''),
          note: sanitizeString(candidate.text, workspaceDir),
        }]
        : [{ sourceRef: 'governance_observation:' + candidate.logicalObservationKey, note: sanitizeString(candidate.text, workspaceDir) }],
      // SPEC-CODEX-PAIN-CLOSURE-001 CR-02 (merged from main): an explicit
      // Owner statement rides as classified correction evidence — never
      // summarized by an AI, never inside evidence[] pseudo-trace entries.
      ...(candidate.explicitOwnerStatement === true
        ? { correctionEvidence: candidate.hostKind === 'workbuddy'
          ? { text: boundCorrectionEvidenceText({ text: candidate.text, classification: 'owner_statement', channel: 'workbuddy_explicit_prefix' }, workspaceDir).text, classification: 'owner_statement' as const, channel: 'workbuddy_explicit_prefix' as const }
          : { text: sanitizeString(candidate.text, workspaceDir), classification: 'owner_statement' as const, channel: candidate.explicitChannel === 'codex_explicit_agent' ? 'codex_explicit_agent' as const : 'codex_explicit_prefix' as const } }
        : {}),
    };
    return JSON.stringify(payload);
  }
  return toolFailureTaskPayload({
    hostKind: candidate.hostKind,
    logicalObservationKey: candidate.logicalObservationKey,
    sessionId: candidate.rootSessionId,
    toolName: candidate.toolName,
    reason,
    score: 70,
    workspaceDir,
  });
}

/** The marker identity columns both admission paths (inline candidate and bare-pain sweep) share. */
interface AdmissionMarkerIdentity {
  readonly hostKind: GovernanceHostKind;
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly signalKind: GovernanceSignalKind;
}

interface AdmissionMarkerArgs {
  db: Database.Database;
  identity: AdmissionMarkerIdentity;
  canonicalPainId: string;
  ruleVersion: number | null;
  reason: string;
  payloadJson: string;
  nowIso: string;
}

function insertAdmissionMarker({ db, identity, canonicalPainId, ruleVersion, reason, payloadJson, nowIso }: AdmissionMarkerArgs): void {
  db.prepare(`INSERT INTO governance_signal_admissions
    (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'admitted', ?, NULL, ?, ?, ?, ?, ?)`)
    .run(identity.hostKind, identity.logicalObservationKey, identity.rolloutIdentity, identity.rootSessionId, identity.signalKind, canonicalPainId,
      ruleVersion, reason.slice(0, MAX_REASON_BOUND) || null, payloadJson, nowIso, nowIso);
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
  // SPEC-CODEX-PAIN-CLOSURE-001 CR-07: an EXPLICIT Owner statement
  // (`PD记录痛苦：<text>` in the current Codex message) does not pass through
  // keyword detection at all — the explicit request IS the signal. Ordinary
  // conversation keeps the STRONG+high-precision gate unchanged.
  const isExplicit = candidate.explicitOwnerStatement === true;
  // Detection runs OUTSIDE the write transaction (pure scan of the shared
  // keyword store); its outcome feeds the transaction below. An EXPLICIT
  // statement skips detection entirely — the Owner's explicit request is the
  // signal (CR-07), so there is no detection result and no rule version.
  const detection = isExplicit
    ? undefined
    : evaluateCorrectionSignal({
      workspaceDir,
      text: candidate.text,
      sessionId: candidate.rootSessionId,
      detectedAt: nowIso,
      ...(keywordStore ? { store: keywordStore } : {}),
      ...(onDegradation ? { onDegradation } : {}),
    });
  const isStrongHighPrecision = isExplicit
    || (detection !== undefined
      && detection.output.isSignal
      && detection.output.strength === 'STRONG'
      && detection.output.matchedPrecision === 'high');
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
        // PRI-640 §17: enrich unknown → codex from proven governance lineage;
        // the IS NULL guard keeps any durable attribution (never overwrites).
        db.prepare('UPDATE pain_events SET host_kind = ? WHERE canonical_pain_id = ? AND host_kind IS NULL').run(candidate.hostKind, painId);
      } else {
        // CR-07: explicit submissions carry their own rate-limit bucket
        // (detection never ran — no keyword rule version exists for them).
        const rateLimitRuleVersion = isExplicit ? EXPLICIT_OWNER_STATEMENT_RULE_VERSION : (detection?.ruleVersion ?? EXPLICIT_OWNER_STATEMENT_RULE_VERSION);
        if (!tryConsumeRateLimit({ db, rootSessionId: candidate.rootSessionId, ruleVersion: rateLimitRuleVersion, now })) {
          throw new RateLimitedSignal();
        }
        reason = insertCorrectionPain({ db, candidate, workspaceDir, painId, detection: detection?.output, nowIso });
      }
      insertAdmissionMarker({
        db,
        identity: { hostKind: candidate.hostKind, logicalObservationKey: candidate.logicalObservationKey, rolloutIdentity: candidate.rolloutIdentity, rootSessionId: candidate.rootSessionId, signalKind: candidate.kind },
        canonicalPainId: painId,
        // Merged from main (CR-07): explicit owner statements never ran keyword
        // detection, so `detection` is optional — no ruleVersion exists for them.
        ruleVersion: detection?.ruleVersion ?? null,
        reason,
        payloadJson: taskSubmissionPayload(candidate, workspaceDir, { reason, canonicalPainId: painId }),
        nowIso,
      });
    })();
  } catch (error) {
    if (error instanceof RateLimitedSignal) {
      return { disposition: 'rate_limited', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey };
    }
    throw error;
  }
  return { disposition: 'admitted', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, canonicalPainId: painId, duplicate, ruleVersion: detection?.ruleVersion ?? null };
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
    // I1 identity parity: same call id the live handler derived from (the
    // candidate builder forwards the host `tool_use_id`).
    ...(candidate.toolCallId !== undefined ? { toolCallId: candidate.toolCallId } : {}),
    ...(candidate.toolInput !== undefined ? { toolInput: candidate.toolInput } : {}),
    ...(candidate.toolOutput !== undefined ? { toolOutput: candidate.toolOutput } : {}),
  });
  const { outcome, sanitizedParams, paramsJson, resultPreview, painId } = identity;

  // Admission gate — identical semantics to the live production handler on a
  // fresh process (ADR-0020 accepts cold in-memory cooldowns for Codex;
  // canonical idempotency is the guard).
  const sourceObservation = buildToolFailureObservation({ toolName: candidate.toolName, error: outcome.error, exitCode: outcome.exitCode ?? undefined });
  const sourceKind = resolveSourceKind({
    observedAt: nowIso,
    workspaceId: workspaceDir,
    sessionId: candidate.rootSessionId,
    toolName: candidate.toolName,
    failureSource: sourceObservation.failureSource,
    toolNotFound: sourceObservation.toolNotFound,
    nonZeroExit: outcome.exitCode !== null && outcome.exitCode !== 0,
  });
  // Risk evaluation mirrors the production handler: it reads the RAW params
  // (sanitized params replace paths with placeholders and would lose the
  // absolute-path risk signal). Identity still uses sanitized params.
  const rawFile = isRecord(outcome.params) ? (own(outcome.params, 'file_path') ?? own(outcome.params, 'path')) : undefined;
  const relativePath = String(rawFile ?? 'unknown').slice(0, 500);
  const isRisky = path.isAbsolute(relativePath) && !path.resolve(relativePath).startsWith(`${workspaceDir}${path.sep}`);
  const painScore = Math.min(100, (outcome.failure ? 70 : 0) + (isRisky ? 20 : 0));
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
    // Same duplicate probes as the production handler: the host tool-call id
    // (CR-01) is the stable join key; the content-shape probe stays the
    // fallback for hosts/candidates without ids.
    if (candidate.toolUseId !== undefined
      && db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_use_id = ?').get(candidate.rootSessionId, candidate.toolUseId) !== undefined) {
      duplicate = true;
      duplicateWithoutPain = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) === undefined;
    } else if (db.prepare('SELECT 1 FROM tool_calls WHERE session_id = ? AND tool_name = ? AND params_json = ? AND outcome = ? AND exit_code IS ? AND error_message IS ? AND result_preview IS ?')
      .get(candidate.rootSessionId, candidate.toolName, paramsJson, outcome.outcome, outcome.exitCode, outcome.error ?? null, resultPreview) !== undefined) {
      duplicate = true;
      duplicateWithoutPain = db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) === undefined;
    } else {
      db.prepare(`INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`)
        .run(candidate.rootSessionId, nowIso, nowIso);
      const projectDir = typeof candidate.projectDir === 'string' && path.isAbsolute(candidate.projectDir)
        ? path.resolve(candidate.projectDir)
        : null;
      db.prepare(`INSERT INTO tool_calls (session_id, tool_name, outcome, duration_ms, exit_code, error_type, error_message, gfi_before, gfi_after, params_json, result_preview, created_at, tool_use_id, project_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.rootSessionId, candidate.toolName, outcome.outcome, outcome.durationMs ?? null, outcome.exitCode, outcome.error ? outcome.error.split(/[\s:]/, 1)[0] : null, outcome.error ?? null, null, null, paramsJson, resultPreview, nowIso, candidate.toolUseId ?? null, projectDir);
      reason = `tool=${candidate.toolName}; error=${outcome.error ?? `exit=${outcome.exitCode}`}; path=${relativePath}`;
      db.prepare(`INSERT INTO pain_events (session_id, source, score, reason, severity, origin, confidence, text, canonical_pain_id, runtime_task_id, host_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(candidate.rootSessionId, sourceObservation.failureSource ?? 'tool_failure', painScore, reason, painScore >= 70 ? 'severe' : painScore >= 40 ? 'moderate' : 'mild', 'system_infer', null, null, painId, null, candidate.hostKind, nowIso);
    }
    // PRI-640 §17: enrich unknown → codex on the already-admitted duplicate
    // pain row; the IS NULL guard keeps any durable attribution.
    db.prepare('UPDATE pain_events SET host_kind = ? WHERE canonical_pain_id = ? AND host_kind IS NULL').run(candidate.hostKind, painId);
    if (!duplicateWithoutPain) {
      insertAdmissionMarker({
        db,
        identity: { hostKind: candidate.hostKind, logicalObservationKey: candidate.logicalObservationKey, rolloutIdentity: candidate.rolloutIdentity, rootSessionId: candidate.rootSessionId, signalKind: candidate.kind },
        canonicalPainId: painId,
        ruleVersion: null,
        reason: sanitizeString(reason, workspaceDir),
        payloadJson: taskSubmissionPayload(candidate, workspaceDir, { reason }),
        nowIso,
      });
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
  trustedWorkbuddyLive?: boolean;
}

function admitOne({ db, candidate, workspaceDir, now, nowIso, keywordStore, onDegradation, trustedWorkbuddyLive }: AdmitOneArgs): GovernanceAdmissionOutcome {
  if (candidate.hostKind !== 'codex' && !(candidate.hostKind === 'workbuddy' && candidate.kind === 'user_correction' && (candidate.explicitOwnerStatement === true || trustedWorkbuddyLive === true))) {
    return { ok: false, reason: 'unsupported_host_kind', nextAction: 'governance signal admission accepts Codex observations or explicit WorkBuddy Owner statements' };
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
function admitGovernanceSignalsInternal(input: AdmitGovernanceSignalsInput, trustedWorkbuddyLive = false): AdmitGovernanceSignalsResult {
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
      outcomes.push(admitOne({ db, candidate, workspaceDir, now, nowIso, ...(input.keywordStore ? { keywordStore: input.keywordStore } : {}), ...(input.onDegradation ? { onDegradation: input.onDegradation } : {}), trustedWorkbuddyLive }));
    }
    return { ok: true, outcomes };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `governance_admission_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; committed candidates remain durable' };
  } finally {
    close();
  }
}


/** Public generic intake stays Codex + explicit WorkBuddy only. */
export function admitGovernanceSignals(input: AdmitGovernanceSignalsInput): AdmitGovernanceSignalsResult {
  return admitGovernanceSignalsInternal(input);
}

/** P0: a four-term projection of existing canonical high-precision seeds. */
const WORKBUDDY_AUTO_TERMS = new Set(['这是错的', '不要自作主张', '不应该这么做', '又搞错']);
const WORKBUDDY_MAX_PROMPT_BYTES = 16 * 1024;
function workbuddyP0KeywordStore(): UnifiedKeywordStore {
  const seed = buildSharedSeedKeywordStore();
  const terms: UnifiedKeywordStore['terms'] = {};
  for (const [term, def] of Object.entries(seed.terms)) {
    if (WORKBUDDY_AUTO_TERMS.has(term) && def.category === 'correction' && def.precision === 'high') {
      terms[term] = def;
    }
  }
  return { version: seed.version, terms };
}

/**
 * AUDIT-P3-01 (2026-10-21): WorkBuddy live-keyword 检测接入共享 live 词库
 * （`<workspace>/.state/correction_keywords.json`，seed ∪ learned，mtime 刷新，
 * 文件缺失/损坏降级 seed-only）。返回的是完整共享 store——"只允许 high 精度
 * correction 词触发自动 Pain"由 assess 的 matched 判据（isSignal && STRONG &&
 * correction && matchedPrecision==='high'）与 admitOne 的 isStrongHighPrecision
 * 门共同强制，与 OpenClaw 检测共享同一套 precision 语义（earned-high 需
 * TP≥3 且零 FP；owner_promoted/seed 需权重≥0.7）。
 */
export function resolveSharedCorrectionKeywordStoreForDetection(workspaceDir: string): UnifiedKeywordStore {
  return createSharedCorrectionKeywordStore({ workspaceDir }).resolve();
}

/**
 * Pure check: no DB, no classifier, no historical transcript. The optional
 * store parameter is how the shared live vocabulary enters (AUDIT-P3-01);
 * omitted, the check keeps the P0 four-term projection (backward compatible).
 */
export function assessWorkbuddyLiveKeyword(
  text: string,
  sessionId: string,
  store?: UnifiedKeywordStore,
): {
  matched: boolean; reason: 'matched' | 'not_a_signal' | 'prompt_too_large';
} {
  if (Buffer.byteLength(text, 'utf8') > WORKBUDDY_MAX_PROMPT_BYTES) {
    return { matched: false, reason: 'prompt_too_large' };
  }
  const resolved = store ?? workbuddyP0KeywordStore();
  // Prefer precision to recall: reject quoted/embedded/reported phrases.
  if (!Object.keys(resolved.terms).some(term => text.trimStart().toLowerCase().startsWith(term.toLowerCase()))) {
    return { matched: false, reason: 'not_a_signal' };
  }
  const out = collectSync(text, sessionId, resolved, SYNC_DETECTION_CONFIG, new Date().toISOString());
  const matched = out.isSignal && out.strength === 'STRONG' &&
    out.type === 'correction' && out.matchedPrecision === 'high';
  return { matched, reason: matched ? 'matched' : 'not_a_signal' };
}

/**
 * Narrow native event gateway: validate true current user origin and flags.
 * The ordinary generic admission API cannot bypass this WorkBuddy gate.
 */
export function admitTrustedWorkbuddyLiveCorrection(input: {
  workspaceDir: string;
  rawEvent: unknown;
  now?: Date;
  databaseFactory?: ObservationDatabaseFactory;
}): AdmitGovernanceSignalsResult {
  const raw = input.rawEvent;
  if (!isRecord(raw) || own(raw, 'hook_event_name') !== 'UserPromptSubmit' ||
      own(raw, 'is_internal_continuation') !== false) {
    return { ok: false, reason: 'native_current_user_unverified', nextAction: 'Require a real current WorkBuddy UserPromptSubmit event.' };
  }
  const sessionId = own(raw, 'session_id');
  const generationId = own(raw, 'generation_id');
  const prompt = own(raw, 'prompt');
  if (typeof sessionId !== 'string' || !sessionId.trim() ||
      typeof generationId !== 'string' || !generationId.trim() ||
      typeof prompt !== 'string') {
    return { ok: false, reason: 'native_identity_invalid', nextAction: 'Require nonblank native session_id/generation_id and prompt.' };
  }
  const config = loadPdConfigForPlugin(input.workspaceDir);
  if (!config.ok) return { ok: false, reason: 'workbuddy_config_invalid', nextAction: 'Repair WorkBuddy governance workspace config.' };
  const {flags} = computeFeatureFlagsFromConfig(config.effective);
  if (flags['host.workbuddy']?.enabled !== true || flags.workbuddy_live_keyword_pain?.enabled !== true) {
    return { ok: false, reason: 'workbuddy_auto_disabled', nextAction: 'Explicitly enable both WorkBuddy host and live keyword Pain.' };
  }
  if (prompt.trimStart().startsWith('PD记录痛苦')) {
    return { ok: false, reason: 'explicit_owner_statement_reserved', nextAction: 'Use original Owner intake; no keyword fallback.' };
  }
  // AUDIT-P3-01: 预检与准入共用同一份共享 live 词库（单一真理源）——预检命中
  // 词与 admitOne 的检测判定不会漂移。自动 Pain 仍只允许 high 精度 correction
  // 词（两道门各自强制），无 LLM、无 transcript 读取。
  const sharedStore = resolveSharedCorrectionKeywordStoreForDetection(input.workspaceDir);
  if (!assessWorkbuddyLiveKeyword(prompt, sessionId, sharedStore).matched) {
    return { ok: true, outcomes: [] };
  }
  const nativeIdentity = JSON.stringify(['workbuddy', sessionId, generationId]);
  return admitGovernanceSignalsInternal({
    workspaceDir: input.workspaceDir,
    candidates: [{
      kind: 'user_correction',
      hostKind: 'workbuddy',
      logicalObservationKey: nativeIdentity + '|user',
      rolloutIdentity: JSON.stringify(['workbuddy', sessionId]),
      rootSessionId: sessionId,
      hostTurnId: nativeIdentity,
      text: prompt,
      observedAt: (input.now ?? new Date()).toISOString(),
    }],
    keywordStore: sharedStore,
    ...(input.now ? { now: input.now } : {}),
    ...(input.databaseFactory ? { databaseFactory: input.databaseFactory } : {}),
  }, true);
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
  // The admitting host is part of the frozen payload contract; the Diagnostician
  // attribution must be one of the governed hosts (never free text).
  const hostKind = own(value, 'hostKind');
  if (hostKind !== 'openclaw' && hostKind !== 'codex' && hostKind !== 'workbuddy') return false;
  // CR-02 (merged from main): a validated explicit Owner statement is a
  // first-class input basis — the evidence array may legitimately be empty for
  // such submissions (the statement itself satisfies the empty-input-evidence
  // admission condition).
  const correctionEvidence = own(value, 'correctionEvidence');
  const hasOwnerStatement = isRecord(correctionEvidence)
    && own(correctionEvidence, 'classification') === 'owner_statement'
    && ((own(correctionEvidence, 'channel') === 'codex_explicit_prefix' || own(correctionEvidence, 'channel') === 'codex_explicit_agent') && hostKind === 'codex'
      || own(correctionEvidence, 'channel') === 'workbuddy_explicit_prefix' && hostKind === 'workbuddy')
    && typeof own(correctionEvidence, 'text') === 'string'
    && (own(correctionEvidence, 'text') as string).length > 0;
  if (correctionEvidence !== undefined && !hasOwnerStatement) return false;
  const evidence = own(value, 'evidence');
  if (!Array.isArray(evidence) || (evidence.length === 0 && !hasOwnerStatement) || evidence.length > 8) return false;
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
          // The admitting host comes from the marker's own payload — the ONE
          // durable attribution fact (existing codex markers keep 'codex',
          // workbuddy markers attribute 'workbuddy').
          hostKind: payloadParsed.hostKind,
          evidence: [...payloadParsed.evidence],
          // CR-02: replay the explicit Owner statement verbatim (classified,
          // channel-disclosed) so re-created tasks keep the same input basis.
          ...(payloadParsed.correctionEvidence !== undefined
            ? { correctionEvidence: { ...payloadParsed.correctionEvidence, sessionId: payloadParsed.sessionId } }
            : {}),
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

// ─── Bare host pain admission (review R2/P1, WorkBuddy worker sweep) ────────

export interface AdmitBareHostPainsInput {
  readonly workspaceDir: string;
  /** The bare-pain host to sweep. Only the WorkBuddy worker uses this seam today. */
  readonly hostKind: 'workbuddy';
  /** Bounded work per pass (default 5, aligned with the worker's candidate limit). */
  readonly limit?: number;
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export interface AdmitBareHostPainsResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly nextAction?: string;
  /** Bare pains that got an admission marker in THIS pass. */
  readonly admitted: number;
  /** Diagnostician tasks actually created in THIS pass (crash-safe ensure). */
  readonly ensured: number;
  /** Bare pains below the admission floor — evidence-only by policy. */
  readonly skippedLowScore: number;
  /** Rows that failed the required-field guard (rc-3: counted, never silent). */
  readonly skippedInvalid: number;
  readonly degradations: readonly string[];
}

/**
 * Admit bare host pains — failure rows the shared production pain handler
 * already persisted (host_kind set, canonical_pain_id set, runtime_task_id
 * NULL) but that no inline admission exists for. The WorkBuddy hook is the
 * only evidence producer on that host (SPEC workbuddy-host-adapter §1: no
 * transcript reads), so these rows would otherwise stay stranded as
 * evidence-only forever: reconcile only continues ADMITTED markers, and no
 * WorkBuddy admission step existed (review R2/P1).
 *
 * Policy: only failures scoring at/above the Codex tool_failure admission
 * floor (GOVERNANCE_STRONG_PAIN_SCORE = 70) are queued for diagnosis — that
 * floor is the existing signal-quality boundary for write-tool failures, and
 * lower-scored failures stay evidence-only in pain_events/tool_calls rather
 * than diluting the diagnostician queue. Idempotency reuses the ONE existing
 * authorities: the unique admission marker (canonical_pain_id probe +
 * UNIQUE logical key) and the deterministic task id, so repeated sweeps and
 * crash restarts never mint a second task. Task creation reuses
 * `ensureGovernanceDiagnosticianTask` unchanged (including its Case-B link
 * repair). Evidence promotion is deliberately NOT attempted here: the
 * promotion substrate (governance_rollouts/observations) is fed by transcript
 * ingestion, which the WorkBuddy MVP excludes.
 */
export async function admitBareHostPains(input: AdmitBareHostPainsInput): Promise<AdmitBareHostPainsResult> {
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) {
    return { ok: false, reason: opened.reason, nextAction: opened.nextAction, admitted: 0, ensured: 0, skippedLowScore: 0, skippedInvalid: 0, degradations: [opened.reason] };
  }
  const { db, close } = opened;
  if (!hasProductionPainSchema(db)) {
    close();
    return { ok: false, reason: 'trajectory_schema_invalid', nextAction: 'run the supported PD workspace migration before enabling the worker', admitted: 0, ensured: 0, skippedLowScore: 0, skippedInvalid: 0, degradations: ['trajectory_schema_invalid'] };
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  const workspaceDir = path.resolve(input.workspaceDir);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);

  // Bare pains of this host that no admission marker covers yet. A marker is
  // the durable "already handled" fact; runtime_task_id additionally excludes
  // pains that reached a task through another path.
  const barePainPredicate = `
    FROM pain_events p
    WHERE p.host_kind = ?
      AND p.runtime_task_id IS NULL
      AND p.canonical_pain_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM governance_signal_admissions a WHERE a.canonical_pain_id = p.canonical_pain_id)`;

  try {
    const lowScoreRow = db.prepare(`SELECT COUNT(*) AS n ${barePainPredicate} AND p.score < ?`).get(input.hostKind, GOVERNANCE_STRONG_PAIN_SCORE);
    const skippedLowScore = typeof rowField(lowScoreRow, 'n') === 'number' ? (rowField(lowScoreRow, 'n') as number) : 0;

    const rows = db.prepare(`SELECT p.canonical_pain_id, p.session_id, p.source, p.score, p.reason ${barePainPredicate} AND p.score >= ? ORDER BY p.id LIMIT ?`)
      .all(input.hostKind, GOVERNANCE_STRONG_PAIN_SCORE, limit);

    let admitted = 0;
    let ensured = 0;
    let skippedInvalid = 0;
    const degradations: string[] = [];
    const freshMarkers: { logicalObservationKey: string; canonicalPainId: string }[] = [];

    for (const row of rows) {
      const painId = rowField(row, 'canonical_pain_id');
      const sessionId = rowField(row, 'session_id');
      const score = rowField(row, 'score');
      if (typeof painId !== 'string' || painId.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0
        || typeof score !== 'number' || !Number.isFinite(score)) {
        skippedInvalid += 1;
        continue;
      }
      const logicalObservationKey = `${input.hostKind}|${sessionId}|${painId}`;
      const reason = typeof rowField(row, 'reason') === 'string' ? (rowField(row, 'reason') as string) : '';
      const source = typeof rowField(row, 'source') === 'string' ? (rowField(row, 'source') as string) : 'tool_failure';
      // The pain row carries the tool name only inside its reason prefix
      // (`tool=<name>; ...` — the production writer's format); the row's
      // source column is the failure class, used as the fallback.
      const toolName = /^tool=([^;]{1,120});/.exec(reason)?.[1] ?? source;

      const inserted = db.transaction((): boolean => {
        // Re-probe inside the transaction: a concurrent sweep or live admission
        // may have marked this pain between the scan and this write.
        if (db.prepare('SELECT 1 FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) !== undefined) return false;
        insertAdmissionMarker({
          db,
          identity: { hostKind: input.hostKind, logicalObservationKey, rolloutIdentity: sessionId, rootSessionId: sessionId, signalKind: 'tool_failure' },
          canonicalPainId: painId,
          ruleVersion: null,
          reason,
          payloadJson: toolFailureTaskPayload({ hostKind: input.hostKind, logicalObservationKey, sessionId, toolName, reason, score, workspaceDir }),
          nowIso,
        });
        return true;
      })();
      if (inserted) {
        admitted += 1;
        freshMarkers.push({ logicalObservationKey, canonicalPainId: painId });
      }
    }

    // Reuse the crash-safe ensure semantics unchanged: deterministic task id,
    // task-store PK idempotency, Case-B link repair.
    for (const marker of freshMarkers) {
      const continuation = await ensureGovernanceDiagnosticianTask({
        workspaceDir,
        logicalObservationKey: marker.logicalObservationKey,
        canonicalPainId: marker.canonicalPainId,
        ...(input.databaseFactory ? { databaseFactory: input.databaseFactory } : {}),
      });
      if (continuation.ok) {
        if (continuation.created) ensured += 1;
      } else {
        degradations.push(`${marker.logicalObservationKey}:${continuation.reason}`);
      }
    }

    return {
      ok: degradations.length === 0,
      ...(degradations.length > 0 ? { reason: 'bare_pain_admission_degradations', nextAction: 'inspect the per-item degradations; the admitted pains and markers remain durable and reconcile retries task creation' } : {}),
      admitted, ensured, skippedLowScore, skippedInvalid,
      degradations: degradations.slice(0, 10),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `bare_pain_admission_failed:${detail}`, nextAction: 'inspect the workspace trajectory database and retry; committed markers remain durable', admitted: 0, ensured: 0, skippedLowScore: 0, skippedInvalid: 0, degradations: [`bare_pain_admission_failed:${detail}`] };
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
    // Case C/D (promotion recovery) is scoped to the hosts whose evidence
    // substrate it exists for: the promotion rows come from transcript
    // ingestion (governance_rollouts/observations), which only Codex feeds.
    // A WorkBuddy marker is COMPLETE with task+link — its hook is the only
    // evidence producer and the MVP excludes transcript reads, so demanding a
    // promotion row would degrade reconciliation with rollout_not_found
    // forever (review R2/P1).
    //
    // A pending tail (promotion started, waiting for the next assistant turn)
    // is NOT a recovery need — it's a forward-looking state resolved by future
    // evidence. The live already_admitted redelivery path (ensureContinuation
    // → promote) handles tail completion when new data arrives; reconcile does
    // not retry pending tails, so pending-tail markers do not block later
    // markers. Stale tails are NOT auto-recoverable (substrate refuses to
    // re-arm them): they are counted separately below and reported.
    const markers = db.prepare(`SELECT a.logical_observation_key, a.canonical_pain_id, a.host_kind
      FROM governance_signal_admissions a
      WHERE a.decision = 'admitted'
        AND (
          a.diagnostician_task_id IS NULL
          OR (a.host_kind = 'codex'
              AND NOT EXISTS (SELECT 1 FROM governance_observations o
                  WHERE o.promotion_ref = a.canonical_pain_id))
        )
      ORDER BY a.id LIMIT ?`).all(limit);
    for (const row of markers) {
      const key = rowField(row, 'logical_observation_key');
      const painId = rowField(row, 'canonical_pain_id');
      if (typeof key !== 'string' || typeof painId !== 'string') continue;
      // WorkBuddy (and any future no-transcript host) markers continue through
      // the task-ensure seam ONLY: there is no promotion substrate to recover,
      // and routing them through ensureGovernanceContinuation would report a
      // permanent rollout_not_found degradation despite a healthy task link.
      if (rowField(row, 'host_kind') !== 'codex') {
        const ensured = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: key, canonicalPainId: painId });
        if (ensured.ok) {
          if (ensured.created) tasksEnsured += 1;
          if (ensured.linkRepaired) linksRepaired += 1;
        } else {
          degradations.push(`${key}:${ensured.reason}`);
        }
        continue;
      }
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

// ─── Read-only admission counts (Slice D, SPEC rev 2 §15 health) ────────────

export interface GovernanceAdmissionCounts {
  readonly admitted: number;
  /** Admitted pains with no Diagnostician task link — the §15 orphan count. */
  readonly admittedWithoutTask: number;
  readonly pendingTails: number;
  readonly staleTails: number;
  readonly completedTails: number;
  readonly lastAdmissionAt: string | null;
}

export type ReadGovernanceAdmissionCountsResult =
  | { ok: true; counts: GovernanceAdmissionCounts }
  | { ok: false; reason: string; nextAction: string };

/**
 * Bounded read-only counts for the §15 health surface: admitted-pain-without-
 * task count and promotion-tail states. Read-only — reconciliation itself
 * stays in `reconcileGovernanceContinuation`.
 */
export function readGovernanceAdmissionCounts(args: { workspaceDir: string; databaseFactory?: ObservationDatabaseFactory }): ReadGovernanceAdmissionCountsResult {
  const opened = openAdmissionStore(args.workspaceDir, args.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const admissions = db.prepare(`SELECT
        SUM(CASE WHEN decision = 'admitted' THEN 1 ELSE 0 END) AS admitted,
        SUM(CASE WHEN decision = 'admitted' AND diagnostician_task_id IS NULL THEN 1 ELSE 0 END) AS admitted_without_task,
        MAX(created_at) AS last_admission
      FROM governance_signal_admissions`).get();
    if (!isRecord(admissions)) {
      return { ok: false, reason: 'governance_admission_counts_unavailable', nextAction: 'Inspect the governance_signal_admissions table in the workspace trajectory.db.' };
    }
    const numberOr = (value: unknown): number => (typeof value === 'number' ? value : 0);
    const stringOr = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
    const tails = db.prepare(`SELECT
        SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state = 'stale' THEN 1 ELSE 0 END) AS stale,
        SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM governance_pending_promotion_tails`).get();
    const tailRow = isRecord(tails) ? tails : {};
    return {
      ok: true,
      counts: {
        admitted: numberOr(own(admissions, 'admitted')),
        admittedWithoutTask: numberOr(own(admissions, 'admitted_without_task')),
        pendingTails: numberOr(own(tailRow, 'pending')),
        staleTails: numberOr(own(tailRow, 'stale')),
        completedTails: numberOr(own(tailRow, 'completed')),
        lastAdmissionAt: stringOr(own(admissions, 'last_admission')),
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
    return { ok: false, reason: `governance_admission_counts_failed:${detail}`, nextAction: 'Inspect the workspace trajectory.db; the health surface degraded without mutating anything.' };
  } finally {
    close();
  }
}
