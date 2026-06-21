/**
 * RecordReplayAdapter — PDRuntimeAdapter that records real LLM outputs to
 * fixtures and replays them deterministically in CI.
 *
 * Solves ERR-001/ERR-005/ERR-025 where ScriptedAdapter hand-written payloads
 * drift from real LLM output format. By recording real LLM responses and
 * replaying them, tests exercise the exact payload shape production sees.
 *
 * Three modes (controlled by PD_TEST_LLM_MODE env var):
 *   - 'replay' (default): load fixture by request hash; fail loud if missing.
 *       Zero-cost, deterministic, CI-friendly. Does not require realAdapter.
 *   - 'record': delegate to realAdapter, capture full interaction, save fixture.
 *       Requires realAdapter. Run periodically by humans to refresh fixtures.
 *   - 'live': delegate to realAdapter without recording. For local debugging.
 *
 * Fixture directory controlled by PD_TEST_LLM_FIXTURE_DIR env var,
 * defaulting to 'tests/__llm-recordings__' (relative to process.cwd()).
 *
 * Fixture file naming: <request-hash>.json
 *
 * ERR avoidance:
 *   - ERR-001/ERR-005: fixture data loaded from disk is treated as `unknown`
 *     and runtime-validated (typeof / Array.isArray guards) before use. No `as`
 *     casts on untrusted fixture content.
 *   - ERR-009/ERR-010: replay mode fails loud (throws) when fixture is missing
 *     or malformed — no silent null return.
 *   - ERR-025: fixtures capture the real adapter's verbatim output shape,
 *     eliminating hand-written payload drift.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  StartRunInput,
  RunHandle,
  RunStatus,
  StructuredRunOutput,
  RuntimeArtifactRef,
  ContextItem,
} from '../runtime-protocol.js';

export type RecordReplayMode = 'record' | 'replay' | 'live';

/** Environment variable names controlling adapter behavior. */
const ENV_MODE = 'PD_TEST_LLM_MODE';
const ENV_FIXTURE_DIR = 'PD_TEST_LLM_FIXTURE_DIR';
const DEFAULT_FIXTURE_DIR = 'tests/__llm-recordings__';

/**
 * Keys whose values are volatile (timestamps, UUIDs, idempotency tokens).
 * Stripped from the request before hashing so that semantically identical
 * requests produce the same hash across runs.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'startedAt',
  'endedAt',
  'lastCheckedAt',
  'createdAt',
  'updatedAt',
  'timestamp',
  'ts',
  'recordedAt',
  'now',
  'currentTime',
]);

/** Fixture file format version. Bump on breaking schema changes. */
const FIXTURE_VERSION = 1;

/** Shape of a recorded fixture (after JSON.parse, before validation). */
interface RecordedFixture {
  readonly version: number;
  readonly hash: string;
  readonly recordedAt: string;
  readonly runtimeKind: RuntimeKind;
  readonly runHandle: RunHandle;
  readonly runStatus: RunStatus;
  readonly output: StructuredRunOutput | null;
  readonly artifacts: RuntimeArtifactRef[];
}

/**
 * Recursively normalize a value for deterministic hashing:
 *   - strip volatile keys (timestamps, idempotencyKey, etc.)
 *   - sort object keys alphabetically
 *   - traverse arrays element-wise
 */
function normalizeForHash(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    const keys = Object.keys(obj)
      .filter((k) => !VOLATILE_KEYS.has(k))
      .sort();
    for (const key of keys) {
      if (Object.hasOwn(obj, key)) {
        result[key] = normalizeForHash(obj[key]);
      }
    }
    return result;
  }
  return value;
}

/**
 * Compute a deterministic SHA-256 hash for a StartRunInput.
 *
 * The hash is stable across semantically identical requests that differ only
 * in volatile fields (timestamps, idempotency keys). This prevents false
 * cache misses when replaying recorded fixtures.
 */
export function computeRequestHash(input: StartRunInput): string {
  const normalized = normalizeForHash(input);
  const json = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(json).digest('hex');
}

