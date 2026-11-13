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
 *   PainToPrincipleService async mode (Runtime task authority), with the
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
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  collectSync,
  computeFeatureFlagsFromConfig,
  CORRECTION_SEED_KEYWORDS,
  PainToPrincipleService,
  PrincipleTreeLedgerAdapter,
  RuntimeStateManager,
  createDiagnosticianTaskId,
  disposePainSignalBridgesForWorkspace,
  sanitizeString,
  boundCorrectionEvidenceText,
  MAX_EVIDENCE_VALUE_CHARS,
  evaluateStage2ConfidenceGate,
  evaluatePainIngress,
  migrateLegacyGfiSchema,
  STAGE2_MAX_ATTEMPTS,
  PENDING_CANDIDATE_TTL_MS,
  type GovernanceHostKind,
  type IngressEvidenceEntry,
  type PainIngressReport,
  type PainProvenance,
  type LlmClassificationResult,
  type SignalCollectorConfig,
  type SignalCollectorOutput,
  type Stage2GateVerdict,
  type UnifiedKeywordStore,
} from '@principles/core/runtime';
import {
  deriveProductionCorrectionPainIdentity,
  hasProductionPainSchema,
} from './production-pain-evidence.js';
import { promoteGovernanceEvidence, ensureGovernanceSchema, type ObservationDatabaseFactory } from './governance-observation-store.js';
import { loadPdConfigForPlugin } from './pd-config.js';
import { resolveTrajectoryDbPath } from '@principles/core/runtime/storage-paths';

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

/** 高精度纠正短语 overlay(已验证的确定性 STRONG 路径,不属于 learner seed 集) */
export const HIGH_PRECISION_CORRECTION_OVERLAY: readonly (readonly [string, number])[] = [
  ['这是错的', 0.9],
  ['不要自作主张', 0.9],
  ['不应该这么做', 0.9],
  // PRI-788 G3(Owner 批准清单):中文高精度纠正句式
  ['不是让你', 0.85],
  ['谁让你', 0.85],
  ['又搞错', 0.8],
];

/**
 * SPEC v0.3 §3.2.1 降级词：口语高频、可被嵌入引用或否定句，不构成 high。
 * 它们仍是候选（进入 Stage 2），但永不直达 STRONG。
 */
export const AMBIGUOUS_CORRECTION_OVERLAY: readonly (readonly [string, number])[] = [
  ['我说的是', 0.9],
  ['都说了', 0.8],
  // 2026-11-13 真实宿主回归（P1-1）：Owner「这种没有数据支撑的激进改动我不
  // 接受。以后改配置参数前，先说明依据和影响，等我确认后再动手。」在零命中
  // 预算下被漏检。以下只作候选（precision=ambiguous），必须经 Stage2 LLM 确认，
  // 不得直达 STRONG；普通否定句仍可能被 LLM 判为 none。
  ['不接受', 0.6],
  ['我不同意', 0.6],
  ['我没让你', 0.6],
  ['没有让你', 0.6],
  ['未经确认', 0.5],
  ['先别执行', 0.6],
  ['没有依据', 0.5],
  ['这不是我要求的', 0.7],
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
 * SPEC v0.3 §3.2.3（D5）：llm 学习词永不自升 high。历史 TP/FP 计数可以保留为
 * 学习证据，但「TP≥3 且零 FP → 直通」的 PRI-788 G3 行为被显式逆转：学习词
 * 只能作为 Stage 2 优先候选，由 LLM 分类 + 统一准入判断。
 * owner_promoted（Owner 显式决策）一般按权重判定，但降级词例外。
 */
const ALWAYS_AMBIGUOUS_TERMS: ReadonlySet<string> = new Set(AMBIGUOUS_CORRECTION_OVERLAY.map(([term]) => term));

function precisionFor(source: string, term: string, weight: number): 'high' | 'ambiguous' {
  // SPEC v0.3 §3.2.1: 降级词无论来源（含 owner_promoted）都只能作候选。
  if (ALWAYS_AMBIGUOUS_TERMS.has(term)) return 'ambiguous';
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
      weight,
      precision: precisionFor(kw.source, term, weight),
      source: mapLearnedSource(kw.source),
    };
    if (kw.source === 'llm') learnedCount += 1;
  }
  return { terms, learnedCount };
}

