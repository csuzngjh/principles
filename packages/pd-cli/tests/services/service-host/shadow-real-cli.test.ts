/**
 * REAL-CLI integration (task §12): the shadow adapters driving the REAL
 * built pd-cli `codex|workbuddy worker --once --json --workspace` entry in
 * a fully sandboxed install (identity, host roots and CLI-home all inside a
 * temp home; the allowlist env pins HOME/USERPROFILE so the child can never
 * resolve outside the sandbox). Covers:
 *
 *  T11  Codex + WorkBuddy real `--once` cycles through the adapter;
 *  T12  PD_INVOCATION_SOURCE=service_host → liveness lastCycleDriver;
 *  T13  two CONCURRENT real cycles on ONE seeded workspace — the existing
 *       Durable Lease converges double-acquisition (same task executed at
 *       most once; the loser reports lease contention, never corruption).
 *
 * The CLI entry points at THIS worktree's built dist via the test-only
 * resolveCliEntry probe; PRODUCTION always resolves the active-release
 * install (worker-adapter.ts, task §7.4). Skipped when dist is not built.
 */
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRuntimeStateHandle, getDefaultPdConfig } from '@principles/core/runtime';
import Database from 'better-sqlite3';
import { runServiceShadowOnce } from '../../../src/services/service-host/shadow-run.js';
import { createCodexWorkerAdapter } from '../../../src/services/service-host/worker-adapter-codex.js';
import { serviceRunStatusPath } from '../../../src/services/service-host/status/service-run-status.js';

const PD_CLI_DIST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const hasDist = existsSync(PD_CLI_DIST_ENTRY);

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-sh-real-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Sandbox install: manifest + active record + an (empty) codex home for clean catch-up. */
function sandboxInstall(home: string, workspaces: string[]): void {
  const pdDir = path.join(home, '.pd');
  mkdirSync(pdDir, { recursive: true });
  const manifestFile = path.join(pdDir, 'install.json');
  const activeFile = path.join(pdDir, 'active.json');
  writeFileSync(manifestFile, JSON.stringify({ layoutVersion: 1, mode: 'canonical', hosts: ['codex', 'workbuddy'], workspaces }), 'utf8');
  writeFileSync(activeFile, JSON.stringify({
    schemaVersion: 1, generation: 5, releaseId: 'bundled-9.9.9-real', releaseMetadataDigest: 'a'.repeat(64),
    previousReleaseId: null, transactionId: 'txn-real-1', productVersion: '9.9.9',
  }), 'utf8');
  const codexHome = path.join(home, '.codex');
  mkdirSync(codexHome, { recursive: true });
}

/** The governance trajectory tables the real reconciliation pass reads (same DDL the WB worker fixtures apply). */
const TRAJECTORY_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
] as const;

/**
 * Credential-shaped env NAME (F4 review fix): deliberately NOT matching the
 * generic credential pattern (`*_API_KEY|*_KEY|*_TOKEN|...`) — the child can
 * only receive it through the config-derived `apiKeyEnv` allowlist, proving
 * that path end-to-end through the real CLI. The value is inert.
 */
const SHADOW_TEST_PROFILE_ENV = 'PD_SHADOW_TEAM_AUTH';
const SHADOW_TEST_PROFILE = 'pd.shadow-test';