/** Resolve the active mode from environment, defaulting to 'replay'. */
function resolveMode(env: Record<string, string | undefined> = process.env): RecordReplayMode {
  const raw = env[ENV_MODE];
  if (raw === 'record' || raw === 'replay' || raw === 'live') {
    return raw;
  }
  return 'replay';
}

/** Resolve the fixture directory from environment, defaulting to the standard path. */
function resolveFixtureDir(env: Record<string, string | undefined> = process.env): string {
  return env[ENV_FIXTURE_DIR] ?? DEFAULT_FIXTURE_DIR;
}

// ── Fixture validation (ERR-001/ERR-005: no `as` casts on untrusted data) ──

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRuntimeKind(v: unknown): v is RuntimeKind {
  return (
    v === 'openclaw' ||
    v === 'openclaw-cli' ||
    v === 'openclaw-history' ||
    v === 'claude-cli' ||
    v === 'codex-cli' ||
    v === 'gemini-cli' ||
    v === 'local-worker' ||
    v === 'test-double' ||
    v === 'pi-ai' ||
    v === 'pi-ai-l2'
  );
}

function isRuntimeArtifactRef(v: unknown): v is RuntimeArtifactRef {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isString(obj.artifactType) && isString(obj.ref);
}

function isRunHandle(v: unknown): v is RunHandle {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isString(obj.runId) && isRuntimeKind(obj.runtimeKind) && isString(obj.startedAt);
}

function isRunStatus(v: unknown): v is RunStatus {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!isString(obj.runId)) return false;
  const { status } = obj;
  if (
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'succeeded' &&
    status !== 'failed' &&
    status !== 'timed_out' &&
    status !== 'cancelled'
  ) {
    return false;
  }
  return true;
}

function isStructuredRunOutput(v: unknown): v is StructuredRunOutput {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isString(obj.runId) && Object.hasOwn(obj, 'payload');
}

/**
 * Validate a parsed JSON value as a RecordedFixture.
 *
 * Returns the fixture on success, throws on failure (fail loud — ERR-009).
 */
function validateFixture(raw: unknown, expectedHash: string): RecordedFixture {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(
      `[RecordReplayAdapter] Fixture is not a JSON object (hash=${expectedHash}).`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const { version } = obj;
  if (!isNumber(version)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture missing or invalid 'version' (hash=${expectedHash}).`,
    );
  }
  if (version !== FIXTURE_VERSION) {
    throw new Error(
      `[RecordReplayAdapter] Fixture version mismatch: expected ${FIXTURE_VERSION}, got ${version} (hash=${expectedHash}). Re-record the fixture.`,
    );
  }

  const { hash } = obj;
  if (!isString(hash) || hash !== expectedHash) {
    throw new Error(
      `[RecordReplayAdapter] Fixture hash mismatch: expected ${expectedHash}, got ${String(hash)}.`,
    );
  }

  const { recordedAt } = obj;
  if (!isString(recordedAt)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture missing 'recordedAt' (hash=${expectedHash}).`,
    );
  }

  const { runtimeKind } = obj;
  if (!isRuntimeKind(runtimeKind)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture has invalid 'runtimeKind' (hash=${expectedHash}).`,
    );
  }

  const { runHandle } = obj;
  if (!isRunHandle(runHandle)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture has invalid 'runHandle' (hash=${expectedHash}).`,
    );
  }

  const { runStatus } = obj;
  if (!isRunStatus(runStatus)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture has invalid 'runStatus' (hash=${expectedHash}).`,
    );
  }

  const { output } = obj;
  if (output !== null && !isStructuredRunOutput(output)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture has invalid 'output' (hash=${expectedHash}).`,
    );
  }
  const validatedOutput: StructuredRunOutput | null = output;

  const { artifacts: rawArtifacts } = obj;
  if (!Array.isArray(rawArtifacts)) {
    throw new Error(
      `[RecordReplayAdapter] Fixture has invalid 'artifacts' array (hash=${expectedHash}).`,
    );
  }
  const validatedArtifacts: RuntimeArtifactRef[] = [];
  for (const element of rawArtifacts) {
    if (!isRuntimeArtifactRef(element)) {
      throw new Error(
        `[RecordReplayAdapter] Fixture artifacts contains an invalid element (hash=${expectedHash}).`,
      );
    }
    validatedArtifacts.push(element);
  }

  return {
    version,
    hash,
    recordedAt,
    runtimeKind,
    runHandle,
    runStatus,
    output: validatedOutput,
    artifacts: validatedArtifacts,
  };
}

