#!/usr/bin/env node
/**
 * verify-pinned-runtime-capability.cjs — installed runtime cohort capability probe.
 *
 * Verifies behavior of the installed packages: Owner emergency control,
 * Codex RuleContextV2 suspension, and DesignGate fact validation.
 *
 * It runs against INSTALLED package bytes only — never monorepo source — by
 * resolving @principles/* from --runtime-dir/node_modules (the same layout
 * $pd-control setup produces). Scenarios:
 *
 *   S1 baseline            live eligible RuleCode enforces (deny)
 *   S2 global pause        global_rulecode_pauses.status='paused' → allow + structured reason
 *   S3 safety isolation    activation_control_states.enforcement='safety_isolated' → allow + reason
 *   S4 retired contract    RuleCode referencing removed symbols → skipped, never executed
 *   S5 control released    enforcement resumes (deny)
 *   S6 Codex V2            unavailable context suspends a V2 rule
 *   S7 DesignGate fact     valid fact accepted; mismatched task binding rejected
 *   S8 DesignGate decision actionable not_approved fact is honored without history
 *
 * Usage (stdout is ALWAYS machine-readable JSON):
 *   node verify-pinned-runtime-capability.cjs --runtime-dir <dir> [--workspace <dir>]
 *   node verify-pinned-runtime-capability.cjs --install   (temp dir; npm-installs the pins from runtime-version.json)
 *
 * Exit 0 = all scenarios PASS. Any FAIL exits 1 with structured JSON
 * (identity evidence + per-scenario results), so release gates and CI can
 * branch on the machine-readable contract.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Structured probe failure. As a module: thrown to the caller. As a CLI:
 * caught in main(), printed as machine-readable JSON, exit 1.
 */
class ProbeFailure extends Error {
  constructor(reason, nextAction, extra) {
    super(reason);
    this.payload = { ok: false, reason, nextAction, ...extra };
  }
}

function fail(reason, nextAction, extra) {
  throw new ProbeFailure(reason, nextAction, extra);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install') args.install = true;
    else if (a === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (a === '--workspace') args.workspace = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      // PRI-810 review: unknown args are rejected, not silently ignored.
      throw new ProbeFailure('probe_unknown_argument:' + a, 'supported flags: --runtime-dir <dir> | --workspace <dir> | --install | --help');
    }
  }
  return args;
}

function readPins(pluginRoot) {
  const pinsPath = path.join(pluginRoot, 'runtime-version.json');
  let pins;
  try {
    pins = JSON.parse(fs.readFileSync(pinsPath, 'utf8'));
  } catch (error) {
    fail('runtime_version_file_invalid:' + String(error && error.message).slice(0, 160), 'run from a plugin checkout that contains runtime-version.json');
  }
  for (const key of ['codexAdapter', 'hostRuntime', 'core']) {
    if (typeof pins[key] !== 'string' || pins[key].length === 0) {
      fail('runtime_version_file_invalid:missing_' + key, 'repair runtime-version.json before probing');
    }
  }
  return pins;
}

function installPinnedRuntime(pins) {
  // Pin values come from our own runtime-version.json — enforce a strict
  // version-token shape anyway, so shell assembly below can never be abused.
  for (const key of ['codexAdapter', 'hostRuntime', 'core']) {
    if (!/^[A-Za-z0-9.+-]+$/.test(pins[key])) {
      fail('runtime_version_file_invalid:bad_token:' + key, 'pin versions must be plain semver tokens');
    }
  }
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pin-probe-runtime-'));
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({ name: 'pd-pin-probe-runtime', private: true }, null, 2));
  const command = 'npm install --no-audit --no-fund --loglevel=error --omit=dev '
    + '@principles/codex-adapter@' + pins.codexAdapter
    + ' @principles/host-runtime@' + pins.hostRuntime
    + ' @principles/core@' + pins.core;
  const install = spawnSync(command, { cwd: runtimeDir, encoding: 'utf8', timeout: 300_000, shell: true, windowsHide: true });
  if (install.status !== 0) {
    fail('probe_runtime_install_failed:' + String(install.stderr || install.stdout || '').slice(0, 300).replace(/\s+/g, ' '), 'check network/npm access, or whether the pinned versions are published');
  }
  return runtimeDir;
}