export function buildSharedSeedKeywordStore(): UnifiedKeywordStore {
  const terms: UnifiedKeywordStore['terms'] = {};
  for (const [term, weight] of HIGH_PRECISION_CORRECTION_OVERLAY) {
    terms[term] = { term, weight, precision: 'high', source: 'seed' };
  }
  for (const [term, weight] of AMBIGUOUS_CORRECTION_OVERLAY) {
    if (Object.hasOwn(terms, term)) continue;
    terms[term] = { term, weight, precision: 'ambiguous', source: 'seed' };
  }
  for (const kw of CORRECTION_SEED_KEYWORDS) {
    if (Object.hasOwn(terms, kw.term)) continue;
    terms[kw.term] = {
      term: kw.term,
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
    // SPEC-CODEX-PAIN-CLOSURE-001 CR-01: trajectory evidence writers persist
    // tool_calls; make sure the host tool-use-id join column exists on
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
      try {
        // SPEC-RULECODE-HOST-PROMOTION-001 R2: additive producer host
        // attribution; legacy rows stay NULL (unprovable, never backfilled).
        db.exec('ALTER TABLE tool_calls ADD COLUMN host_kind TEXT');
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
  const dbPath = resolveTrajectoryDbPath(workspaceDir);
  if (!fs.existsSync(dbPath)) {
    return { ok: false, reason: 'trajectory_db_not_found', nextAction: 'initialize the selected PD workspace (pd runtime init) before enabling conversation ingestion' };
  }
  let db: Database.Database | undefined;
  try {
    db = factory ? factory(dbPath) : new Database(dbPath);
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    ensureGovernanceAdmissionSchema(db);
    // GFI-COMPLETE-REMOVAL-001: the additive governance open does not retire
    // the GFI columns, so a v1 workspace would be judged non-canonical by
    // hasProductionPainSchema and refused. Converge it here with the SAME
    // migration the other raw open paths use (idempotent, no-op on v2).
    migrateLegacyGfiSchema(db);
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
  readonly explicitChannel?: 'codex_explicit_prefix' | 'codex_explicit_agent' | 'workbuddy_explicit_prefix';
}

export type GovernanceSignalCandidate = GovernanceCorrectionCandidate;

export type GovernanceAdmissionOutcome =
  | { disposition: 'admitted'; kind: GovernanceSignalKind; logicalObservationKey: string; canonicalPainId: string; duplicate: boolean; ruleVersion: number | null }
  | { disposition: 'already_admitted'; kind: GovernanceSignalKind; logicalObservationKey: string; canonicalPainId: string; diagnosticianTaskId: string | null }
  | { disposition: 'not_a_signal'; kind: 'user_correction'; logicalObservationKey: string }
  | { disposition: 'rate_limited'; kind: 'user_correction'; logicalObservationKey: string }
  /** Ambiguous Stage-1 candidate persisted for Stage 2 review (SPEC §4.4.8). */
  | { disposition: 'pending_llm_review'; kind: 'user_correction'; logicalObservationKey: string; duplicate: boolean }
  /** Redelivery of a candidate that already reached a non-admitted terminal state. */
  | { disposition: 'resolved_none' | 'abandoned'; kind: 'user_correction'; logicalObservationKey: string; reason: string | null }
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
  reason: string;
  nowIso: string;
}

/** ONE reason builder for inline admission and the pending→admitted transition. */
function correctionReason(candidate: GovernanceCorrectionCandidate, matchedTerms: readonly string[]): string {
  if (candidate.explicitOwnerStatement === true) {
    return candidate.explicitChannel === 'codex_explicit_agent'
      ? 'Codex explicit owner statement (agent-assisted, no prefix)'
      : `${candidate.hostKind === 'workbuddy' ? 'WorkBuddy' : 'Codex'} explicit owner statement (PD记录痛苦 prefix)`;
  }
  return matchedTerms.length > 0
    ? `User correction detected: ${matchedTerms.join(', ')}`
    : 'User correction detected';
}

function insertCorrectionPain({ db, candidate, workspaceDir, painId, reason, nowIso }: CorrectionPainArgs): string {
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
 * P1 (review round 3): a `behavior_trace` may only name a row that EXISTS in
 * trajectory.db with the SAME lineage tuple. WorkBuddy currently has no
 * observation writer, so an automatic WorkBuddy correction usually has no
 * persisted behavior evidence and evaluates to `observation_only`. Never
 * synthesize a trace from the Pain id, prompt text, session id, or logical key.
 */
function persistedBehaviorTraceEvidence(args: {
  db: Database.Database;
  hostKind: GovernanceHostKind;
  logicalObservationKey: string;
  rolloutIdentity: string;
  rootSessionId: string;
  hostTurnId: string;
  text: string;
  workspaceDir: string;
}): IngressEvidenceEntry[] {
  const row = args.db.prepare(`SELECT visible_text FROM governance_observations
    WHERE logical_key = ? AND host_kind = ? AND rollout_identity = ? AND root_session_id = ? AND host_turn_id = ?`)
    .get(args.logicalObservationKey, args.hostKind, args.rolloutIdentity, args.rootSessionId, args.hostTurnId);
  if (!isRecord(row)) return [];
  // The durable observation is the authority for the note: it was sanitized at
  // ingestion. Only when it carries no text do we sanitize the caller's copy.
  const storedText = rowField(row, 'visible_text');
  return [{
    kind: 'behavior_trace',
    sourceRef: `governance_observation:${args.logicalObservationKey}`,
    note: typeof storedText === 'string' ? storedText : sanitizeString(args.text, args.workspaceDir),
  }];
}

function buildTaskSubmissionPayload(candidate: GovernanceCorrectionCandidate, workspaceDir: string, details: { reason: string; db: Database.Database }): GovernanceTaskSubmissionPayload {
  const {reason,db} = details;
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
    evidence: persistedBehaviorTraceEvidence({
      db,
      hostKind: candidate.hostKind,
      logicalObservationKey: candidate.logicalObservationKey,
      rolloutIdentity: candidate.rolloutIdentity,
      rootSessionId: candidate.rootSessionId,
      hostTurnId: candidate.hostTurnId,
      text: candidate.text,
      workspaceDir,
    }),
    // SPEC-CODEX-PAIN-CLOSURE-001 CR-02 (merged from main): an explicit
    // Owner statement rides as classified correction evidence — never
    // summarized by an AI, never inside evidence[] pseudo-trace entries.
    ...(candidate.explicitOwnerStatement === true
      ? { correctionEvidence: candidate.hostKind === 'workbuddy'
        ? { text: boundCorrectionEvidenceText({ text: candidate.text, classification: 'owner_statement', channel: 'workbuddy_explicit_prefix' }, workspaceDir).text, classification: 'owner_statement' as const, channel: 'workbuddy_explicit_prefix' as const }
        : { text: sanitizeString(candidate.text, workspaceDir), classification: 'owner_statement' as const, channel: candidate.explicitChannel === 'codex_explicit_agent' ? 'codex_explicit_agent' as const : 'codex_explicit_prefix' as const } }
      : {}),
  };
  return payload;
}

function taskSubmissionPayload(candidate: GovernanceSignalCandidate, workspaceDir: string, details: { reason: string; db: Database.Database }): string {
  return JSON.stringify(buildTaskSubmissionPayload(candidate, workspaceDir, details));
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

// ─── Pending LLM review state machine (SPEC v0.3 §4.4 / §4.4.8) ─────────────
//
// Ambiguous Stage-1 candidates are no longer silently dropped: they get a
// `pending_llm_review` marker in the SAME table (zero DDL). The marker's
// `task_payload_json` carries two lifecycle shapes:
//  - pending:   { kind:'pending_llm_review', task_payload, review, trigger }
//  - terminal:  { kind:'pending_review_terminal', decision, reason, ... }
// `isGovernanceTaskPayload` rejects both shapes, so a pending/terminal row can
// never be mistaken for an admitted task payload (fail-loud at ensure time).

/** A claim older than this may be re-claimed (worker crashed mid-review). */
const PENDING_REVIEW_CLAIM_TTL_MS = 10 * 60 * 1000;

interface Stage2ReviewRecord {
  readonly verdict: Stage2GateVerdict;
  readonly confidence: number | null;
  readonly reason: string;
}

interface PendingReviewMeta {
  attempts: number;
  ruleVersion: number | null;
  claimedAt?: string;
  /**
   * Fencing token for the claim (`claimedAt` stays the TTL clock only).
   * Every write that depends on current claim ownership must present the
   * identical token; a worker whose claim was taken over is rejected instead
   * of overwriting the new owner's state.
   */
  claimToken?: string;
  lastAttemptAt?: string;
  lastReason?: string;
  reviewResult?: Stage2ReviewRecord;
}

interface PendingReviewPayload {
  readonly kind: 'pending_llm_review';
  /**
   * Canonical pain id derived from host identity facts BEFORE review. Persisted
   * so admission at settle time uses the identical id even though
   * `trigger.text` may have been sanitized/bounded (rc-6).
   */
  readonly pain_id: string;
  readonly task_payload: GovernanceTaskSubmissionPayload;
  readonly review: PendingReviewMeta;
  readonly trigger: {
    readonly text: string;
    readonly matchedTerms: readonly string[];
    readonly hostTurnId: string;
  };
}

/** Internal control-flow signal for a lost pending CAS race. */
class PendingCasLost extends Error {
  constructor() {
    super('pending_cas_lost');
    this.name = 'PendingCasLost';
  }
}

export interface PendingCorrectionCandidate {
  readonly logicalObservationKey: string;
  readonly hostKind: 'codex' | 'workbuddy';
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly text: string;
  readonly matchedTerms: readonly string[];
  readonly attempts: number;
  readonly claimedAt: string | null;
  readonly claimToken: string | null;
  readonly reviewResult: Stage2ReviewRecord | null;
  readonly createdAt: string;
}

function parsePendingReviewMeta(value: unknown): PendingReviewMeta | null {
  if (!isRecord(value)) return null;
  const attempts = own(value, 'attempts');
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0) return null;
  const ruleVersion = own(value, 'ruleVersion');
  if (ruleVersion !== null && ruleVersion !== undefined && (typeof ruleVersion !== 'number' || !Number.isSafeInteger(ruleVersion))) return null;
  const claimedAt = own(value, 'claimedAt');
  if (claimedAt !== undefined && typeof claimedAt !== 'string') return null;
  const claimToken = own(value, 'claimToken');
  if (claimToken !== undefined && typeof claimToken !== 'string') return null;
  const lastAttemptAt = own(value, 'lastAttemptAt');
  if (lastAttemptAt !== undefined && typeof lastAttemptAt !== 'string') return null;
  const lastReason = own(value, 'lastReason');
  if (lastReason !== undefined && typeof lastReason !== 'string') return null;

  const reviewRaw = own(value, 'reviewResult');
  let reviewResult: Stage2ReviewRecord | undefined;
  if (reviewRaw !== undefined) {
    if (!isRecord(reviewRaw)) return null;
    const verdict = own(reviewRaw, 'verdict');
    if (verdict !== 'correction' && verdict !== 'none'
      && verdict !== 'pending_low_confidence' && verdict !== 'pending_llm_error') return null;
    const confidence = own(reviewRaw, 'confidence');
    if (confidence !== null && (typeof confidence !== 'number' || !Number.isFinite(confidence))) return null;
    const normalizedConfidence: number | null = typeof confidence === 'number' ? confidence : null;
    const reason = own(reviewRaw, 'reason');
    if (typeof reason !== 'string') return null;
    reviewResult = { verdict, confidence: normalizedConfidence, reason };
  }

  return {
    attempts,
    ruleVersion: typeof ruleVersion === 'number' ? ruleVersion : null,
    ...(typeof claimedAt === 'string' ? { claimedAt } : {}),
    ...(typeof claimToken === 'string' ? { claimToken } : {}),
    ...(typeof lastAttemptAt === 'string' ? { lastAttemptAt } : {}),
    ...(typeof lastReason === 'string' ? { lastReason } : {}),
    ...(reviewResult !== undefined ? { reviewResult } : {}),
  };
}

function parsePendingReviewPayload(raw: unknown): PendingReviewPayload | null {
  if (!isRecord(raw)) return null;
  if (own(raw, 'kind') !== 'pending_llm_review') return null;
  const painId = own(raw, 'pain_id');
  if (typeof painId !== 'string' || painId.length === 0) return null;
  const taskPayload = own(raw, 'task_payload');
  // Declared later in this module (function declaration, hoisted); the shape
  // guard is the single validator shared with ensureGovernanceDiagnosticianTask.
  // eslint-disable-next-line @typescript-eslint/no-use-before-define
  if (!isGovernanceTaskPayload(taskPayload)) return null;
  const review = parsePendingReviewMeta(own(raw, 'review'));
  if (review === null) return null;
  const trigger = own(raw, 'trigger');
  if (!isRecord(trigger)) return null;
  const text = own(trigger, 'text');
  const hostTurnId = own(trigger, 'hostTurnId');
  const matchedTerms = own(trigger, 'matchedTerms');
  if (typeof text !== 'string' || typeof hostTurnId !== 'string' || !Array.isArray(matchedTerms)) return null;
  const normalizedTerms: string[] = [];
  for (const term of matchedTerms) {
    if (typeof term !== 'string') return null;
    normalizedTerms.push(term);
  }
  return {
    kind: 'pending_llm_review',
    pain_id: painId,
    task_payload: taskPayload,
    review,
    trigger: { text, matchedTerms: normalizedTerms, hostTurnId },
  };
}

function buildPendingReviewPayload(args: {
  candidate: GovernanceCorrectionCandidate;
  workspaceDir: string;
  db: Database.Database;
  painId: string;
  matchedTerms: readonly string[];
  ruleVersion: number | null;
}): PendingReviewPayload {
  const {candidate,workspaceDir,db,painId,matchedTerms,ruleVersion} = args;
  const reason = correctionReason(candidate, matchedTerms);
  return {
    kind: 'pending_llm_review',
    pain_id: painId,
    task_payload: buildTaskSubmissionPayload(candidate, workspaceDir, { reason, db }),
    review: { attempts: 0, ruleVersion, lastReason: 'ambiguous_candidate' },
    trigger: {
      text: sanitizeString(candidate.text, workspaceDir),
      matchedTerms: [...matchedTerms],
      hostTurnId: candidate.hostTurnId,
    },
  };
}

/**
 * @deprecated SPEC v0.3 §3.2.3 (D5) retired earned precision: learned keywords
 * are Stage-2 candidates only. This constant is retained ONLY for public API
 * compatibility; no admission code consults it.
 */
export const EARNED_PRECISION_MIN_TP = 3;

function pendingTerminalPayload(args: {
  decision: 'resolved_none' | 'abandoned';
  reason: string;
  attempts: number;
  confidence: number | null;
  nowIso: string;
}): string {
  // D6: the Owner-approved minimal terminal field set. No trigger text,
  // matchedTerms, reviewResult, or other classification detail survives.
  return JSON.stringify({
    decision: args.decision,
    reason: args.reason,
    confidence: args.confidence,
    attempts: args.attempts,
    settledAt: args.nowIso,
  });
}

// ─── PainIngress facts for automatic corrections (SPEC v0.3 §5) ─────────────

interface CorrectionIngressFacts {
  readonly hostKind: 'codex' | 'workbuddy';
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly painId: string;
  readonly reason: string;
  readonly evidence: readonly IngressEvidenceEntry[];
}

/**
 * Build the ONE PainIngressReport for an automatic keyword/Stage-2 correction.
 * Evidence is always present (the trigger text), so a bound automatic signal
 * evaluates to `submit` — the mapping must never degrade it to
 * observation_only (SPEC §5 hard requirement).
 */
function buildCorrectionIngressReport(facts: CorrectionIngressFacts): PainIngressReport {
  const [first, ...rest] = facts.evidence;
  const bundle: PainIngressReport['evidence'] = first === undefined
    ? { status: 'unavailable', reason: 'evidence_invalid' }
    : { status: 'available', entries: [first, ...rest] };
  const correlation: PainIngressReport['correlation'] = facts.hostKind === 'codex'
    ? {
      status: 'bound',
      hostKind: 'codex',
      rootSessionId: facts.rootSessionId,
      rolloutIdentity: facts.rolloutIdentity,
      logicalObservationKey: facts.logicalObservationKey,
      hostTurnId: facts.hostTurnId,
    }
    : {
      status: 'bound',
      hostKind: 'workbuddy',
      sessionId: facts.rootSessionId,
      logicalObservationKey: facts.logicalObservationKey,
    };
  return {
    identity: { kind: 'host_observation', observationId: facts.painId },
    painType: 'user_frustration',
    source: 'user_correction',
    reason: facts.reason,
    score: GOVERNANCE_STRONG_PAIN_SCORE,
    origin: {
      kind: 'automatic_hook',
      source: facts.hostKind === 'codex' ? 'codex:user_prompt' : 'workbuddy:user_prompt_submit',
    },
    correlation,
    evidence: bundle,
  };
}

interface OwnerCorrectionIngressFacts {
  readonly hostKind: 'codex' | 'workbuddy';
  readonly channel: 'codex_explicit_prefix' | 'codex_explicit_agent' | 'workbuddy_explicit_prefix';
  readonly logicalObservationKey: string;
  readonly rolloutIdentity: string;
  readonly rootSessionId: string;
  readonly hostTurnId: string;
  readonly painId: string;
  readonly reason: string;
  readonly evidence: readonly IngressEvidenceEntry[];
}

/**
 * SPEC v0.3 §5: an explicit Owner statement is `owner_manual`, keeps its
 * correctionEvidence channel, and uses `manual_pain_id` identity — it must
 * never be rebuilt as an automatic hook. Bound owner reports with no transcript
 * evidence legitimately evaluate to `degrade`, never `observation_only`.
 */
function buildOwnerCorrectionIngressReport(facts: OwnerCorrectionIngressFacts): PainIngressReport {
  const [first, ...rest] = facts.evidence;
  const bundle: PainIngressReport['evidence'] = first === undefined
    ? { status: 'unavailable', reason: 'trajectory_unavailable' }
    : { status: 'available', entries: [first, ...rest] };
  const correlation: PainIngressReport['correlation'] = facts.hostKind === 'codex'
    ? {
      status: 'bound',
      hostKind: 'codex',
      rootSessionId: facts.rootSessionId,
      rolloutIdentity: facts.rolloutIdentity,
      logicalObservationKey: facts.logicalObservationKey,
      hostTurnId: facts.hostTurnId,
    }
    : {
      status: 'bound',
      hostKind: 'workbuddy',
      sessionId: facts.rootSessionId,
      logicalObservationKey: facts.logicalObservationKey,
    };
  return {
    identity: { kind: 'manual_pain_id', painId: facts.painId },
    painType: 'user_frustration',
    source: 'user_correction',
    reason: facts.reason,
    score: GOVERNANCE_STRONG_PAIN_SCORE,
    origin: { kind: 'owner_manual', channel: facts.channel },
    correlation,
    evidence: bundle,
  };
}

function ownerExplicitChannel(candidate: GovernanceCorrectionCandidate): 'codex_explicit_prefix' | 'codex_explicit_agent' | 'workbuddy_explicit_prefix' {
  if (candidate.explicitChannel !== undefined) return candidate.explicitChannel;
  return candidate.hostKind === 'workbuddy' ? 'workbuddy_explicit_prefix' : 'codex_explicit_prefix';
}

function correctionIngressEvidence(args: {
  db: Database.Database;
  hostKind: 'codex' | 'workbuddy';
  logicalObservationKey: string;
  rolloutIdentity: string;
  rootSessionId: string;
  hostTurnId: string;
  text: string;
  workspaceDir: string;
}): IngressEvidenceEntry[] {
  // Real persisted behavior evidence only (P1 review round 3). No Pain-id /
  // logical-key / session-id pseudo-traces — WorkBuddy yields no evidence here.
  return persistedBehaviorTraceEvidence(args);
}

/**
 * Run the shared ingress semantics BEFORE any Pain/limit/marker side effect
 * (v0.3.1 §1.2). A refusal/observation-only signal becomes a terminal
 * `abandoned(reasonCode)` marker with zero Pain, zero quota.
 */
function ingressTerminalReason(facts: CorrectionIngressFacts): string | null {
  const decision = evaluatePainIngress(buildCorrectionIngressReport(facts));
  if (decision.action === 'refuse' || decision.action === 'observation_only') {
    return decision.reasonCode;
  }
  return null;
}

function insertTerminalCorrectionMarker(args: {
  db: Database.Database;
  candidate: GovernanceCorrectionCandidate;
  decision: 'abandoned';
  reason: string;
  ruleVersion: number | null;
  nowIso: string;
}): void {
  args.db.prepare(`INSERT INTO governance_signal_admissions
    (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'user_correction', 'abandoned', NULL, NULL, ?, ?, ?, ?, ?)`)
    .run(args.candidate.hostKind, args.candidate.logicalObservationKey, args.candidate.rolloutIdentity, args.candidate.rootSessionId,
      args.ruleVersion, args.reason.slice(0, MAX_REASON_BOUND),
      pendingTerminalPayload({ decision: 'abandoned', reason: args.reason, attempts: 0, confidence: null, nowIso: args.nowIso }), args.nowIso, args.nowIso);
}

/** Insert the pending marker. UNIQUE-violation races are resolved by the caller. */
function insertPendingCorrectionMarker(args: {
  db: Database.Database;
  candidate: GovernanceCorrectionCandidate;
  ruleVersion: number | null;
  payloadJson: string;
  nowIso: string;
}): void {
  args.db.prepare(`INSERT INTO governance_signal_admissions
    (host_kind, logical_observation_key, rollout_identity, root_session_id, signal_kind, decision, canonical_pain_id, diagnostician_task_id, rule_version, reason, task_payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'user_correction', 'pending_llm_review', NULL, NULL, ?, ?, ?, ?, ?)`)
    .run(args.candidate.hostKind, args.candidate.logicalObservationKey, args.candidate.rolloutIdentity, args.candidate.rootSessionId,
      args.ruleVersion, 'ambiguous correction candidate awaiting Stage 2 review', args.payloadJson, args.nowIso, args.nowIso);
}

/**
 * Convergence probe for the concurrent-redelivery race: two admission
 * processes passed the pre-transaction marker probe before either committed,
 * so the loser's marker INSERT hits the store UNIQUE constraint and its whole
 * transaction rolls back. A marker AND its canonical pain now existing means
 * the idempotency contract already WON — converge on the winner's state (the
 * same semantics as the task-ensure race in ensureGovernanceDiagnosticianTask)
 * instead of surfacing a governance_admission_failed that contradicts the
 * durable state. The probe re-reads the store fresh (rc-7); when the durable
 * facts do NOT exist it returns null and the original error propagates.
 */
function convergeOnAdmittedMarker(args: { db: Database.Database; logicalObservationKey: string; kind: GovernanceSignalKind }): GovernanceAdmissionOutcome | null {
  const marker = args.db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(args.logicalObservationKey);
  if (!isRecord(marker)) return null;
  const canonicalPainId = rowField(marker, 'canonical_pain_id');
  const taskId = rowField(marker, 'diagnostician_task_id');
  if (typeof canonicalPainId !== 'string') return null;
  if (args.db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(canonicalPainId) === undefined) return null;
  return {
    disposition: 'already_admitted',
    kind: args.kind,
    logicalObservationKey: args.logicalObservationKey,
    canonicalPainId,
    diagnosticianTaskId: typeof taskId === 'string' ? taskId : null,
  };
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

  // Ordinary conversation / zero-hit discovery is decided BEFORE the ingress
  // gate: it has no Pain, no task, no quota, and no marker (SPEC §18 scenario
  // 6). Ingress evidence only governs actual signals — running it first would
  // turn silence into an audit row and mask `not_a_signal`.
  const ambiguousTerms = detection?.output.matchedTerms ?? [];
  const isAmbiguousCandidate = detection !== undefined
    && detection.output.matchedPrecision === 'ambiguous'
    && ambiguousTerms.length > 0;
  if (!isStrongHighPrecision && !isAmbiguousCandidate) {
    return { disposition: 'not_a_signal', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey };
  }

  // v0.3.1 §1.2: shared ingress semantics run BEFORE any Pain/limit/marker
  // side effect — for explicit Owner statements AND automatic hooks. The
  // origin/channel are derived from the signal's real source.
  {
    const { painId } = deriveProductionCorrectionPainIdentity({
      workspaceDir,
      sessionId: candidate.rootSessionId,
      occurrenceId: candidate.hostTurnId,
      text: candidate.text,
    });
    const ingressReasonValue = correctionReason(candidate, detection?.output.matchedTerms ?? []);
    const ingressDecision = isExplicit
      ? evaluatePainIngress(buildOwnerCorrectionIngressReport({
        hostKind: candidate.hostKind,
        channel: ownerExplicitChannel(candidate),
        logicalObservationKey: candidate.logicalObservationKey,
        rolloutIdentity: candidate.rolloutIdentity,
        rootSessionId: candidate.rootSessionId,
        hostTurnId: candidate.hostTurnId,
        painId,
        reason: ingressReasonValue,
        // Codex has a real governance observation anchor when ingestion
        // persisted one; otherwise (ingestion disabled) the statement degrades
        // to the Owner Manual path instead of fabricating a trace. WorkBuddy
        // explicit intake has no transcript evidence and degrades honestly.
        evidence: correctionIngressEvidence({
          db,
          hostKind: candidate.hostKind,
          logicalObservationKey: candidate.logicalObservationKey,
          rolloutIdentity: candidate.rolloutIdentity,
          rootSessionId: candidate.rootSessionId,
          hostTurnId: candidate.hostTurnId,
          text: candidate.text,
          workspaceDir,
        }),
      }))
      : evaluatePainIngress(buildCorrectionIngressReport({
        hostKind: candidate.hostKind,
        logicalObservationKey: candidate.logicalObservationKey,
        rolloutIdentity: candidate.rolloutIdentity,
        rootSessionId: candidate.rootSessionId,
        hostTurnId: candidate.hostTurnId,
        painId,
        reason: ingressReasonValue,
        evidence: correctionIngressEvidence({
          db,
          hostKind: candidate.hostKind,
          logicalObservationKey: candidate.logicalObservationKey,
          rolloutIdentity: candidate.rolloutIdentity,
          rootSessionId: candidate.rootSessionId,
          hostTurnId: candidate.hostTurnId,
          text: candidate.text,
          workspaceDir,
        }),
      }));
    const ingressReason = ingressDecision.action === 'refuse' || ingressDecision.action === 'observation_only'
      ? ingressDecision.reasonCode
      : null;
    if (ingressReason !== null) {
      try {
        insertTerminalCorrectionMarker({
          db,
          candidate,
          decision: 'abandoned',
          reason: ingressReason,
          ruleVersion: detection?.ruleVersion ?? null,
          nowIso,
        });
      } catch (error) {
        const existing = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(candidate.logicalObservationKey);
        if (isRecord(existing)) {
          const existingReason = rowField(existing, 'reason');
          return {
            disposition: 'abandoned',
            kind: 'user_correction',
            logicalObservationKey: candidate.logicalObservationKey,
            reason: typeof existingReason === 'string' ? existingReason : ingressReason,
          };
        }
        throw error;
      }
      return { disposition: 'abandoned', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, reason: ingressReason };
    }
  }

  if (!isStrongHighPrecision) {
    // SPEC §4.4.8: ambiguous candidates become auditable pending rows (the
    // explicit change from the old "silence" contract). The canonical id is
    // derived from host identity facts — identical before and after review.
    const { painId } = deriveProductionCorrectionPainIdentity({
      workspaceDir,
      sessionId: candidate.rootSessionId,
      occurrenceId: candidate.hostTurnId,
      text: candidate.text,
    });
    const ruleVersion = detection?.ruleVersion ?? null;
    try {
      insertPendingCorrectionMarker({
        db,
        candidate,
        ruleVersion,
        payloadJson: JSON.stringify(buildPendingReviewPayload({
          candidate,
          workspaceDir,
          db,
          painId,
          matchedTerms: ambiguousTerms,
          ruleVersion,
        })),
        nowIso,
      });
    } catch (error) {
      // Concurrent redelivery hit UNIQUE: converge on the durable row instead
      // of surfacing a governance failure (rc-7 fresh re-read).
      const existing = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(candidate.logicalObservationKey);
      if (isRecord(existing)) {
        const decision = rowField(existing, 'decision');
        if (decision === 'pending_llm_review') {
          return { disposition: 'pending_llm_review', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, duplicate: true };
        }
        if (decision === 'resolved_none' || decision === 'abandoned') {
          const reason = rowField(existing, 'reason');
          return { disposition: decision, kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, reason: typeof reason === 'string' ? reason : null };
        }
        if (decision === 'admitted') {
          const canonicalPainId = rowField(existing, 'canonical_pain_id');
          const taskId = rowField(existing, 'diagnostician_task_id');
          if (typeof canonicalPainId === 'string') {
            return { disposition: 'already_admitted', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, canonicalPainId, diagnosticianTaskId: typeof taskId === 'string' ? taskId : null };
          }
        }
      }
      throw error;
    }
    return { disposition: 'pending_llm_review', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, duplicate: false };
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
        reason = insertCorrectionPain({ db, candidate, workspaceDir, painId, reason: correctionReason(candidate, detection?.output.matchedTerms ?? []), nowIso });
      }
      insertAdmissionMarker({
        db,
        identity: { hostKind: candidate.hostKind, logicalObservationKey: candidate.logicalObservationKey, rolloutIdentity: candidate.rolloutIdentity, rootSessionId: candidate.rootSessionId, signalKind: candidate.kind },
        canonicalPainId: painId,
        // Merged from main (CR-07): explicit owner statements never ran keyword
        // detection, so `detection` is optional — no ruleVersion exists for them.
        ruleVersion: detection?.ruleVersion ?? null,
        reason,
        payloadJson: taskSubmissionPayload(candidate, workspaceDir, { reason, db }),
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
    // SPEC v0.3 §4.4.3 pending guard: a redelivered candidate whose marker is
    // pending/terminal must return that semantic — never a bogus
    // `already_admitted` with an empty canonical id.
    const decision = rowField(marker, 'decision');
    if (decision === 'pending_llm_review') {
      return { disposition: 'pending_llm_review', kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, duplicate: true };
    }
    if (decision === 'resolved_none' || decision === 'abandoned') {
      const reason = rowField(marker, 'reason');
      return { disposition: decision, kind: 'user_correction', logicalObservationKey: candidate.logicalObservationKey, reason: typeof reason === 'string' ? reason : null };
    }
    const canonicalPainId = rowField(marker, 'canonical_pain_id');
    const taskId = rowField(marker, 'diagnostician_task_id');
    if (typeof canonicalPainId !== 'string' || canonicalPainId.length === 0) {
      return { ok: false, reason: 'admission_marker_corrupt', nextAction: 'Inspect governance_signal_admissions for an admitted row with a missing canonical_pain_id; do not re-admit into a corrupt marker.' };
    }
    return {
      disposition: 'already_admitted',
      kind: candidate.kind,
      logicalObservationKey: candidate.logicalObservationKey,
      canonicalPainId,
      diagnosticianTaskId: typeof taskId === 'string' ? taskId : null,
    };
  }

  try {
    return admitCorrection({ db, candidate, workspaceDir, now, nowIso, ...(keywordStore ? { keywordStore } : {}), ...(onDegradation ? { onDegradation } : {}) });
  } catch (error) {
    // RateLimitedSignal never reaches here — admitCorrection converts it to a
    // rate_limited outcome internally. A store-level failure (e.g. the loser
    // of a concurrent redelivery hitting the marker UNIQUE constraint) first
    // gets a fresh convergence probe; only a failure with NO durable
    // idempotency facts propagates as governance_admission_failed.
    const converged = convergeOnAdmittedMarker({ db, logicalObservationKey: candidate.logicalObservationKey, kind: candidate.kind });
    if (converged !== null) return converged;
    throw error;
  }
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

// ─── Pending Stage-2 review lifecycle (worker-facing) ───────────────────────

export interface PendingReviewResult {
  readonly ok: true;
  readonly disposition: 'admitted' | 'resolved_none' | 'pending' | 'abandoned' | 'concurrent_loss' | 'not_pending';
  readonly logicalObservationKey: string;
  readonly canonicalPainId?: string;
  readonly taskId?: string;
  readonly attempts: number;
  readonly reason: string | null;
}

export type PendingReviewCallResult = PendingReviewResult | Degradation;

export interface ClaimPendingCandidatesInput {
  readonly workspaceDir: string;
  readonly limit?: number;
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type ClaimPendingCandidatesResult =
  | { ok: true; candidates: readonly PendingCorrectionCandidate[]; expired: number }
  | Degradation;


function pendingReviewMarkerRow(db: Database.Database, key: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT * FROM governance_signal_admissions WHERE logical_observation_key = ?').get(key);
  return isRecord(row) ? row : null;
}

function parsePendingRow(row: Record<string, unknown>): { payloadText: string; payload: PendingReviewPayload; createdAt: string; hostKind: string; rolloutIdentity: string; rootSessionId: string } | null {
  const payloadText = rowField(row, 'task_payload_json');
  const createdAt = rowField(row, 'created_at');
  const hostKind = rowField(row, 'host_kind');
  const rolloutIdentity = rowField(row, 'rollout_identity');
  const rootSessionId = rowField(row, 'root_session_id');
  if (typeof payloadText !== 'string' || typeof createdAt !== 'string' || typeof hostKind !== 'string'
    || typeof rolloutIdentity !== 'string' || typeof rootSessionId !== 'string') return null;
  if (hostKind !== 'codex' && hostKind !== 'workbuddy') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const payload = parsePendingReviewPayload(parsed);
  if (payload === null) return null;
  return { payloadText, payload, createdAt, hostKind, rolloutIdentity, rootSessionId };
}

/**
 * Claim bounded pending candidates with an optimistic CAS on the exact payload
 * text. Rows whose claim is younger than PENDING_REVIEW_CLAIM_TTL_MS are
 * skipped (another worker is reviewing them); TTL-expired rows become
 * `abandoned(ttl_expired)` here, before any LLM work.
 */
export function claimPendingCorrectionCandidates(input: ClaimPendingCandidatesInput): ClaimPendingCandidatesResult {
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Math.min(Math.max(input.limit ?? 2, 1), 8);
  const candidates: PendingCorrectionCandidate[] = [];
  let expired = 0;
  try {
    const rows = db.prepare(`SELECT * FROM governance_signal_admissions
      WHERE decision = 'pending_llm_review' ORDER BY id LIMIT ?`).all(limit * 3);
    for (const row of rows) {
      if (candidates.length >= limit) break;
      if (!isRecord(row)) continue;
      const key = rowField(row, 'logical_observation_key');
      if (typeof key !== 'string') continue;
      const parsed = parsePendingRow(row);
      if (parsed === null) {
        // Corrupt pending payload: fail loud into a terminal row so it cannot
        // poison every future batch (rc-3), with no Pain and no task.
        db.prepare(`UPDATE governance_signal_admissions
          SET decision = 'abandoned', reason = ?, task_payload_json = ?, updated_at = ?
          WHERE logical_observation_key = ? AND decision = 'pending_llm_review'`)
          .run('invalid_pending_payload', pendingTerminalPayload({ decision: 'abandoned', reason: 'invalid_pending_payload', attempts: 0, confidence: null, nowIso }), nowIso, key);
        expired += 1;
        continue;
      }
      const ageMs = Date.parse(parsed.createdAt);
      if (!Number.isFinite(ageMs) || now.getTime() - ageMs >= PENDING_CANDIDATE_TTL_MS) {
        db.prepare(`UPDATE governance_signal_admissions
          SET decision = 'abandoned', reason = ?, task_payload_json = ?, updated_at = ?
          WHERE logical_observation_key = ? AND decision = 'pending_llm_review'`)
          .run('ttl_expired', pendingTerminalPayload({ decision: 'abandoned', reason: 'ttl_expired', attempts: parsed.payload.review.attempts, confidence: null, nowIso }), nowIso, key);
        expired += 1;
        continue;
      }
      const {claimedAt} = parsed.payload.review;
      const hasReviewResult = parsed.payload.review.reviewResult !== undefined;
      if (!hasReviewResult && typeof claimedAt === 'string') {
        const claimedMs = Date.parse(claimedAt);
        if (Number.isFinite(claimedMs) && now.getTime() - claimedMs < PENDING_REVIEW_CLAIM_TTL_MS) continue;
      }
      let claimToken: string | null = null;
      if (!hasReviewResult) {
        // `claimedAt` is the TTL clock; the random token is the fencing identity.
        claimToken = randomUUID();
        const nextPayload: PendingReviewPayload = { ...parsed.payload, review: { ...parsed.payload.review, claimedAt: nowIso, claimToken } };
        const {changes} = db.prepare(`UPDATE governance_signal_admissions SET task_payload_json = ?, updated_at = ?
          WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
          .run(JSON.stringify(nextPayload), nowIso, key, parsed.payloadText);
        if (changes !== 1) continue; // another worker won the claim
      }
      candidates.push({
        logicalObservationKey: key,
        hostKind: parsed.hostKind === 'workbuddy' ? 'workbuddy' : 'codex',
        rolloutIdentity: parsed.rolloutIdentity,
        rootSessionId: parsed.rootSessionId,
        hostTurnId: parsed.payload.trigger.hostTurnId,
        text: parsed.payload.trigger.text,
        matchedTerms: parsed.payload.trigger.matchedTerms,
        attempts: parsed.payload.review.attempts,
        claimedAt: hasReviewResult ? null : nowIso,
        claimToken,
        reviewResult: parsed.payload.review.reviewResult ?? null,
        createdAt: parsed.createdAt,
      });
    }
    return { ok: true, candidates, expired };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `pending_claim_failed:${detail}`, nextAction: 'inspect the workspace trajectory database; pending rows remain durable' };
  } finally {
    close();
  }
}

export interface ReleasePendingClaimInput {
  readonly workspaceDir: string;
  readonly logicalObservationKey: string;
  /** The fencing token returned by `claimPendingCorrectionCandidates`. */
  readonly claimToken: string;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type ReleasePendingClaimResult =
  | { ok: true; released: boolean; reason: 'released' | 'not_pending' | 'review_already_persisted' | 'claim_not_owned' | 'claim_changed' | 'claim_absent' }
  | Degradation;

/**
 * Release THIS worker's claim when no classification started (budget exhausted
 * or classifier unavailable), so the next cycle can re-claim immediately.
 *
 * Guard rails:
 * - only `pending_llm_review` rows;
 * - never when a durable reviewResult exists (that outcome must be consumed by
 *   settle, not thrown away);
 * - the persisted claim token must still be the one this worker took;
 * - CAS on the exact payload text, so a concurrent worker's state is untouched.
 */
export function releasePendingCorrectionClaim(input: ReleasePendingClaimInput): ReleasePendingClaimResult {
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  try {
    const row = pendingReviewMarkerRow(db, input.logicalObservationKey);
    if (row === null) return { ok: true, released: false, reason: 'not_pending' };
    if (rowField(row, 'decision') !== 'pending_llm_review') {
      return { ok: true, released: false, reason: 'not_pending' };
    }
    const parsed = parsePendingRow(row);
    if (parsed === null) return { ok: true, released: false, reason: 'claim_changed' };
    if (parsed.payload.review.reviewResult !== undefined) {
      return { ok: true, released: false, reason: 'review_already_persisted' };
    }
    const currentClaim = parsed.payload.review.claimToken;
    if (currentClaim === undefined) return { ok: true, released: false, reason: 'claim_absent' };
    if (currentClaim !== input.claimToken) return { ok: true, released: false, reason: 'claim_not_owned' };
    const { claimedAt: _consumedClaim, claimToken: _consumedToken, ...reviewWithoutClaim } = parsed.payload.review;
    void _consumedClaim;
    void _consumedToken;
    const nextPayload: PendingReviewPayload = { ...parsed.payload, review: reviewWithoutClaim };
    const { changes } = db.prepare(`UPDATE governance_signal_admissions SET task_payload_json = ?, updated_at = ?
      WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
      .run(JSON.stringify(nextPayload), new Date().toISOString(), input.logicalObservationKey, parsed.payloadText);
    if (changes !== 1) return { ok: true, released: false, reason: 'claim_changed' };
    return { ok: true, released: true, reason: 'released' };
  } finally {
    close();
  }
}

export interface CompletePendingReviewInput {
  readonly workspaceDir: string;
  readonly logicalObservationKey: string;
  /** Fencing token from `claimPendingCorrectionCandidates`; required. */
  readonly claimToken: string;
  /** `null` = the classifier produced no usable verdict (timeout/exception). */
  readonly llmResult: LlmClassificationResult | null;
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

/**
 * Durable Phase 1: persist the Stage-2 verdict + attempts into the pending
 * payload (CAS on the payload text). A crash after this commit loses no LLM
 * result; `settlePendingCorrection` finishes the transition without re-calling.
 */
export function recordPendingCorrectionReview(input: CompletePendingReviewInput): PendingReviewCallResult {
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const row = pendingReviewMarkerRow(db, input.logicalObservationKey);
    if (row === null) return { ok: true, disposition: 'not_pending', logicalObservationKey: input.logicalObservationKey, attempts: 0, reason: 'marker_missing' };
    if (rowField(row, 'decision') !== 'pending_llm_review') {
      return { ok: true, disposition: 'not_pending', logicalObservationKey: input.logicalObservationKey, attempts: 0, reason: 'marker_not_pending' };
    }
    const parsed = parsePendingRow(row);
    if (parsed === null) {
      return { ok: false, reason: 'pending_payload_invalid', nextAction: 'inspect the pending marker payload; the row stays pending until repaired' };
    }
    // Fencing: if another worker re-claimed this row (our claim exceeded the
    // 10-minute TTL and was taken over), our verdict must NOT overwrite the
    // new owner's state. Compare the fencing token, not only the payload text.
    const currentClaimToken = parsed.payload.review.claimToken;
    if (currentClaimToken === undefined || currentClaimToken !== input.claimToken) {
      return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: parsed.payload.review.attempts, reason: 'claim_not_owned' };
    }
    const gate = evaluateStage2ConfidenceGate(input.llmResult);
    const attempts = parsed.payload.review.attempts + 1;
    const reviewResult: Stage2ReviewRecord = { verdict: gate.verdict, confidence: gate.confidence, reason: gate.reason };
    const nextPayload: PendingReviewPayload = {
      ...parsed.payload,
      review: {
        ...parsed.payload.review,
        attempts,
        reviewResult,
        lastAttemptAt: nowIso,
        lastReason: gate.verdict,
        // Keep the SAME claim stamp/token so a parallel worker skips this row;
        // a crash after this commit is handled by the reviewResult-present path.
      },
    };
    const {changes} = db.prepare(`UPDATE governance_signal_admissions SET task_payload_json = ?, updated_at = ?
      WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
      .run(JSON.stringify(nextPayload), nowIso, input.logicalObservationKey, parsed.payloadText);
    if (changes !== 1) {
      return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: parsed.payload.review.attempts, reason: 'payload_changed' };
    }
    return {
      ok: true,
      disposition: 'pending',
      logicalObservationKey: input.logicalObservationKey,
      attempts,
      reason: gate.reason,
    };
  } finally {
    close();
  }
}

export interface SettlePendingReviewInput {
  readonly workspaceDir: string;
  readonly logicalObservationKey: string;
  /**
   * Fencing token when this worker recorded the verdict in the current cycle.
   * Omitted only for crash recovery of an ALREADY persisted reviewResult.
   */
  readonly claimToken?: string;
  readonly now?: Date;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

/**
 * Durable Phase 2: apply the persisted verdict. Correction → admitted (CAS,
 * pain dedup, rate limit, marker swap); confident none → resolved_none;
 * low-confidence/error/empathy → pending until MAX_ATTEMPTS or TTL; rate
 * limiting rolls the transaction back and leaves the row pending without
 * consuming another attempt (no LLM happened here).
 */
export async function settlePendingCorrection(input: SettlePendingReviewInput): Promise<PendingReviewCallResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const opened = openAdmissionStore(input.workspaceDir, input.databaseFactory);
  if (!('db' in opened)) return opened;
  const { db, close } = opened;
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const row = pendingReviewMarkerRow(db, input.logicalObservationKey);
    if (row === null) return { ok: true, disposition: 'not_pending', logicalObservationKey: input.logicalObservationKey, attempts: 0, reason: 'marker_missing' };
    const decision = rowField(row, 'decision');
    if (decision === 'admitted') {
      const canonicalPainId = rowField(row, 'canonical_pain_id');
      const taskId = rowField(row, 'diagnostician_task_id');
      return { ok: true, disposition: 'admitted', logicalObservationKey: input.logicalObservationKey, ...(typeof canonicalPainId === 'string' ? { canonicalPainId } : {}), ...(typeof taskId === 'string' ? { taskId } : {}), attempts: 0, reason: null };
    }
    if (decision !== 'pending_llm_review') {
      const reason = rowField(row, 'reason');
      return { ok: true, disposition: 'not_pending', logicalObservationKey: input.logicalObservationKey, attempts: 0, reason: typeof reason === 'string' ? reason : null };
    }
    const parsed = parsePendingRow(row);
    if (parsed === null) {
      return { ok: false, reason: 'pending_payload_invalid', nextAction: 'inspect the pending marker payload; the row stays pending until repaired' };
    }
    const { payload, payloadText, createdAt, rootSessionId, rolloutIdentity, hostKind } = parsed;
    // Fencing: a settlement that depends on this worker's claim must still hold
    // that claim. Omitted token = crash recovery of an already durable result,
    // which any successor may finish (reviewResult is the durable evidence).
    if (input.claimToken !== undefined) {
      const currentClaimToken = payload.review.claimToken;
      if (currentClaimToken === undefined || currentClaimToken !== input.claimToken) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'claim_not_owned' };
      }
    }
    const review = payload.review.reviewResult;
    if (review === undefined) {
      return { ok: true, disposition: 'pending', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'review_not_recorded' };
    }
    const ageMs = Date.parse(createdAt);
    const ttlExpired = Number.isFinite(ageMs) && now.getTime() - ageMs >= PENDING_CANDIDATE_TTL_MS;

    // TTL bounds EVERY pending verdict, including a late correction: a candidate
    // that sat past the window is no longer trustworthy evidence.
    if (ttlExpired) {
      const { changes } = db.prepare(`UPDATE governance_signal_admissions SET decision = 'abandoned', reason = ?, task_payload_json = ?, updated_at = ?
        WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
        .run('ttl_expired', pendingTerminalPayload({ decision: 'abandoned', reason: 'ttl_expired', attempts: payload.review.attempts, confidence: review.confidence, nowIso }), nowIso, input.logicalObservationKey, payloadText);
      if (changes !== 1) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
      }
      return { ok: true, disposition: 'abandoned', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'ttl_expired' };
    }

    if (review.verdict !== 'correction' && review.verdict !== 'none') {
      if (payload.review.attempts >= STAGE2_MAX_ATTEMPTS) {
        const reason = review.verdict === 'pending_llm_error' ? 'llm_error' : 'low_confidence';
        const { changes } = db.prepare(`UPDATE governance_signal_admissions SET decision = 'abandoned', reason = ?, task_payload_json = ?, updated_at = ?
          WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
          .run(reason, pendingTerminalPayload({ decision: 'abandoned', reason, attempts: payload.review.attempts, confidence: review.confidence, nowIso }), nowIso, input.logicalObservationKey, payloadText);
        if (changes !== 1) {
          return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
        }
        return { ok: true, disposition: 'abandoned', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason };
      }
      // Retryable verdict: consume the review result and release the claim so
      // the next worker cycle re-claims and calls the LLM again. Both claim
      // properties must be ABSENT (claim logic tests `reviewResult !==
      // undefined` / `claimToken`), and the CAS must use the exact payload we
      // read (concurrent-settle guard).
      const { reviewResult: _consumedReview, claimedAt: _consumedClaim, claimToken: _consumedToken, ...retainedReview } = payload.review;
      void _consumedReview;
      void _consumedClaim;
      void _consumedToken;
      const nextPayload: PendingReviewPayload = {
        ...payload,
        review: { ...retainedReview, lastAttemptAt: nowIso, lastReason: review.verdict },
      };
      const { changes } = db.prepare(`UPDATE governance_signal_admissions SET task_payload_json = ?, updated_at = ?
        WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
        .run(JSON.stringify(nextPayload), nowIso, input.logicalObservationKey, payloadText);
      if (changes !== 1) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
      }
      return { ok: true, disposition: 'pending', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: review.verdict };
    }

    if (review.verdict === 'none') {
      const { changes } = db.prepare(`UPDATE governance_signal_admissions SET decision = 'resolved_none', reason = ?, task_payload_json = ?, updated_at = ?
        WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
        .run(review.reason.slice(0, MAX_REASON_BOUND) || 'stage2_none', pendingTerminalPayload({ decision: 'resolved_none', reason: review.reason, attempts: payload.review.attempts, confidence: review.confidence, nowIso }), nowIso, input.logicalObservationKey, payloadText);
      if (changes !== 1) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
      }
      return { ok: true, disposition: 'resolved_none', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: review.reason };
    }

    // Correction → Pain Admission. The canonical id was derived pre-review from
    // host identity facts; recompute it here from the same facts so the two
    // stages cannot drift (rc-6).
    const candidate: GovernanceCorrectionCandidate = {
      kind: 'user_correction',
      hostKind: hostKind === 'workbuddy' ? 'workbuddy' : 'codex',
      logicalObservationKey: input.logicalObservationKey,
      rolloutIdentity,
      rootSessionId,
      hostTurnId: payload.trigger.hostTurnId,
      text: payload.trigger.text,
      observedAt: createdAt,
    };
    // rc-6: reuse the id derived BEFORE review (the persisted trigger text may
    // be sanitized/truncated, so re-deriving from it would change the hash).
    const painId = payload.pain_id;
    const reason = correctionReason(candidate, payload.trigger.matchedTerms);
    // v0.3.1 §1.2: the shared ingress decision precedes the admitted CAS.
    // P1 review round 3: re-derive evidence from trajectory.db instead of
    // trusting whatever the pending payload recorded. A pending candidate with
    // no real persisted observation (e.g. WorkBuddy automatic) cannot be
    // admitted — it settles as observation_only with zero Pain/quota.
    const ingressReason = ingressTerminalReason({
      hostKind: candidate.hostKind,
      logicalObservationKey: input.logicalObservationKey,
      rolloutIdentity,
      rootSessionId,
      hostTurnId: candidate.hostTurnId,
      painId,
      reason,
      evidence: correctionIngressEvidence({
        db,
        hostKind: candidate.hostKind,
        logicalObservationKey: input.logicalObservationKey,
        rolloutIdentity,
        rootSessionId,
        hostTurnId: candidate.hostTurnId,
        text: payload.trigger.text,
        workspaceDir,
      }),
    });
    if (ingressReason !== null) {
      const { changes } = db.prepare(`UPDATE governance_signal_admissions SET decision = 'abandoned', reason = ?, task_payload_json = ?, updated_at = ?
        WHERE logical_observation_key = ? AND decision = 'pending_llm_review' AND task_payload_json = ?`)
        .run(ingressReason, pendingTerminalPayload({ decision: 'abandoned', reason: ingressReason, attempts: payload.review.attempts, confidence: review.confidence, nowIso }), nowIso, input.logicalObservationKey, payloadText);
      if (changes !== 1) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
      }
      return { ok: true, disposition: 'abandoned', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: ingressReason };
    }
    let duplicate = false;
    try {
      db.transaction(() => {
        const {changes} = db.prepare(`UPDATE governance_signal_admissions
          SET decision = 'admitted', canonical_pain_id = ?, rule_version = ?, reason = ?, task_payload_json = ?, updated_at = ?
          WHERE logical_observation_key = ? AND decision = 'pending_llm_review'`)
          .run(painId, payload.review.ruleVersion, reason.slice(0, MAX_REASON_BOUND),
            JSON.stringify(payload.task_payload), nowIso, input.logicalObservationKey);
        if (changes !== 1) throw new PendingCasLost();
        if (db.prepare('SELECT 1 FROM pain_events WHERE canonical_pain_id = ?').get(painId) !== undefined) {
          duplicate = true;
          db.prepare('UPDATE pain_events SET host_kind = ? WHERE canonical_pain_id = ? AND host_kind IS NULL').run(candidate.hostKind, painId);
        } else {
          const ruleVersion = payload.review.ruleVersion ?? EXPLICIT_OWNER_STATEMENT_RULE_VERSION;
          if (!tryConsumeRateLimit({ db, rootSessionId: candidate.rootSessionId, ruleVersion, now })) throw new RateLimitedSignal();
          insertCorrectionPain({ db, candidate, workspaceDir, painId, reason, nowIso });
        }
      })();
    } catch (error) {
      if (error instanceof PendingCasLost) {
        return { ok: true, disposition: 'concurrent_loss', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'cas_lost' };
      }
      if (error instanceof RateLimitedSignal) {
        // Non-LLM failure: the row stays pending with its attempts unchanged
        // (the review result is already durable). TTL eventually bounds it.
        return { ok: true, disposition: 'pending', logicalObservationKey: input.logicalObservationKey, attempts: payload.review.attempts, reason: 'rate_limited' };
      }
      throw error;
    }
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- declared below; function declarations are hoisted
    const ensured = await ensureGovernanceDiagnosticianTask({
      workspaceDir,
      logicalObservationKey: input.logicalObservationKey,
      canonicalPainId: painId,
      ...(input.databaseFactory ? { databaseFactory: input.databaseFactory } : {}),
    });
    return {
      ok: true,
      disposition: 'admitted',
      logicalObservationKey: input.logicalObservationKey,
      canonicalPainId: painId,
      attempts: payload.review.attempts,
      reason: duplicate ? 'duplicate_pain' : reason,
      ...(ensured.ok ? { taskId: ensured.taskId } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    return { ok: false, reason: `pending_settle_failed:${detail}`, nextAction: 'inspect the workspace trajectory database; admitted rows are durably recoverable via reconcile' };
  } finally {
    close();
  }
}


/** P0: a four-term projection of existing canonical high-precision correction seeds. */
const WORKBUDDY_AUTO_TERMS = new Set(['这是错的', '不要自作主张', '不应该这么做', '又搞错']);
const WORKBUDDY_MAX_PROMPT_BYTES = 16 * 1024;
function workbuddyP0KeywordStore(): UnifiedKeywordStore {
  const seed = buildSharedSeedKeywordStore();
  const terms: UnifiedKeywordStore['terms'] = {};
  for (const [term, def] of Object.entries(seed.terms)) {
    // The shared seed store only contains correction phrases (the empathy
    // keyword store was retired with GFI-COMPLETE-REMOVAL-001), so the term
    // membership + high precision is the whole filter.
    if (WORKBUDDY_AUTO_TERMS.has(term) && def.precision === 'high') {
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
export type WorkbuddyCorrectionCandidateKind = 'strong' | 'ambiguous' | 'none';

/**
 * Shared WorkBuddy Stage-1 assessment. `strong` may admit inline (no LLM);
 * `ambiguous` persists a pending Stage-2 candidate (zero LLM in the hook);
 * `none` writes nothing. Detection delegates position safety to the shared
 * keyword-stage guards (quotes / third person / negation / conditional context).
 */
export function assessWorkbuddyCorrectionCandidate(
  text: string,
  sessionId: string,
  store?: UnifiedKeywordStore,
): {
  kind: WorkbuddyCorrectionCandidateKind;
  reason: 'matched' | 'not_a_signal' | 'prompt_too_large';
} {
  if (Buffer.byteLength(text, 'utf8') > WORKBUDDY_MAX_PROMPT_BYTES) {
    return { kind: 'none', reason: 'prompt_too_large' };
  }
  const resolved = store ?? workbuddyP0KeywordStore();
  const out = collectSync(text, sessionId, resolved, SYNC_DETECTION_CONFIG, new Date().toISOString());
  const strong = out.isSignal && out.strength === 'STRONG' &&
    out.type === 'correction' && out.matchedPrecision === 'high';
  if (strong) return { kind: 'strong', reason: 'matched' };
  if (out.matchedPrecision === 'ambiguous' && out.matchedTerms.length > 0) {
    return { kind: 'ambiguous', reason: 'matched' };
  }
  return { kind: 'none', reason: 'not_a_signal' };
}

/** Backward-compatible boolean view: only `strong` counts as matched. */
export function assessWorkbuddyLiveKeyword(
  text: string,
  sessionId: string,
  store?: UnifiedKeywordStore,
): {
  matched: boolean; reason: 'matched' | 'not_a_signal' | 'prompt_too_large';
} {
  const assessment = assessWorkbuddyCorrectionCandidate(text, sessionId, store);
  return {
    matched: assessment.kind === 'strong',
    reason: assessment.kind === 'strong' ? 'matched' : assessment.reason,
  };
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
  const assessment = assessWorkbuddyCorrectionCandidate(prompt, sessionId, sharedStore);
  if (assessment.kind === 'none') {
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
  | {
    ok: true;
    taskId: string;
    created: boolean;
    duplicate: boolean;
    linkRepaired: boolean;
    /** Present when the Owner-manual ingress legitimately degraded (honest empty evidence). */
    ingressWarning?: string;
  }
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
    if (!isRecord(marker)) {
      return { ok: false, reason: 'admission_marker_not_found', nextAction: 'admit the signal before ensuring its Diagnostician continuation' };
    }
    const payloadRaw = rowField(marker, 'task_payload_json');
    // Legacy linked marker: an old admitted row may carry no payload at all.
    // The task already exists, there is no ingress fact to rebuild, and
    // demanding a payload here would starve reconciliation forever. A PRESENT
    // but inconsistent payload still fails closed below.
    if (typeof existingTaskId === 'string' && existingTaskId.length > 0
      && (payloadRaw === null || payloadRaw === undefined)) {
      return { ok: true, taskId: existingTaskId, created: false, duplicate: true, linkRepaired: false };
    }
    let payloadParsed: unknown;
    try {
      payloadParsed = typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : null;
    } catch {
      payloadParsed = null;
    }
    if (!isGovernanceTaskPayload(payloadParsed)) {
      return { ok: false, reason: 'admission_task_payload_invalid', nextAction: 're-admit the signal or run reconciliation after repairing the workspace state' };
    }

    // SPEC v0.3.1 §1.2: provenance is DERIVED from the marker's ingress facts,
    // never hardcoded. The marker is host-context-bound by construction, and
    // its payload carries the evidence entries that make this a `submit`.
    const rolloutIdentity = rowField(marker, 'rollout_identity');
    const markerKey = input.logicalObservationKey;
    const hostTurnId = payloadParsed.hostKind === 'codex'
      ? (markerKey.split('|')[2] ?? markerKey)
      : (markerKey.lastIndexOf('|') > 0 ? markerKey.slice(0, markerKey.lastIndexOf('|')) : markerKey);
    const markerHostKind = payloadParsed.hostKind;
    // P1 review round 3: never trust the payload's evidence list — re-derive it
    // from trajectory.db with the full lineage tuple. A marker that references a
    // non-existent observation (or a WorkBuddy automatic correction) evaluates
    // to observation_only and fails closed below.
    // A tool_failure pain is its own persisted evidence (the pain row), not a
    // correction claim about behavior — the correction re-derivation must not
    // run for it. Only corrections are gated on a real observation.
    const isCorrectionPayload = payloadParsed.painType !== 'tool_failure';
    const ingressEvidence: IngressEvidenceEntry[] = isCorrectionPayload && (markerHostKind === 'codex' || markerHostKind === 'workbuddy')
      ? correctionIngressEvidence({
        db,
        hostKind: markerHostKind,
        logicalObservationKey: markerKey,
        rolloutIdentity: typeof rolloutIdentity === 'string' ? rolloutIdentity : '',
        rootSessionId: payloadParsed.sessionId,
        hostTurnId,
        text: payloadParsed.reason,
        workspaceDir,
      })
      : payloadParsed.evidence.map((entry) => ({
        kind: 'behavior_trace' as const,
        sourceRef: entry.sourceRef,
        note: entry.note,
      }));
    let provenance: PainProvenance;
    let ingressWarning: string | undefined;
    if (isCorrectionPayload && (markerHostKind === 'codex' || markerHostKind === 'workbuddy')) {
      // SPEC v0.3 §5 / v0.3.1 §1.2: rebuild the report from the marker's REAL
      // source. An explicit Owner statement is owner_manual (manual_pain_id,
      // correctionEvidence channel); everything else is the automatic hook.
      const ownerChannel = payloadParsed.correctionEvidence?.channel;
      const ingressDecision = ownerChannel !== undefined
        ? evaluatePainIngress(buildOwnerCorrectionIngressReport({
          hostKind: markerHostKind,
          channel: ownerChannel,
          logicalObservationKey: markerKey,
          rolloutIdentity: typeof rolloutIdentity === 'string' ? rolloutIdentity : '',
          rootSessionId: payloadParsed.sessionId,
          hostTurnId,
          painId: input.canonicalPainId,
          reason: payloadParsed.reason,
          // CR-02: never fabricate transcript evidence for an Owner statement;
          // an empty list is the honest basis and bound explicit reports
          // legitimately degrade.
          evidence: ingressEvidence,
        }))
        : evaluatePainIngress(buildCorrectionIngressReport({
          hostKind: markerHostKind,
          logicalObservationKey: markerKey,
          rolloutIdentity: typeof rolloutIdentity === 'string' ? rolloutIdentity : '',
          rootSessionId: payloadParsed.sessionId,
          hostTurnId,
          painId: input.canonicalPainId,
          reason: payloadParsed.reason,
          evidence: ingressEvidence,
        }));
      if (ingressDecision.action === 'refuse' || ingressDecision.action === 'observation_only') {
        // Fail closed: an inconsistent/evidence-less admitted marker must not
        // silently become a task (and must never be relabelled automatic_hook).
        return {
          ok: false,
          reason: `pain_ingress_${ingressDecision.reasonCode}`,
          nextAction: ingressDecision.action === 'refuse' ? ingressDecision.nextAction : ingressDecision.note,
        };
      }
      const { legacy: { provenance: decidedProvenance } } = ingressDecision;
      provenance = decidedProvenance;
      if (ingressDecision.action === 'degrade') ingressWarning = ingressDecision.warning;
    } else {
      // OpenClaw markers do not flow through this governance seam today; keep
      // the historical provenance rather than inventing an ingress report.
      provenance = 'host_context_bound';
    }

    // Recovery path: a task link already exists. The ingress decision above
    // still ran, so an inconsistent admitted marker fails closed instead of
    // being reported as a healthy duplicate.
    if (typeof existingTaskId === 'string' && existingTaskId.length > 0) {
      return {
        ok: true,
        taskId: existingTaskId,
        created: false,
        duplicate: true,
        linkRepaired: false,
        ...(ingressWarning !== undefined ? { ingressWarning } : {}),
      };
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
      let existing = await stateManager.getTask(taskId);
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
          provenance,
          // The admitting host comes from the marker's own payload — the ONE
          // durable attribution fact (existing codex markers keep 'codex',
          // workbuddy markers attribute 'workbuddy').
          hostKind: payloadParsed.hostKind,
          evidence: [...ingressEvidence],
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
          // Concurrent-ensure race (hook redelivery × worker reconcile): both
          // callers passed the getTask probe before either committed, and the
          // DETERMINISTIC task id makes the loser's insert hit the store PK.
          // The task existing now is the idempotency contract winning, not a
          // failure — converge on it (Case-B repair semantics) instead of
          // reporting a task_submit_failed that contradicts the durable state.
          existing = await stateManager.getTask(taskId);
          if (existing === null) {
            return { ok: false, reason: `task_submit_failed:${(result.message ?? result.failureCategory ?? 'unknown').slice(0, 160)}`, nextAction: 'inspect the diagnostician runtime profile; reconciliation retries task creation without losing the admitted pain' };
          }
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
        ...(ingressWarning !== undefined ? { ingressWarning } : {}),
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
  /** Current Owner consent for Codex conversation evidence. Required to prevent reconciliation from promoting old observations after opt-out. */
  readonly codexConversationIngestionEnabled: boolean;
  /**
   * Legacy alias from before the host-scoped rename. It means the SAME thing as
   * the field above — Codex conversation-evidence consent only, never consent
   * for WorkBuddy evidence. Kept so an older caller paired with this runtime
   * still promotes, and callers pass both names so an older runtime still sees
   * consent (P2 review). When the new field is present it wins: an explicit
   * `false` must never be overridden by a stale `true` here.
   */
  readonly conversationIngestionEnabled?: boolean;
  readonly databaseFactory?: ObservationDatabaseFactory;
}

export type EnsureGovernanceContinuationResult =
  | { ok: true; taskId: string; taskCreated: boolean; linkRepaired: boolean; promoted: number; tailState: 'completed' | 'pending' | 'skipped' }
  | { ok: false; reason: string; nextAction: string; taskId?: string; taskCreated?: boolean; linkRepaired?: boolean };

/**
 * Given an admitted canonical pain (identified by its marker), ensure the
 * Diagnostician task and, only with current conversation-ingestion consent,
 * the evidence promotion exist idempotently.
 * Single ensure path for both fresh admits and crash recovery (already_admitted
 * redelivery). The marker row carries rollout_identity; callers must also
 * provide the current conversation-ingestion consent.
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
    // Promote before making a runnable task visible, so a worker racing this
    // continuation cannot begin diagnosis before the eligible evidence window
    // has been promoted. A promotion failure is retained as a degradation,
    // but never prevents the task from being durably ensured.
    const codexConsent = typeof input.codexConversationIngestionEnabled === 'boolean'
      ? input.codexConversationIngestionEnabled
      : input.conversationIngestionEnabled === true;
    const promoted = codexConsent
      ? promoteAdmittedGovernanceEvidence({
        workspaceDir,
        rolloutIdentity,
        triggerLogicalKey: input.logicalObservationKey,
        canonicalPainId: input.canonicalPainId,
      })
      : undefined;
    const ensured = await ensureGovernanceDiagnosticianTask({ workspaceDir, logicalObservationKey: input.logicalObservationKey, canonicalPainId: input.canonicalPainId });
    if (!ensured.ok) {
      return { ok: false, reason: ensured.reason, nextAction: ensured.nextAction };
    }
    if (promoted !== undefined && !promoted.ok) {
      return { ok: false, reason: promoted.reason, nextAction: promoted.nextAction, taskId: ensured.taskId, taskCreated: ensured.created, linkRepaired: ensured.linkRepaired };
    }
    return { ok: true, taskId: ensured.taskId, taskCreated: ensured.created, linkRepaired: ensured.linkRepaired, promoted: promoted?.promoted ?? 0, tailState: promoted?.tailState ?? 'skipped' };
  } finally {
    close();
  }
}

// ─── Reconciliation (SPEC §13 crash-gap pass; Slice C worker calls this) ────

export interface ReconcileGovernanceContinuationInput {
  readonly workspaceDir: string;
  /** Current Owner consent for CODEX conversation evidence; false means reconcile may ensure tasks/links but must not read or promote Codex session evidence. A WorkBuddy worker must pass false — its own flag is not consent for Codex evidence. */
  readonly codexConversationIngestionEnabled: boolean;
  /**
   * Legacy alias (pre-rename) for the Codex-only consent above; never consent
   * for WorkBuddy evidence. Kept for cross-version compatibility (P2 review);
   * the new field wins when present, so an explicit `false` cannot be
   * overridden by a stale `true`.
   */
  readonly conversationIngestionEnabled?: boolean;
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
 * and the Runtime task store (separate SQLite databases — no cross-store
 * transaction exists, SPEC §13). Current conversation-ingestion consent is
 * mandatory because it controls whether Codex observations may be read and
 * promoted; task/link recovery remains available when consent is off. Recovers:
 *  - Case A: pain admitted, crash before task creation → create the task now;
 *  - Case B: task exists, crash before the link write → repair the link;
 *  - Case C: pain+task, crash before promotion → promote evidence now only
 *    while conversation-ingestion consent is enabled;
 *  - Case D: promotion started → pending tail → retry completion once; stale
 *    tails are reported (never silently dropped).
 * Not a background worker — Slice C's Companion worker and the CLI call this.
 */
export async function reconcileGovernanceContinuation(input: ReconcileGovernanceContinuationInput): Promise<ReconcileGovernanceContinuationResult> {
  const workspaceDir = path.resolve(input.workspaceDir);
  // Accept the pre-rename field too: an older caller paired with this runtime
  // must not silently lose Codex evidence promotion (P2 review).
  const codexConsent = typeof input.codexConversationIngestionEnabled === 'boolean'
    ? input.codexConversationIngestionEnabled
    : input.conversationIngestionEnabled === true;
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
    //   Case C:   promotion never started (no observation carries this painRef),
    //             but only while current conversation-ingestion consent is on.
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
    const promotionRecoveryClause = codexConsent
      ? `OR (a.host_kind = 'codex'
              AND NOT EXISTS (SELECT 1 FROM governance_observations o
                  WHERE o.promotion_ref = a.canonical_pain_id))`
      : '';
    const markers = db.prepare(`SELECT a.logical_observation_key, a.canonical_pain_id, a.host_kind
      FROM governance_signal_admissions a
      WHERE a.decision = 'admitted'
        AND (
          a.diagnostician_task_id IS NULL
          ${promotionRecoveryClause}
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
      const cont = await ensureGovernanceContinuation({ workspaceDir, logicalObservationKey: key, canonicalPainId: painId, codexConversationIngestionEnabled: codexConsent });
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
        if (cont.taskCreated) tasksEnsured += 1;
        if (cont.linkRepaired) linksRepaired += 1;
        degradations.push(`${key}:${cont.reason}`);
      }
    }
    // Also report stale tails scoped to governance admissions.
    const stale = codexConsent
      ? db.prepare(`SELECT COUNT(*) AS n FROM governance_pending_promotion_tails t
          WHERE t.state = 'stale'
            AND EXISTS (SELECT 1 FROM governance_signal_admissions a WHERE a.canonical_pain_id = t.pain_ref)`).get()
      : { n: 0 };
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
        MAX(CASE WHEN decision = 'admitted' THEN created_at END) AS last_admission
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