// ── In-memory run state (keyed by runId) ──

interface RunRecord {
  readonly fixture: RecordedFixture;
  /** The runId assigned by this adapter (may differ from recorded runId). */
  readonly localRunId: string;
}

/**
 * Configuration for RecordReplayAdapter.
 */
export interface RecordReplayAdapterOptions {
  /** The real adapter to delegate to in record/live mode. Required for record/live. */
  readonly realAdapter?: PDRuntimeAdapter;
  /** Override mode (defaults to PD_TEST_LLM_MODE env var, or 'replay'). */
  readonly mode?: RecordReplayMode;
  /** Override fixture directory (defaults to PD_TEST_LLM_FIXTURE_DIR env var). */
  readonly fixtureDir?: string;
}

/**
 * PDRuntimeAdapter that records real LLM outputs and replays them deterministically.
 *
 * In replay mode, no realAdapter is needed — the adapter serves fixtures from disk.
 * In record/live mode, a realAdapter must be provided.
 */
export class RecordReplayAdapter implements PDRuntimeAdapter {
  private readonly realAdapter?: PDRuntimeAdapter;
  private readonly mode: RecordReplayMode;
  private readonly fixtureDir: string;
  private readonly runs = new Map<string, RunRecord>();
  private runCounter = 0;

  constructor(opts: RecordReplayAdapterOptions = {}) {
    this.realAdapter = opts.realAdapter;
    this.mode = opts.mode ?? resolveMode();
    this.fixtureDir = opts.fixtureDir ?? resolveFixtureDir();

    if ((this.mode === 'record' || this.mode === 'live') && !this.realAdapter) {
      throw new Error(
        `[RecordReplayAdapter] realAdapter is required for mode='${this.mode}'.`,
      );
    }
  }

  /** Current active mode. */
  getMode(): RecordReplayMode {
    return this.mode;
  }

  /** Active fixture directory. */
  getFixtureDir(): string {
    return this.fixtureDir;
  }

  kind(): RuntimeKind {
    if (this.realAdapter) {
      return this.realAdapter.kind();
    }
    // Replay-only mode: report as test-double since no real adapter is wrapped.
    return 'test-double';
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    if (this.realAdapter) {
      return this.realAdapter.getCapabilities();
    }
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async refreshCapabilities(): Promise<RuntimeCapabilities> {
    if (this.realAdapter?.refreshCapabilities) {
      return this.realAdapter.refreshCapabilities();
    }
    return this.getCapabilities();
  }

  async healthCheck(): Promise<RuntimeHealth> {
    if (this.realAdapter) {
      return this.realAdapter.healthCheck();
    }
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    const hash = computeRequestHash(input);

    if (this.mode === 'live') {
      // Live mode: pure delegation, no recording.
      return this.requireRealAdapter().startRun(input);
    }

    if (this.mode === 'record') {
      return this.recordStartRun(input, hash);
    }

    // Replay mode: load fixture or fail loud.
    return this.replayStartRun(input, hash);
  }

  async pollRun(runId: string): Promise<RunStatus> {
    if (this.mode === 'live') {
      return this.requireRealAdapter().pollRun(runId);
    }

    const record = this.runs.get(runId);
    if (record) {
      // Return the recorded status with the local runId substituted.
      return { ...record.fixture.runStatus, runId };
    }

    if (this.mode === 'record') {
      return this.requireRealAdapter().pollRun(runId);
    }

    // No recorded state for this runId — fail loud (ERR-009).
    throw new Error(
      `[RecordReplayAdapter] pollRun: no recorded run for runId=${runId} in mode=${this.mode}.`,
    );
  }

  async cancelRun(runId: string): Promise<void> {
    if (this.mode === 'live') {
      const real = this.requireRealAdapter();
      return real.cancelRun(runId);
    }
    // In replay/record mode, cancellation is a no-op on recorded state.
    // The run is already complete in the fixture.
    void runId;
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.mode === 'live') {
      return this.requireRealAdapter().fetchOutput(runId);
    }

    const record = this.runs.get(runId);
    if (record) {
      const recordedOutput = record.fixture.output;
      if (recordedOutput === null) {
        return null;
      }
      // Substitute the local runId so callers see consistent runId.
      return { ...recordedOutput, runId };
    }

    if (this.mode === 'record') {
      return this.requireRealAdapter().fetchOutput(runId);
    }

    throw new Error(
      `[RecordReplayAdapter] fetchOutput: no recorded run for runId=${runId} in mode=${this.mode}.`,
    );
  }

  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    if (this.mode === 'live') {
      return this.requireRealAdapter().fetchArtifacts(runId);
    }

