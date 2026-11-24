import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection, resolveStateDbPath } from '@principles/core/runtime';
import { canonicalizeDeepestExisting, getWorkbuddyWorkspaceDir, isPathWithinRoot } from '@principles/install-layout';

/**
 * Shared workbench builders for the entry/production suites: a FAKE home (so
 * the entry's os.homedir()-based OD-07 resolution lands in a temp dir), a
 * real governance workspace config, real production activation artifacts
 * (through SqliteActivationStateStore — the production store writer, never
 * direct evidence-table hacks), and the trajectory schema the shared pain
 * path expects.
 */
const EVENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'host-contract', 'events');

const tempDirs: string[] = [];

/**
 * Sandbox boundary registry (2026-11-24 remediation): every tracked temp dir
 * is a write-allowed root. `assertInsideSandbox()` validates a path against
 * these roots with REAL-path semantics — canonicalizeDeepestExisting resolves
 * the deepest existing ancestor, so a junction/symlink/reparse point sitting
 * on the path cannot fake containment the way a `startsWith` string check can.
 */
const sandboxRoots = new Set<string>();

/**
 * Pure-string Windows UNC / device-namespace classification. It MUST run
 * before ANY filesystem call: under Windows, statting/realpathing a
 * `\\host\share` path can reach an SMB server (integrated-auth leak) and
 * `\\?\` / `\\.\` escape into the device namespace. The judgment is made on
 * the raw candidate — Windows UNC semantics do not depend on the host OS, so
 * `path.resolve()` (POSIX on this runner) is never trusted to recognise them.
 * Two or more leading separators (`\\`, `//`, `\/`, `/\`) are treated as
 * remote/device and fail closed; a description is returned, else null.
 */
function windowsRemoteOrDevicePath(candidate: string): string | null {
  let separators = 0;
  while (separators < candidate.length && (candidate[separators] === '\\' || candidate[separators] === '/')) {
    separators += 1;
  }
  if (separators < 2) return null;
  const tail = candidate.slice(separators);
  // `\\?\` extended-length (incl. \\?\UNC\host\share) and `\\.\` device
  // namespaces: `?` or `.` immediately after the leading separators.
  if (/^[?.][\\/]/.test(tail)) {
    return `Windows device-namespace path "${candidate}"`;
  }
  return `UNC/network path "${candidate}"`;
}

function registerSandboxRoot(dir: string): void {
  const remote = windowsRemoteOrDevicePath(dir);
  if (remote !== null) {
    throw new Error(`Refusing to register a ${remote} as a sandbox root — it can never be local.`);
  }
  const real = canonicalizeDeepestExisting(dir) ?? path.resolve(dir);
  sandboxRoots.add(real);
}

/**
 * True when a link (symlink/junction/reparse point) sits on the MISSING TAIL
 * below the deepest realpath-able ancestor of `candidate` — e.g. a dangling
 * link that `canonicalizeDeepestExisting` re-appends verbatim. Such a path
 * cannot be proven safe (the target may spring into existence outside the
 * sandbox), so the boundary must fail closed.
 */
