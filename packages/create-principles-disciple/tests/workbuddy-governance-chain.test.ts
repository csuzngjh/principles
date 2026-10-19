/**
 * R1 chained regression (review 2026-10-13 R1/P1): install → enable → REAL
 * hook chain must produce working governance, not "success=true with a dead
 * config".
 *
 * Confirmed defect chain:
 *   a. install() only mkdir'd the governance workspace — no .pd/config.yaml,
 *      no trajectory.db; the main installer's generic workspace flow never
 *      reaches the WorkBuddy governance dir;
 *   b. enableGovernance wrote a flag entry WITHOUT the schema-required
 *      `category`, which the production validator
 *      (pd-config-validate via loadPdConfigForPlugin) rejects → every hook
 *      invocation degraded with `feature 'host.workbuddy' missing required
 *      field 'category'` and never dispatched;
 *   c. install still reported success=true.
 *
 * This test runs the REAL production boundaries:
 *   - install(): the real WorkBuddyHostInstaller with the fake-engine
 *     registration boundary AND the REAL shared initializer
 *     (`pd-cli runtime init --confirm --workspace <governanceDir>`) — the same
 *     entry the main installer runs for the generic workspace;
 *   - activation injection through the PRODUCTION store writers
 *     (pi_artifacts + SqliteActivationStateStore.recordActivation) — never
 *     direct evidence-table hacks;
 *   - enable via the real enableGovernance() API (config comes from the
 *     install artifacts — the test never hand-writes governance state);
 *   - the REAL plugin wrapper.cjs (the exact transport WorkBuddy executes)
 *     resolving the REAL built dist pd-hook.js under the canonical runtime
 *     dir — NO PD_WORKBUDDY_ADAPTER_ENTRY dev override;
 *   - a real frozen UserPromptSubmit fixture payload.
 *
 * The pd-cli build is required for the DB-initialization half of the chain;
 * without it the test SKIPs with the reason (never faked green).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { WorkBuddyHostInstaller, WORKBUDDY_PLUGIN_KEY } from '../src/installers/workbuddy-host-installer.js';
import { loadPdConfigForPlugin } from '@principles/host-runtime';
import { computeFeatureFlagsFromConfig, SqliteConnection, SqliteActivationStateStore, DEFAULT_FEATURE_FLAGS } from '@principles/core/runtime-v2';
import { logger } from '../src/utils/logger.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const ADAPTER_PKG = path.join(REPO_ROOT, 'packages', 'workbuddy-adapter');
const PD_CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'pd-cli', 'dist', 'index.js');
const FAKE_ENGINE = path.resolve(__dirname, 'fixtures', 'workbuddy-fake-engine.mjs');
const WRAPPER = path.join(ADAPTER_PKG, 'plugin', 'scripts', 'wrapper.cjs');
const USER_PROMPT_FIXTURE = path.join(ADAPTER_PKG, 'tests', 'fixtures', 'host-contract', 'events', 'user-prompt-submit.json');
const TMP = fs.realpathSync(os.tmpdir());

const PD_CLI_AVAILABLE = fs.existsSync(PD_CLI_ENTRY);
const PRINCIPLE_TEXT = 'WB_CHAIN_DIRECTIVE_20261013';

let savedEnv: Record<string, string | undefined>;
const tempDirs: string[] = [];

function track(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

interface ChainLab {
  home: string;
  governance: string;
  project: string;
  installer: WorkBuddyHostInstaller;
}

function makeChainLab(): ChainLab {
  const home = track(fs.mkdtempSync(path.join(TMP, 'pd-wb-chain-home-')));
  // Canonical runtime adapter dir in the fake home → junction to the REAL
  // built adapter package, so the wrapper's no-override resolution
  // (<home>/.pd/runtime/workbuddy-adapter/dist/pd-hook.js) executes the real
  // dist entry with real dependency resolution (install-layout canonical dir).
  const runtimeAdapterDir = path.join(home, '.pd', 'runtime', 'workbuddy-adapter');
  fs.mkdirSync(path.dirname(runtimeAdapterDir), { recursive: true });
  fs.rmSync(runtimeAdapterDir, { recursive: true, force: true });
  fs.symlinkSync(fs.realpathSync(ADAPTER_PKG), runtimeAdapterDir, process.platform === 'win32' ? 'junction' : 'dir');
  const project = track(fs.mkdtempSync(path.join(TMP, 'pd-wb-chain-proj-')));
  const installer = new WorkBuddyHostInstaller({
    homeDir: () => home,
    enginePath: () => FAKE_ENGINE, // deterministic registration boundary (S2 covers the real engine)
    pdCliEntry: () => PD_CLI_ENTRY, // REAL shared initializer
  });
  return { home, governance: path.join(home, '.workbuddy', 'pd-workspace'), project, installer };
}

function runRealWrapper(home: string, payload: Record<string, unknown>, channel: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [WRAPPER, channel], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error) throw new Error(`wrapper spawn failed: ${result.error.message}`);
  return {
    status: result.status ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function fixturePayload(cwd: string): Record<string, unknown> {
  const fixture = JSON.parse(fs.readFileSync(USER_PROMPT_FIXTURE, 'utf8')) as { payload?: unknown };
  if (typeof fixture.payload !== 'object' || fixture.payload === null || Array.isArray(fixture.payload)) {
    throw new Error('user-prompt-submit.json carries no payload object');
  }
  return {
    ...Object.fromEntries(Object.entries(fixture.payload)),
    cwd,
    transcript_path: path.join(cwd, 'session.jsonl'),
  };
}

/** Production store writers only: pi_artifacts row + recordActivation. */
async function injectActivation(governance: string): Promise<void> {
  const connection = new SqliteConnection(governance);
  try {
    const now = new Date().toISOString();
    const artifactId = 'art-wb-chain-1';
    connection.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(artifactId, 'principle', `task-${artifactId}`, 'P_WB_CHAIN', null, '[]', 'validated', JSON.stringify({ principleId: 'P_WB_CHAIN', text: PRINCIPLE_TEXT }), now, now);
    await new SqliteActivationStateStore(connection).recordActivation({
      activationId: 'act-wb-chain-1',
      idempotencyKey: `${artifactId}::prompt`,
      artifactId,
      channel: 'prompt',
      action: 'prompt_activate',
      targetRef: 'ledger://P_WB_CHAIN',
      activatedAt: now,
      deactivatedAt: null,
    });
  } finally {
    connection.close();
  }
}