    const record = this.runs.get(runId);
    if (record) {
      return record.fixture.artifacts;
    }

    if (this.mode === 'record') {
      return this.requireRealAdapter().fetchArtifacts(runId);
    }

    throw new Error(
      `[RecordReplayAdapter] fetchArtifacts: no recorded run for runId=${runId} in mode=${this.mode}.`,
    );
  }

  async appendContext(runId: string, items: ContextItem[]): Promise<void> {
    if (this.realAdapter?.appendContext) {
      return this.realAdapter.appendContext(runId, items);
    }
    // No-op in replay mode without a real adapter.
    void runId;
    void items;
  }

  /** Return the real adapter, throwing if absent (constructor invariant). */
  private requireRealAdapter(): PDRuntimeAdapter {
    if (!this.realAdapter) {
      throw new Error(
        `[RecordReplayAdapter] realAdapter is required for mode='${this.mode}' but was not provided.`,
      );
    }
    return this.realAdapter;
  }

  // ── Record mode ──

  private async recordStartRun(input: StartRunInput, hash: string): Promise<RunHandle> {
    const realAdapter = this.requireRealAdapter();
    const handle = await realAdapter.startRun(input);
    const status = await realAdapter.pollRun(handle.runId);
    const output = await realAdapter.fetchOutput(handle.runId);
    const artifacts = await realAdapter.fetchArtifacts(handle.runId);

    const fixture: RecordedFixture = {
      version: FIXTURE_VERSION,
      hash,
      recordedAt: new Date().toISOString(),
      runtimeKind: handle.runtimeKind,
      runHandle: handle,
      runStatus: status,
      output,
      artifacts,
    };

    this.saveFixture(hash, fixture);

    // Store under the real runId so pollRun/fetchOutput can delegate if needed.
    // Also store under a local alias for consistency.
    this.runs.set(handle.runId, { fixture, localRunId: handle.runId });
    return handle;
  }

  // ── Replay mode ──

  private async replayStartRun(input: StartRunInput, hash: string): Promise<RunHandle> {
    const fixture = this.loadFixture(hash);

    this.runCounter += 1;
    const localRunId = `rr-${this.runCounter}`;
    this.runs.set(localRunId, { fixture, localRunId });

    // Return a handle with the local runId and the recorded runtimeKind.
    return {
      runId: localRunId,
      runtimeKind: fixture.runtimeKind,
      startedAt: new Date().toISOString(),
    };
  }

  // ── Fixture I/O ──

  private fixturePath(hash: string): string {
    return path.join(this.fixtureDir, `${hash}.json`);
  }

  private loadFixture(hash: string): RecordedFixture {
    const filePath = this.fixturePath(hash);
    let rawText: string;
    try {
      rawText = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(
        `[RecordReplayAdapter] Fixture not found for hash=${hash} at ${filePath}. ` +
          `Run with PD_TEST_LLM_MODE=record to capture it. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error(
        `[RecordReplayAdapter] Fixture at ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // ERR-001/ERR-005: validate untrusted parsed data before use.
    return validateFixture(parsed, hash);
  }

  private saveFixture(hash: string, fixture: RecordedFixture): void {
    fs.mkdirSync(this.fixtureDir, { recursive: true });
    const filePath = this.fixturePath(hash);
    const json = JSON.stringify(fixture, null, 2);
    fs.writeFileSync(filePath, json, 'utf8');
  }
}