function linkOnMissingTail(candidate: string): string | null {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      fs.realpathSync.native(current);
      return null; // realpath-able: canonicalize already judged it
    } catch {
      // Missing — or a link whose target does not exist yet.
      try {
        if (fs.lstatSync(current).isSymbolicLink()) return current;
      } catch {
        // Truly missing tail segment: keep walking up.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Fail loud instead of writing outside a disposable sandbox.
 *
 * Residual risk (documented, not eliminated): the guard is a point-in-time
 * judgment. A concurrently-mutating actor could still swap a checked
 * directory for a link between the check and the subsequent write (in-process
 * TOCTOU). It closes pre-existing junction/symlink escapes and ambient-env
 * leaks; it does not defend against an active adversary racing the writer.
 */
export function assertInsideSandbox(candidate: string, hint = ''): void {
  // Remote/device paths are refused on the STRING before linkOnMissingTail or
  // canonicalizeDeepestExisting can touch the filesystem: on Windows a stat of
  // a UNC path may reach an SMB host before any boundary verdict exists.
  const remote = windowsRemoteOrDevicePath(candidate);
  if (remote !== null) {
    throw new Error(`Refusing to seed through a ${remote} — it can never be inside a local test sandbox ${hint}`.trimEnd());
  }
  const danglingLink = linkOnMissingTail(candidate);
  if (danglingLink !== null) {
    throw new Error(
      `Refusing to seed through an unresolvable link on the path: "${danglingLink}" ${hint}`.trimEnd(),
    );
  }
  const real = canonicalizeDeepestExisting(candidate);
  if (real === null) {
    throw new Error(`Refusing to seed an unresolvable path: "${path.resolve(candidate)}" ${hint}`.trim());
  }
  for (const root of sandboxRoots) {
    if (isPathWithinRoot(root, real)) return;
  }
  throw new Error(
    `Refusing to seed outside the test sandbox: "${real}" escapes every registered sandbox root ${hint}`.trimEnd() +
    ' — a host directory override (WORKBUDDY_CONFIG_DIR / CODEX_HOME / OPENCLAW_HOME) may have leaked into the test process.',
  );
}

/**
 * Host-directory overrides that `resolvePdHome()` honours AHEAD of an
 * explicitly passed `homeDir`. A test helper that inherits any of them from
 * the ambient host process (WorkBuddy sets WORKBUDDY_CONFIG_DIR in every child
 * shell) silently resolves the REAL user directories instead of the sandbox.
 */
export const AMBIENT_HOST_OVERRIDE_KEYS = [
  'WORKBUDDY_CONFIG_DIR',
  'CODEBUDDY_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCLAW_HOME',
  'OPENCLAW_STATE_DIR',
  'PD_EXPERIMENT_ROOT',
] as const;

/**
 * A controlled env for sandbox resolution/spawning: the ambient host
 * overrides are stripped and BOTH home authorities are pinned to the sandbox,
 * so the result never depends on the caller having cleaned process.env first.
 */
export function sandboxEnv(home: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of AMBIENT_HOST_OVERRIDE_KEYS) delete env[key];
  env.HOME = home;
  env.USERPROFILE = home;
  return { ...env, ...(extra ?? {}) };
}

export function trackTempDir(dir: string): string {
  // Register BEFORE tracking: a refused remote/device root must never reach
  // cleanupTempDirs, whose rmSync would touch the very path we just rejected.
  registerSandboxRoot(dir);
  tempDirs.push(dir);
  return dir;
}
export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    // Windows releases closed SQLite handles ASYNCHRONOUSLY — the host-runtime
    // admission suite and the Codex worker suite retry removal for the same
    // reason. A directory still pinned after the retry budget is a REAL handle
    // leak and must fail loud, never be silently swallowed.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 12) throw error;
        // Synchronous pause between attempts (afterAll has no async context).
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      }
    }
  }
}

export function makeHome(): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-workbuddy-home-')));
}

export function makeProjectDir(home: string, name: string): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), `pd-workbuddy-proj-${name}-`)));
}

export interface GovernanceOptions {
  workbuddyFlag?: boolean;
  receiptLedgerFlag?: boolean;
  ruleContextV2Flag?: boolean;
  /** Write INVALID config yaml (degraded-config tests). */
  malformed?: boolean;
  /**
   * ADR-0029: the shipped default pi-ai profile carries empty placeholders and is
   * deliberately `needs_setup`, so nothing could be *persisted* on it. Hook tests
   * that assert evidence/task durability are governance-path tests, not LLM
   * tests, so they pass this flag to write the evidence on a ready profile —
   * the same thing an install-configured workspace has.
   */
  readyRuntime?: boolean;
}

/** Profile id and env var used by `readyRuntime` workspaces. */
export const WB_READY_PROFILE_ID = 'pd.default';
export const WB_READY_API_KEY_ENV = 'PD_WB_TEST_API_KEY';