/** A workspace with a VALID config (defaults + host flag on + ready profile), trajectory store and state store. */
async function workspaceWithConfig(home: string, workspaceName: string, hostFlag: 'host.codex' | 'host.workbuddy'): Promise<string> {
  const ws = path.join(home, workspaceName);
  const pdDir = path.join(ws, '.pd');
  const semanticsDir = path.join(pdDir, 'host-tool-semantics');
  mkdirSync(semanticsDir, { recursive: true });
  const hostKind = hostFlag === 'host.codex' ? 'codex' : 'workbuddy';
  const declarationFile = path.join(semanticsDir, `${hostKind}.json`);
  // A VALID declaration (the saveHostToolDeclaration payload shape, F2):
  // since the review fix the binding-evidence probe VALIDATES the content,
  // so a bare `{hostKind}` file no longer admits the adapter.
  writeFileSync(declarationFile, JSON.stringify({
    version: 2,
    hostKind,
    mappings: [{ rawToolName: 'Read', canonicalKind: 'read' }],
    declaredAt: '2026-11-21T00:00:00.000Z',
  }), 'utf8');
  const config = getDefaultPdConfig();
  const features = config.features as Record<string, { enabled?: boolean }>;
  if (features[hostFlag] !== undefined) features[hostFlag].enabled = true;
  // A ready runtime profile so the downstream consumer resolves instead of
  // degrading with runtime_config_error (same discipline as WB fixtures).
  (config.runtimeProfiles as Record<string, unknown>)[SHADOW_TEST_PROFILE] = {
    type: 'pi-ai', provider: 'test-provider', model: 'test-model',
    apiKeyEnv: SHADOW_TEST_PROFILE_ENV, baseUrl: 'http://127.0.0.1:9/v1',
  };
  config.internalAgents.defaultRuntime = SHADOW_TEST_PROFILE;
  const configFile = path.join(pdDir, 'config.yaml');
  writeFileSync(configFile, JSON.stringify(config), 'utf8');
  const stateDir = path.join(ws, '.state');
  mkdirSync(stateDir, { recursive: true });
  const trajectory = new Database(path.join(stateDir, 'trajectory.db'));
  for (const statement of TRAJECTORY_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false, bootstrapIfMissing: true });
  await handle.close().catch(() => undefined);
  return ws;
}

/** Seed one pending diagnostician task that is actually EXECUTABLE (F10): the
 * worker's bridge validates the persisted payload (diagnostic_payload_invalid
 * on bare rows), so the seed carries the minimal legacy-normalizable
 * diagnosticJson the real admission path persists. */