/**
 * Module entry: run the capability matrix against an installed runtime.
 * Returns the machine-readable payload; throws ProbeFailure on setup errors.
 * CLI wrapper at the bottom turns payload/failure into stdout JSON + exit code.
 */
async function verifyPinnedRuntimeCapability(options = {}) {
  const useInstall = options.install === true;

  const pluginRoot = path.resolve(__dirname, '..');
  const pins = readPins(pluginRoot);

  let runtimeDir = options.runtimeDir;
  if (useInstall) runtimeDir = installPinnedRuntime(pins);
  if (!runtimeDir || !fs.existsSync(path.join(runtimeDir, 'node_modules'))) {
    fail('runtime_dir_invalid', 'pass --runtime-dir <dir whose node_modules holds the installed @principles/*>, or use --install');
  }

  const requireFromRuntime = require('node:module').createRequire(path.join(runtimeDir, 'node_modules', 'probe-cjs-bridge.js'));

  // ── §16 identity evidence: exact installed versions + physical paths ──
  const identities = [];
  for (const pkg of ['@principles/codex-adapter', '@principles/host-runtime', '@principles/core']) {
    let info;
    try {
      const manifestPath = requireFromRuntime.resolve(pkg + '/package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      info = { pkg, version: manifest.version, physical: manifestPath.split(path.sep).join('/').replace('/package.json', '') };
    } catch (error) {
      fail('probe_package_unresolved:' + pkg + ':' + String(error && error.message).slice(0, 120), 're-run $pd-control setup so the pinned runtime is installed');
    }
    identities.push(info);
  }

  // ── canonical workspace state bootstrap (INSTALLED core, not source) ──
  let SqliteConnection;
  let createProductionRuleHostGate;
  let validateRuleContextV2;
  try {
    ({ SqliteConnection } = requireFromRuntime('@principles/core/runtime-v2'));
    ({ validateRuleContextV2 } = requireFromRuntime('@principles/core/runtime-v2'));
    ({ createProductionRuleHostGate } = requireFromRuntime('@principles/host-runtime'));
  } catch (error) {
    fail('probe_import_failed:' + String(error && error.message).slice(0, 200), 'verify the installed runtime layout matches $pd-control setup output');
  }
  if (typeof createProductionRuleHostGate !== 'function' || typeof validateRuleContextV2 !== 'function') {
    fail('probe_capability_not_exported', 'installed packages omit the production gate or RuleContextV2 validator required by this behavior probe');
  }

  const workspaceDir = options.workspace || fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pin-probe-ws-'));
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const connection = new SqliteConnection({ workspaceDir, bootstrapIfMissing: true });
  const db = connection.getDb();

  for (const table of ['pi_artifacts', 'activations', 'activation_control_states', 'global_rulecode_pauses']) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
    if (!row) {
      fail('canonical_control_table_missing:' + table, 'the installed core predates the Owner-control schema — re-pin to a version at or above the Owner-control floor (see runtime-pin-guard.test.ts; PRI-810)');
    }
  }

  // Fixture note (PRI-810 spec §18): control states are written via direct
  // SQL ONLY because this probe layer IS the canonical-store fixture layer —
  // the schema comes from the installed core's own bootstrap. The production
  // WRITER (SqliteActivationSafetyStore authorized-decision path) is
  // deliberately not exercised here: this probe verifies the GATE's honoring
  // of control states, not the store's writing of them.
  const now = () => new Date().toISOString();
  function activate(contentCode, options = {}) {
    const contentJson = JSON.stringify({
      implementationCode: contentCode, ruleId: 'R_PIN_PROBE', principleId: 'P_PIN_PROBE',
      ...(options.requiresContextVersion === 2 ? { requiresContextVersion: 2 } : {}),
      ...(options.ruleHostInputContract ? { ruleHostInputContract: options.ruleHostInputContract } : {}),
    });
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('art-pin-probe', 'rule', 'task-pin-probe', '[]', 'valid', contentJson, now(), now());
    db.prepare(`INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at) VALUES (?,?,?,?,?,?,?)`)
      .run('act-pin-probe', 'idem-pin-probe', 'art-pin-probe', 'code_tool_hook', 'code_tool_hook_live_activate', '/etc/passwd', now());
    db.prepare(`INSERT INTO activation_control_states (activation_id, enforcement, version, updated_at) VALUES (?,?,?,?)`)
      .run('act-pin-probe', 'eligible', 1, now());
  }
  function resetFixture() {
    db.prepare(`DELETE FROM activation_control_states`).run();
    db.prepare(`DELETE FROM global_rulecode_pauses`).run();
    db.prepare(`DELETE FROM activations`).run();
    db.prepare(`DELETE FROM pi_artifacts`).run();
  }
  function setPause(status) {
    db.prepare(`DELETE FROM global_rulecode_pauses`).run();
    if (status) {
      db.prepare(`INSERT INTO global_rulecode_pauses (pause_id, status, incident_decision_id, affected_activation_ids, paused_at, version) VALUES (?,?,?,?,?,?)`)
        .run('pause-pin-probe', status, 'probe-incident', '[]', now(), 1);
    }
  }
  function setEnforcement(value) {
    db.prepare(`UPDATE activation_control_states SET enforcement = ?, updated_at = ? WHERE activation_id = 'act-pin-probe'`).run(value, now());
  }

  const RULE_BLOCK = `function evaluate(input, helpers) {
  var p = input.action.paramsSummary;
  if (p && p.filePath === '/etc/passwd') {
    return { decision: 'block', matched: true, reason: 'system path blocked' };
  }
  return { decision: 'allow', matched: false, reason: 'safe path' };
}`;
  const RULE_RETIRED = `function evaluate(input, helpers) {
  var t = input.recentThinking;
  return { decision: 'block', matched: true, reason: 'retired:' + String(t) };
}`;
  const RULE_V2_BLOCK = `function evaluate(input, helpers) {
  return { decision: 'block', matched: true, reason: 'V2_CONTEXT_REQUIRED' };
}`;
  const RULE_DESIGN_GATE_BLOCK = `function evaluate(input, helpers) {
  var fact = input.context && input.context.facts && input.context.facts.designGate;
  if (fact && fact.resolution === 'not_approved' && fact.taskRef === 'task-probe') {
    return { decision: 'block', matched: true, reason: 'DESIGN_GATE_NOT_APPROVED' };
  }
  return { decision: 'allow', matched: false, reason: 'DESIGN_GATE_NOT_MATCHED' };
}`;

  const gate = createProductionRuleHostGate();
  const dispatch = () => gate({
    source: 'before_tool_call',
    context: { workspaceDir, sessionId: 'pin-probe', toolName: 'edit' },
    rawPayload: { toolInput: { toolName: 'edit', params: { filePath: '/etc/passwd', content: 'x' } } },
  });
  const summarize = (r) => ({
    decision: r && r.decision,
    warnings: ((r && r.warnings) || []).map((w) => String(typeof w === 'string' ? w : (w && w.code) || JSON.stringify(w)).slice(0, 120)),
  });

  const scenarios = [
    {
      name: 'S1 baseline live rule enforces',
      setup: () => activate(RULE_BLOCK),
      expect: (s) => s.decision === 'deny',
      nextAction: 'inspect the installed gate evaluation path',
    },
    {
      name: 'S2 Owner global pause is honored',
      setup: () => { activate(RULE_BLOCK); setPause('paused'); },
      expect: (s) => s.decision === 'allow' && s.warnings.some((w) => w.startsWith('global_rulecode_pause_active')),
      nextAction: 'the installed host-runtime ignores global_rulecode_pauses — select a published package version that passes this behavior probe',
    },
    {
      name: 'S3 safety isolation is honored',
      setup: () => { activate(RULE_BLOCK); setEnforcement('safety_isolated'); },
      expect: (s) => s.decision === 'allow' && s.warnings.some((w) => w.startsWith('activation_safety_isolated')),
      nextAction: 'the installed host-runtime ignores activation_control_states — select a published package version that passes this behavior probe',
    },
    {
      name: 'S4 retired-contract RuleCode is skipped',
      setup: () => activate(RULE_RETIRED),
      expect: (s) => s.decision === 'allow' && s.warnings.some((w) => w.startsWith('legacy_rule_contract_dependency')),
      nextAction: 'the installed host-runtime executes retired-contract RuleCode — select a published package version that passes this behavior probe',
    },
    {
      name: 'S5 enforcement resumes after control release',
      setup: () => activate(RULE_BLOCK),
      expect: (s) => s.decision === 'deny',
      nextAction: 'inspect the installed gate evaluation path',
    },
    {
      name: 'S6 Codex V2 rule suspends when context is unavailable',
      setup: () => activate(RULE_V2_BLOCK, { requiresContextVersion: 2 }),
      expect: (s) => s.decision === 'allow' && s.warnings.some((w) => w.startsWith('rule_context_v2_unavailable')),
      nextAction: 'the installed host-runtime must suspend a V2 rule when its RuleContextV2 provider is unavailable',
    },
  ];

  const results = [];
  let failures = 0;
  for (const scenario of scenarios) {
    resetFixture();
    scenario.setup();
    let outcome;
    try {
      outcome = summarize(await dispatch());
    } catch (error) {
      outcome = { decision: 'probe_threw', warnings: [String(error && error.message).slice(0, 200)] };
    }
    const pass = scenario.expect(outcome);
    if (!pass) failures++;
    results.push({ name: scenario.name, pass, outcome, nextActionOnFail: scenario.nextAction });
  }

  const validDesignGateContext = {
    version: 2,
    history: { status: 'unavailable', unavailableReason: 'probe', truncated: false, calls: [] },
    facts: {
      priorReadOfTarget: 'unknown', readCount: null, writeCount: null,
      uniqueWritePathCount: null, sameActionBlockCount: null,
      designGate: {
        version: 1, resolution: 'not_approved', sourceRef: 'probe://design', revision: 1, requiresApproval: true,
        taskRef: 'task-probe', specDigest: 'sha256:probe', scopeRef: 'scope-probe',
        decisionTaskRef: 'task-probe', decisionSpecDigest: 'sha256:probe', decisionScopeRef: 'scope-probe', revoked: false,
      },
    },
  };
  const badDesignGateContext = {
    ...validDesignGateContext,
    facts: { ...validDesignGateContext.facts, designGate: { ...validDesignGateContext.facts.designGate, decisionTaskRef: 'task-other' } },
  };
  const validFact = validateRuleContextV2(validDesignGateContext);
  const badFact = validateRuleContextV2(badDesignGateContext);
  let badFactGateOutcome;
  try {
    resetFixture();
    activate(RULE_V2_BLOCK, { requiresContextVersion: 2 });
    badFactGateOutcome = summarize(await createProductionRuleHostGate({ ruleContextProvider: () => badDesignGateContext })({
      source: 'before_tool_call',
      context: { workspaceDir, sessionId: 'pin-probe', toolName: 'edit' },
      rawPayload: { toolInput: { toolName: 'edit', params: { filePath: '/etc/passwd', content: 'x' } } },
    }));
  } catch (error) {
    badFactGateOutcome = { decision: 'probe_threw', warnings: [String(error && error.message).slice(0, 200)] };
  }
  const designGateResult = {
    name: 'S7 DesignGate fact binding is validated and an unbound fact cannot execute a V2 rule',
    pass: validFact.valid === true && badFact.valid === false
      && badFact.errors.some((error) => error.includes('designGate'))
      && badFactGateOutcome.decision === 'allow'
      && badFactGateOutcome.warnings.some((warning) => warning.startsWith('rule_context_invalid:')),
    outcome: { validFact, badFact, gate: badFactGateOutcome },
    nextActionOnFail: 'install core/host-runtime versions that validate DesignGateFact bindings and reject unbound facts before RuleCode evaluation',
  };
  results.push(designGateResult);
  if (!designGateResult.pass) failures++;

  let actionableDesignGateOutcome;
  try {
    resetFixture();
    activate(RULE_DESIGN_GATE_BLOCK, {
      requiresContextVersion: 2,
      ruleHostInputContract: { version: 1, contextVersion: 2, requiredFactKinds: ['design_approval'] },
    });
    const result = await createProductionRuleHostGate({ ruleContextProvider: () => validDesignGateContext })({
      source: 'before_tool_call',
      context: { workspaceDir, sessionId: 'pin-probe', toolName: 'edit' },
      rawPayload: { toolInput: { toolName: 'edit', params: { filePath: '/etc/passwd', content: 'x' } } },
    });
    actionableDesignGateOutcome = {
      decision: result.decision,
      warnings: (result.warnings || []).map((warning) => String(warning).slice(0, 120)),
      evaluatedLiveRules: result.metadata && result.metadata.evaluatedLiveRules,
    };
  } catch (error) {
    actionableDesignGateOutcome = { decision: 'probe_threw', warnings: [String(error && error.message).slice(0, 200)] };
  }
  const actionableDesignGateResult = {
    name: 'S8 DesignGate not_approved blocks without available history',
    pass: actionableDesignGateOutcome.decision === 'deny' && actionableDesignGateOutcome.evaluatedLiveRules === 1,
    outcome: actionableDesignGateOutcome,
    nextActionOnFail: 'the installed host-runtime must enforce an actionable DesignGate decision even when trajectory history is unavailable',
  };
  results.push(actionableDesignGateResult);
  if (!actionableDesignGateResult.pass) failures++;

  const payload = {
    ok: failures === 0,
    mode: useInstall ? 'install+probe' : 'probe',
    identities,
    scenarioResults: results,
    result: failures === 0
      ? 'installed runtime satisfies Owner-control, Codex V2, and DesignGate capability contracts'
      : failures + ' scenario(s) FAILED — installed packages do not satisfy the pinned capability contract',
  };
  return payload;
}

module.exports = { verifyPinnedRuntimeCapability };

if (require.main === module) {
  // PRI-810 review: set process.exitCode instead of calling process.exit()
  // so piped stdout is always fully flushed before the process ends.
  // (async IIFE: top-level `return` is not parseable by rolldown/vite here.)
  void (async () => {
    let args;
    try {
      args = parseArgs(process.argv);
    } catch (error) {
      const payload = error instanceof ProbeFailure
        ? error.payload
        : { ok: false, reason: 'probe_argument_error', nextAction: 'pass --help for usage' };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
    if (args.help) {
      process.stdout.write('see file header for usage\n');
      return;
    }
    try {
      const payload = await verifyPinnedRuntimeCapability(args);
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = payload.ok ? 0 : 1;
    } catch (error) {
      const payload = error instanceof ProbeFailure
        ? error.payload
        : { ok: false, reason: 'probe_unexpected_error:' + String(error && error.stack ? error.stack.split('\n')[0] : error).slice(0, 200), nextAction: 'inspect the probe output and the installed runtime' };
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = 1;
    }
  })();
}