export function makeGovernance(home: string, options: GovernanceOptions = {}): string {
  // Hermetic resolution (2026-11-24 remediation): the governance dir is
  // derived through an EXPLICIT configDirOverride inside the sandbox and a
  // controlled env with the ambient host overrides stripped — it can never
  // resolve to the real WorkBuddy config root even when the caller forgot to
  // clean process.env (the 2026-11-22 real data-loss vector).
  const governance = getWorkbuddyWorkspaceDir(home, path.join(path.resolve(home), '.workbuddy'), sandboxEnv(path.resolve(home)));
  assertInsideSandbox(governance, `(makeGovernance home=${home})`);
  // The boundary check must cover the ACTUAL write targets, not just their
  // parent: `.pd` may be a junction/symlink planted inside the sandbox that
  // resolves outside it, and `config.yaml` itself may be a link. Check the
  // dir before creating it (a pre-existing escape must never be written
  // through), re-check after mkdir (fail closed if the dir we just resolved
  // no longer proves inside), then check the resolved file target.
  const pdDir = path.join(governance, '.pd');
  assertInsideSandbox(pdDir, '(makeGovernance .pd)');
  fs.mkdirSync(pdDir, { recursive: true });
  assertInsideSandbox(pdDir, '(makeGovernance .pd post-mkdir)');
  const configPath = path.join(pdDir, 'config.yaml');
  assertInsideSandbox(configPath, '(makeGovernance config.yaml)');
  if (options.malformed) {
    fs.writeFileSync(configPath, '{ this is: not: valid yaml ][');
    return governance;
  }
  const config = getDefaultPdConfig();
  if (config.features['host.workbuddy']) config.features['host.workbuddy'].enabled = options.workbuddyFlag ?? false;
  if (config.features['principle_receipt_ledger']) config.features['principle_receipt_ledger'].enabled = options.receiptLedgerFlag ?? false;
  // B-class automatic Pain submissions need the workspace opt-in (fail-closed
  // default). Governance fixtures represent authorized workspaces.
  config.features.automatic_pain_submission = { category: 'quiet', enabled: true };
  if (options.ruleContextV2Flag !== undefined && config.features['rulecode_context_v2']) config.features['rulecode_context_v2'].enabled = options.ruleContextV2Flag;
  if (options.readyRuntime) {
    (config.runtimeProfiles as Record<string, unknown>)[WB_READY_PROFILE_ID] = {
      type: 'pi-ai', provider: 'test-provider', model: 'test-model',
      apiKeyEnv: WB_READY_API_KEY_ENV, baseUrl: 'http://127.0.0.1:8080/v1',
    };
    config.internalAgents.defaultRuntime = WB_READY_PROFILE_ID;
    // Hook paths run in child processes that inherit this env.
    process.env[WB_READY_API_KEY_ENV] = 'test-key';
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
  return governance;
}

/** Load a REAL frozen fixture payload with the cwd (and transcript) pointed at temp reality. */
export function fixturePayload(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const fixture = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, name), 'utf8')) as { payload?: unknown };
  if (typeof fixture.payload !== 'object' || fixture.payload === null || Array.isArray(fixture.payload)) {
    throw new Error(`fixture ${name} carries no payload object`);
  }
  // Runtime-contract discipline (ERR-001): no `as` on the parsed shape —
  // copy the validated object's own enumerable keys instead.
  return { ...Object.fromEntries(Object.entries(fixture.payload)), ...overrides };
}

export interface ArtifactInput {
  id: string;
  kind: 'principle' | 'rule';
  principleId: string;
  ruleId?: string;
  content: object;
  channel: 'prompt' | 'code_tool_hook';
  action: 'prompt_activate' | 'code_tool_hook_live_activate' | 'code_tool_hook_shadow_activate';
  target: string;
}

/** Production store path: pi_artifacts row + SqliteActivationStateStore.recordActivation. */
export async function activationArtifact(governance: string, input: ArtifactInput): Promise<void> {
  assertInsideSandbox(governance, '(activationArtifact)');
  // `new SqliteConnection(dir)` mkdirs `<dir>/.pd` and opens
  // `<dir>/.pd/state.db` — the boundary check must run on that REAL path
  // BEFORE the connection exists, because Database() would already have
  // created (or written through) the file. resolveStateDbPath is the same
  // resolver the connection uses, so the checked path and the opened path
  // cannot drift apart.
  const dbPath = resolveStateDbPath(governance);
  assertInsideSandbox(path.dirname(dbPath), '(activationArtifact .pd)');
  assertInsideSandbox(dbPath, '(activationArtifact state.db)');
  const connection = new SqliteConnection(governance);
  try {
    const now = new Date().toISOString();
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.kind, `task-${input.id}`, input.principleId, input.ruleId ?? null, '[]', 'validated', JSON.stringify(input.content), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: `act-${input.id}`,
      idempotencyKey: `${input.id}::${input.channel}`,
      artifactId: input.id,
      channel: input.channel,
      action: input.action,
      targetRef: input.target,
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

/** Create the canonical trajectory schema the shared pain evidence path writes into. */
export function makeTrajectory(governance: string): void {
  // Sandbox boundary validation: a governance dir resolved through an
  // ambient host override (or hand-joined to a real user dir) fails here,
  // before any bytes are written.
  assertInsideSandbox(governance, '(makeTrajectory)');
  // Same write-target discipline as makeGovernance: check `.state` before and
  // after mkdir, then check the resolved trajectory.db itself — a junction or
  // file link landing outside the sandbox must refuse BEFORE SQLite opens it.
  const stateDir = path.join(governance, '.state');
  assertInsideSandbox(stateDir, '(makeTrajectory .state)');
  fs.mkdirSync(stateDir, { recursive: true });
  assertInsideSandbox(stateDir, '(makeTrajectory .state post-mkdir)');
  const dbPath = path.join(stateDir, 'trajectory.db');
  assertInsideSandbox(dbPath, '(makeTrajectory trajectory.db)');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
}