async function seedPendingTask(ws: string, taskId: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: false, bootstrapIfMissing: true });
  try {
    await handle.stateManager.createTask({
      taskId,
      taskKind: 'diagnostician',
      status: 'pending',
      attemptCount: 0,
      maxAttempts: 3,
      inputRef: `pd-shadow-test:${taskId}`,
      diagnosticJson: JSON.stringify({
        sourcePainId: `pain_${taskId}`,
        // 'manual' = the owner-reported source the legacy normalization
        // branch recognizes (a made-up source name would infer
        // automatic_hook provenance and the execution gate would skip it).
        source: 'manual',
        reasonSummary: 'fixture: review-concurrency task seed',
        painId: `pain_${taskId}`,
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function taskState(ws: string, taskId: string): Promise<{ status: string; attemptCount: number }> {
  const handle = await createRuntimeStateHandle({ workspaceDir: ws, readonly: true });
  try {
    const tasks = await handle.stateManager.listTasks({ taskKind: 'diagnostician' });
    const task = tasks.find((t) => t.taskId === taskId);
    if (task === undefined) throw new Error(`task ${taskId} vanished`);
    return { status: task.status, attemptCount: task.attemptCount };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const cliEntryProbe = { resolveCliEntry: () => ({ kind: 'entry' as const, entry: PD_CLI_DIST_ENTRY, source: 'canonical' as const }) };

beforeAll(() => {
  // The inert credential rides the allowlist credential pattern so the child
  // worker's profile resolution succeeds; the URL points at a discard port
  // and is never called (no pending tasks in T11).
  process.env[SHADOW_TEST_PROFILE_ENV] = 'fixture-inert-value';
});
afterAll(() => {
  delete process.env[SHADOW_TEST_PROFILE_ENV];
});

describe.skipIf(!hasDist)('real CLI cycles through the shadow adapters', () => {
  it('T11a+T12 Codex: a real --once cycle completes, records service_host driver liveness and a truthful outcome', async () => {
    const home = tempHome();
    const ws = await workspaceWithConfig(home, 'real-codex-ws', 'host.codex');
    sandboxInstall(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      hostFilter: 'codex',
      trustedHomeDir: home,
      timeoutMs: 120_000,
      probes: cliEntryProbe,
    });
    if (!result.ok || result.outcome !== 'completed') {
      throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 600)}`);
    }
    expect(result.executions[0]?.admission).toBe('admitted');
    const execution = result.executions[0]?.execution;
    expect(execution).toBeDefined();
    // The REAL CLI produced the result — no injected spawn.
    expect(execution?.worker.cliEntry).toBe(PD_CLI_DIST_ENTRY);
    expect(['cycle_completed', 'cycle_completed_without_business_progress', 'degraded']).toContain(execution?.cycleOutcome);
    expect(execution?.worker.exitCode).toBe(0);
    // T12: the new three-way driver identity landed in the real liveness file.
    const livenessFile = path.join(ws, '.state', 'codex-worker-liveness.json');
    const liveness = JSON.parse(readFileSync(livenessFile, 'utf8')) as { lastCycleDriver?: string; lastInvocationId?: string };
    expect(liveness.lastCycleDriver).toBe('service_host');
    // F13: the coordinator invocation id is recorded by the real worker and
    // read back through the adapter health projection — the correlation loop
    // closes on the REAL CLI path.
    expect(liveness.lastInvocationId).toBe(execution?.invocationId);
    expect(execution?.health.lastInvocationId).toBe(execution?.invocationId);
    // The status file persisted the shadow section.
    const statusFile = serviceRunStatusPath(path.join(home, '.pd'));
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8')) as { dryRun: boolean; shadow?: unknown };
    expect(persisted.dryRun).toBe(false);
    expect(persisted.shadow).toBeDefined();
  }, 180_000);

  it('T11b+T12 WorkBuddy: a real --once cycle completes and writes the NEW workbuddy liveness record', async () => {
    const home = tempHome();
    const ws = await workspaceWithConfig(home, 'real-wb-ws', 'host.workbuddy');
    sandboxInstall(home, [ws]);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      hostFilter: 'workbuddy',
      trustedHomeDir: home,
      timeoutMs: 120_000,
      probes: cliEntryProbe,
    });
    if (!result.ok || result.outcome !== 'completed') {
      throw new Error(`expected completed, got: ${JSON.stringify(result).slice(0, 600)}`);
    }
    expect(result.executions[0]?.admission).toBe('admitted');
    const execution = result.executions[0]?.execution;
    expect(execution?.worker.exitCode).toBe(0);
    expect(execution?.hostKind).toBe('workbuddy');
    // The liveness file that did NOT exist before this change.
    const livenessFile = path.join(ws, '.state', 'workbuddy-worker-liveness.json');
    const liveness = JSON.parse(readFileSync(livenessFile, 'utf8')) as {
      lastCycleDriver?: string; lastCycleCompletedAt?: string; lastCycleMode?: string; lastInvocationId?: string;
    };
    expect(liveness.lastCycleDriver).toBe('service_host');
    expect(typeof liveness.lastCycleCompletedAt).toBe('string');
    expect(liveness.lastCycleMode).toMatch(/^(ready|degraded)$/);
    // F13: invocation-id correlation on the WorkBuddy path too.
    expect(liveness.lastInvocationId).toBe(execution?.invocationId);
  }, 180_000);

  it('T13 concurrency (F10): executability proven first, then two PARALLEL real cycles — the lease lets exactly ONE claim the task', async () => {
    const home = tempHome();
    const ws = await workspaceWithConfig(home, 'concurrent-ws', 'host.codex');
    sandboxInstall(home, [ws]);
    // Probe task: proves the pipeline can actually reach the lease/execution
    // boundary on this workspace (F10 review fix — the race phase below must
    // not be allowed to "pass" because the task was never executable).
    const probeTaskId = 'concurrency-fixture-probe';
    const raceTaskId = 'concurrency-fixture-race';
    await seedPendingTask(ws, probeTaskId);
    await seedPendingTask(ws, raceTaskId);
    const adapter = createCodexWorkerAdapter();
    const runOne = (invocation: string): Promise<{ cycleOutcome: string; invocationId: string }> => adapter.executeOnce({
      workspaceDir: ws,
      activeRelease: { present: true, readable: true, valid: true, verdict: 'ok' },
      invocationId: invocation,
      timeoutMs: 120_000,
      identity: {
        pdHome: path.join(home, '.pd'), homeDir: home, homeSource: 'injected',
        manifestPath: path.join(home, '.pd', 'install.json'), activeRecordPath: path.join(home, '.pd', 'active.json'),
        hostRoots: { openclawHome: path.join(home, '.openclaw'), codexHome: path.join(home, '.codex'), workbuddyConfigDir: path.join(home, '.workbuddy') },
        mode: 'production',
        environment: { inheritedExperimentRoot: false, experimentRootStripped: false, ignoredIdentityEnvVars: [], inheritedHostRootEnvVars: [], ignoredHostRootEnvVars: [] },
      },
      // The allowlist picks VALUES from the inherited env by the config
      // derived credential NAMES — an empty inherited env means the worker
      // child runs without the profile credential (readiness not_ready), so
      // the fixture supplies the value explicitly (F4 end-to-end).
      inheritedEnv: { PD_SHADOW_TEAM_AUTH: 'fixture-inert-value' },
      probes: cliEntryProbe,
    });
    // ── Pre-flight: ONE sequential cycle executes ONE of the seeded tasks ──
    // (which one is picked depends on equal updated_at ordering — the
    // invariant is the TOTAL, not the identity of the claimed task).
    const preflight = await runOne('conc-preflight');
    expect(['cycle_completed', 'cycle_completed_without_business_progress', 'degraded']).toContain(preflight.cycleOutcome);
    const probeState = await taskState(ws, probeTaskId);
    const raceStatePreflight = await taskState(ws, raceTaskId);
    // F10: the pipeline can actually reach the lease/execution boundary —
    // exactly ONE task was claimed and attempted (≥1 attempt, no longer
    // pending); the other is untouched.
    const attemptsAfterPreflight = probeState.attemptCount + raceStatePreflight.attemptCount;
    expect(attemptsAfterPreflight).toBe(1);
    const claimedAfterPreflight =
      (probeState.status !== 'pending' ? 1 : 0) + (raceStatePreflight.status !== 'pending' ? 1 : 0);
    expect(claimedAfterPreflight).toBe(1);
    // ── Race: two PARALLEL real cycles, one eligible task left (the task
    // claimed in pre-flight is now inside its retry_wait backoff, skipped by
    // both) ──
    const [first, second] = await Promise.all([runOne('conc-a'), runOne('conc-b')]);
    for (const outcome of [first.cycleOutcome, second.cycleOutcome]) {
      expect(['cycle_completed', 'cycle_completed_without_business_progress', 'degraded']).toContain(outcome);
    }
    // THE lease invariant: across BOTH racing consumers exactly ONE further
    // claim happened (total attempts 1 → 2), and NO task was ever attempted
    // twice — a double claim would show an attemptCount of 2.
    const probeStateRace = await taskState(ws, probeTaskId);
    const raceState = await taskState(ws, raceTaskId);
    expect(probeStateRace.attemptCount + raceState.attemptCount).toBe(2);
    expect(probeStateRace.attemptCount).toBeLessThanOrEqual(1);
    expect(raceState.attemptCount).toBeLessThanOrEqual(1);
  }, 240_000);

  it('F11: an aborted coordinator signal cancels the in-flight real worker child, persists the truthful outcome and releases the lock', async () => {
    const home = tempHome();
    const ws = await workspaceWithConfig(home, 'abort-ws', 'host.codex');
    sandboxInstall(home, [ws]);
    const controller = new AbortController();
    // Abort mid-cycle: the real worker takes ~1s, abort fires at ~200ms.
    setTimeout(() => controller.abort(), 200);
    const result = await runServiceShadowOnce({
      workspaces: [ws],
      hostFilter: 'codex',
      trustedHomeDir: home,
      timeoutMs: 120_000,
      signal: controller.signal,
      probes: cliEntryProbe,
    });
    expect(result.ok && result.outcome === 'completed').toBe(true);
    if (!result.ok || result.outcome !== 'completed') return;
    const execution = result.executions[0]?.execution;
    expect(execution?.cycleOutcome).toBe('cancelled');
    expect(execution?.worker.cancelled).toBe(true);
    // The persisted status records the same truthful outcome.
    const statusFile = serviceRunStatusPath(path.join(home, '.pd'));
    const persisted = JSON.parse(readFileSync(statusFile, 'utf8')) as {
      shadow?: { executions?: { workspaceState?: string; execution?: { cycleOutcome?: string } }[] };
    };
    expect(persisted.shadow?.executions?.[0]?.execution?.cycleOutcome).toBe('cancelled');
    // Lock released: a subsequent shadow run on the same install succeeds.
    const next = await runServiceShadowOnce({
      workspaces: [ws],
      hostFilter: 'codex',
      trustedHomeDir: home,
      timeoutMs: 120_000,
      probes: cliEntryProbe,
    });
    expect(next.ok && next.outcome === 'completed').toBe(true);
  }, 240_000);
});
