import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDefaultPdConfig, SqliteActivationStateStore, SqliteConnection } from '@principles/core/runtime';
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

function registerSandboxRoot(dir: string): void {
  const real = canonicalizeDeepestExisting(dir) ?? path.resolve(dir);
  sandboxRoots.add(real);
}

/** Fail loud instead of writing outside a disposable sandbox. */
export function assertInsideSandbox(candidate: string, hint = ''): void {
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
  tempDirs.push(dir);
  registerSandboxRoot(dir);
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
  fs.mkdirSync(path.join(governance, '.pd'), { recursive: true });
  if (options.malformed) {
    fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), '{ this is: not: valid yaml ][');
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
  fs.writeFileSync(path.join(governance, '.pd', 'config.yaml'), JSON.stringify(config));
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
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const db = new Database(path.join(governance, '.state', 'trajectory.db'));
  db.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL);
    CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL;
  `);
  db.close();
}