describe.skipIf(!PD_CLI_AVAILABLE)('R1 chain: real install → enable → real wrapper → real hook dispatch', () => {
  beforeAll(() => {
    savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      WORKBUDDY_CONFIG_DIR: process.env.WORKBUDDY_CONFIG_DIR,
      PD_WORKBUDDY_ADAPTER_ENTRY: process.env.PD_WORKBUDDY_ADAPTER_ENTRY,
    };
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registry drift pin: the flag SSoT registers host.workbuddy as quiet (the category value the installer writes)', () => {
    const flag = DEFAULT_FEATURE_FLAGS.find((entry) => entry.id === 'host.workbuddy');
    expect(flag).toMatchObject({ category: 'quiet' });
  });

  it('produces a loader-valid governance workspace at install, enables with a validator-accepted entry, and the real hook dispatches the activated principle', { timeout: 300_000 }, async () => {
    const lab = makeChainLab();

    // ── 1. REAL install (fake-engine registration + REAL shared runtime init).
    const installResult = await lab.installer.install({
      workspaceDir: path.join(lab.home, 'proj'),
      pluginDir: path.resolve(PACKAGE_ROOT, '..'), // repo packages/ — carries workbuddy-adapter/plugin
      language: 'en',
      mode: 'smart',
    });
    expect(installResult.success, `install failed: ${installResult.reason} Next: ${installResult.nextAction}`).toBe(true);
    expect(installResult.reason, 'governance DB init must RUN (not skip) when the pd-cli entry is available').not.toContain('SKIPPED');

    // Governance state exists and is COMPLETE (config + both databases).
    const configPath = path.join(lab.governance, '.pd', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(path.join(lab.governance, '.pd', 'state.db'))).toBe(true);
    expect(fs.existsSync(path.join(lab.governance, '.state', 'trajectory.db'))).toBe(true);

    // The installed config is loader-valid through the PRODUCTION loader, and
    // install ≠ enable (OD-03): the flag resolves to its registry default OFF.
    const installed = loadPdConfigForPlugin(lab.governance);
    expect(installed.ok, `installed config must validate: ${JSON.stringify(installed.errors)}`).toBe(true);
    expect(computeFeatureFlagsFromConfig(installed.effective).flags['host.workbuddy']?.enabled).toBe(true);
    expect(computeFeatureFlagsFromConfig(installed.effective).flags.workbuddy_live_keyword_pain?.enabled).toBe(true);
    // Exercise legacy disabled-workspace behavior explicitly after testing the new-install default.
    expect(lab.installer.disableGovernance().ok).toBe(true);

    // ── 2. Production-store activation injection (registered, flag still OFF).
    await injectActivation(lab.governance);
    const beforeEnable = runRealWrapper(lab.home, fixturePayload(lab.project), 'UserPromptSubmit');
    expect(beforeEnable.status).toBe(0);
    expect(beforeEnable.stdout.trim(), 'flag OFF → neutral empty stdout (no dispatch)').toBe('');

    // ── 3. Explicit enable through the real API — the entry MUST carry the
    //       registry-required category, or the production validator rejects
    //       the whole config (the R1 defect b).
    const enabled = lab.installer.enableGovernance();
    expect(enabled.ok, `enableGovernance failed: ${enabled.ok ? '' : JSON.stringify(enabled)}`).toBe(true);
    const rawConfig = yaml.load(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, Record<string, unknown>> };
    expect(rawConfig.features['host.workbuddy']).toEqual({ enabled: true, category: 'quiet' });

    const afterEnable = loadPdConfigForPlugin(lab.governance);
    expect(afterEnable.ok, `enabled config must validate through the production loader: ${JSON.stringify(afterEnable.errors)}`).toBe(true);
    expect(computeFeatureFlagsFromConfig(afterEnable.effective).flags['host.workbuddy']?.enabled).toBe(true);

    // ── 4. REAL wrapper → REAL dist hook → REAL dispatch of the activated
    //       principle into additionalContext.
    const dispatched = runRealWrapper(lab.home, fixturePayload(lab.project), 'UserPromptSubmit');
    expect(dispatched.status, `wrapper exit ${dispatched.status}, stderr: ${dispatched.stderr.slice(0, 400)}`).toBe(0);
    expect(dispatched.stderr).not.toContain('missing required field');
    expect(dispatched.stderr).not.toContain('status=degraded');
    const output = JSON.parse(dispatched.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain(PRINCIPLE_TEXT);

    // ── 5. Reversible rollback: disable → the next real hook invocation is a
    //       neutral skip again (OD-03 rollback path).
    const disabled = lab.installer.disableGovernance();
    expect(disabled.ok).toBe(true);
    const afterDisable = runRealWrapper(lab.home, fixturePayload(lab.project), 'UserPromptSubmit');
    expect(afterDisable.status).toBe(0);
    expect(afterDisable.stdout.trim()).toBe('');

    // Registration bookkeeping stayed intact through the whole chain.
    const settings = JSON.parse(fs.readFileSync(path.join(lab.home, '.workbuddy', 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, unknown> };
    expect(settings.enabledPlugins[WORKBUDDY_PLUGIN_KEY]).toBe(true);
  });
});

if (!PD_CLI_AVAILABLE) {
  describe('R1 chain: real install → enable → real wrapper → real hook dispatch', () => {
    it('SKIP: packages/pd-cli/dist/index.js is not built — run the pd-cli build first. NOT RUN, never faked green', () => {
      expect(PD_CLI_AVAILABLE).toBe(false);
    });
  });
}
