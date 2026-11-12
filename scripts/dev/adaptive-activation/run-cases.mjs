#!/usr/bin/env node
// PRI-1182 acceptance runner.
//
//   node scripts/dev/adaptive-activation/run-cases.mjs --preflight
//   node scripts/dev/adaptive-activation/run-cases.mjs --approved <approval.json>
//
// Both modes drive the BUILT hook subprocess (`packages/codex-adapter/dist/pd-hook.js`)
// with the frozen shared-window cases under docs/implementation-reports/.
//
// `--preflight` installs an ESM preload that replaces global fetch with a fake
// Decisions endpoint, so the code path is real and the network is not: the
// preload throws on any non-Decisions URL and counts every body it served.
// `--approved` asserts FIRST that an approval binds the current head/tree/
// manifest hash, has not expired, and caps the batch, and only then sends at
// most ONE real request per case (pure-ack must send zero).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as yaml from 'js-yaml';
import {getDefaultPdConfig, validatePdConfig} from '@principles/core/runtime';
import {seedFixtureWorkspace, measureFixtureCosts} from '../adaptive-selector-lab/fixture-workspace.mjs';
import {
  ADAPTIVE_DECISION_CRITERIA,
  adjudicateDecision,
} from '../../../packages/host-runtime/dist/adaptive-decision-protocol.js';
import {CODEX_ADAPTIVE_DECISION_MS} from '../../../packages/codex-adapter/dist/pd-hook.js';
import {decideAdaptiveSkip} from '../../../packages/host-runtime/dist/adaptive-skip-decision.js';
import {
  assertFreshResults,
  claimApproval,
  claimRecord,
  hashBuildArtifacts,
  reserveRequest,
  verifyApproval,
} from './approval-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const ORIGINAL_REPORT_DIR = path.join(ROOT, 'docs', 'implementation-reports', 'adaptive-activation-pri-1182');
const REPORT_DIR = ORIGINAL_REPORT_DIR + '-shared-window';
const CASES_FILE = path.join(REPORT_DIR, 'cases.json');
const OVERRIDES_FILE = path.join(ORIGINAL_REPORT_DIR, 'isolated-config.yaml');
const HOOK = path.join(ROOT, 'packages', 'codex-adapter', 'dist', 'pd-hook.js');
const PRELOAD = path.join(HERE, 'fake-decisions.mjs');
const RESULTS_FILE = path.join(REPORT_DIR, 'results.json');
const CLAIM_FILE = path.join(REPORT_DIR, 'approval-claim.json');
const CHARS_PER_TOKEN = 32;

const approvalIndex = process.argv.indexOf('--approved');
const MODE = process.argv.includes('--preflight')
  ? 'preflight'
  : (approvalIndex >= 0 ? 'approved' : null);
const APPROVAL_FILE = approvalIndex >= 0 ? process.argv[approvalIndex + 1] : null;

if (MODE === null) fail('usage: --preflight | --approved <approval.json>');
if (MODE === 'approved' && (!APPROVAL_FILE || APPROVAL_FILE.startsWith('--'))) fail('--approved needs a file');

const problems = [];
const results = [];
const check = (label, condition, detail) => {
  if (!condition) problems.push(`${label}${detail === undefined ? '' : `: ${detail}`}`);
  return condition;
};

const git = (args) => execFileSync('git', args, {cwd: ROOT, encoding: 'utf8'}).trim();
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const candidateText = (entry) => entry.text.repeat(entry.repeat ?? 1);

const manifestBytes = fs.readFileSync(CASES_FILE);
const manifestSha256 = crypto.createHash('sha256').update(manifestBytes).digest('hex');
const cases = JSON.parse(manifestBytes.toString('utf8'));
const overrides = yaml.load(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
const route = cases.route;
check('compiled Codex decision window matches the frozen manifest',
  CODEX_ADAPTIVE_DECISION_MS === cases.envelope.totalMs, String(CODEX_ADAPTIVE_DECISION_MS));

// ── 1. Frozen route + criteria + exact response allowlist ────────────────────
const baseConfig = getDefaultPdConfig();
for (const [key, value] of Object.entries(overrides.features ?? {})) {
  if (baseConfig.features[key] === undefined) {
    check('config.features key exists', false, key);
    continue;
  }
  Object.assign(baseConfig.features[key], value);
}
const activation = overrides.adaptiveActivation ?? {};
const configFor = (budgetChars, adaptive) => {
  const config = structuredClone(baseConfig);
  config.adaptiveActivation = {
    endpoint: activation.endpoint,
    model: activation.model,
    apiKeyEnv: activation.apiKeyEnv,
    ...(activation.provider ? {provider: activation.provider} : {}),
    ...(activation.responseModels ? {responseModels: [...activation.responseModels]} : {}),
  };
  config.promptBudget = {hosts: {codex: Math.max(1024, Math.round(budgetChars * CHARS_PER_TOKEN))}};
  // The Native comparison arm must be OFF even though the isolated overrides
  // enable the flag for the Adaptive arm.
  config.features['host.codex.adaptive_activation'].enabled = adaptive === true;
  config.features['host.codex'].enabled = true;
  return config;
};
const probeConfig = configFor(4000, true);
const validated = validatePdConfig(probeConfig);
check('isolated config passes core validation', validated.ok,
  (validated.errors ?? []).map((error) => `${error.path} ${error.message}`).join('; '));
check('endpoint is the frozen one', probeConfig.adaptiveActivation.endpoint === route.endpoint,
  probeConfig.adaptiveActivation.endpoint);
check('request model is frozen', probeConfig.adaptiveActivation.model === route.model,
  probeConfig.adaptiveActivation.model);
check('provider pin is frozen', probeConfig.adaptiveActivation.provider === route.provider,
  String(probeConfig.adaptiveActivation.provider));
check('responseModels is the EXACT frozen allowlist',
  JSON.stringify(probeConfig.adaptiveActivation.responseModels) === JSON.stringify(route.responseModels),
  JSON.stringify(probeConfig.adaptiveActivation.responseModels));
check('criteria version is v1-20261111', cases.criteria.version === 'v1-20261111');
for (const key of ['selectThreshold', 'leadMargin', 'insufficientThreshold']) {
  check(`criteria ${key} frozen at ${cases.criteria[key]}`, ADAPTIVE_DECISION_CRITERIA[key] === cases.criteria[key],
    String(ADAPTIVE_DECISION_CRITERIA[key]));
}
const decisionCases = cases.cases.filter((entry) => entry.kind === 'decision');
const skipCases = cases.cases.filter((entry) => entry.kind === 'skip');
const expectedSends = decisionCases.reduce((sum, entry) => sum + entry.expected.sends, 0);
check('exactly one zero-request control', skipCases.length === 1 && skipCases[0].expected.sends === 0);
check('request cap covers the frozen cases', expectedSends <= cases.requestBudget.total,
  `${expectedSends} > ${cases.requestBudget.total}`);

// ── 2. Replay the frozen scores through the shipped adjudicator ──────────────
for (const entry of decisionCases) {
  const refs = entry.order.map((_, index) => `c${index + 1}`);
  // The shipped adjudicator reads the wire question ids (`candidate_c1`, ...).
  const wireScores = Object.fromEntries(Object.entries(entry.recordedScores).map(([id, value]) => [
    id === 'insufficient_context' ? id : `candidate_${id}`,
    value,
  ]));
  const outcome = adjudicateDecision(wireScores, refs.map((ref) => ({ref})));
  check(`replay ${entry.id} decision`, outcome.status === entry.expected.decision,
    `${outcome.status} != ${entry.expected.decision}`);
  check(`replay ${entry.id} reason`, outcome.reason === entry.expected.reason,
    `${outcome.reason} != ${entry.expected.reason}`);
  check(`replay ${entry.id} ref`, (outcome.ref ?? null) === entry.expected.ref,
    `${String(outcome.ref)} != ${String(entry.expected.ref)}`);
  const skip = decideAdaptiveSkip({
    kind: 'before_prompt_build',
    sessionId: 's-pri-1182',
    turnId: 't-pri-1182',
    prompt: entry.prompt,
    remainingBudgetMs: cases.envelope.totalMs,
  });
  check(`replay ${entry.id} enters evaluation inside the shared scoring window`, skip.skip === false, skip.reason);
}
for (const entry of skipCases) {
  const skip = decideAdaptiveSkip({
    kind: 'before_prompt_build',
    sessionId: 's-pri-1182',
    turnId: 't-pri-1182',
    prompt: entry.prompt,
    remainingBudgetMs: cases.envelope.totalMs,
  });
  check(`replay ${entry.id} skips without sending`, skip.skip === true && skip.reason === entry.expected.skipReason,
    String(skip.reason));
}

// ── 3. Approved mode: bind the approval, claim it, THEN send ────────────────
const head = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const isolatedConfigSha256 = sha256(OVERRIDES_FILE);
const binding = {
  codeHead: head,
  treeHash: tree,
  manifestSha256,
  isolatedConfigSha256,
  buildArtifactsSha256: hashBuildArtifacts(ROOT),
  route,
  envelopeTotalMs: cases.envelope.totalMs,
  criteriaVersion: cases.criteria.version,
  cardExpiresAt: cases.expiresAt,
  maxRequests: cases.requestBudget.total,
};
let approval = null;
let approvalSha256 = null;
let claim = null;
if (MODE === 'approved') {
  approvalSha256 = sha256(path.resolve(APPROVAL_FILE));
  approval = JSON.parse(fs.readFileSync(path.resolve(APPROVAL_FILE), 'utf8'));
  check('tracked files match the approved commit', git(['status', '--porcelain', '--untracked-files=no']) === '');
  const verdict = verifyApproval({approval, binding});
  for (const problem of verdict.problems) {
    problems.push(`${problem.code}${problem.field ? `:${problem.field}` : ''}`
      + `${problem.approved === undefined ? '' : ` approved=${String(problem.approved)}`}`
      + `${problem.actual === undefined ? '' : ` actual=${String(problem.actual)}`}`);
  }
  check('API key is present', Boolean(process.env[route.apiKeyEnv]), route.apiKeyEnv);
  const fresh = assertFreshResults(RESULTS_FILE);
  check('no earlier results artifact', fresh.ok, fresh.resultsPath);
  if (problems.length > 0) {
    console.error('REFUSING to send real requests:');
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(2);
  }
  claim = claimRecord({
    approvalSha256,
    approvalFile: path.basename(APPROVAL_FILE),
    binding,
    caseIds: cases.cases.map((entry) => entry.id),
    maxRequests: cases.requestBudget.total,
  });
  const claimed = claimApproval({claimPath: CLAIM_FILE, record: claim});
  if (!claimed.ok) {
    console.error(`REFUSING to send real requests: ${claimed.reason} at ${claimed.claimPath}`);
    console.error('One approval authorises one batch. A new batch needs a new approval and a new card.');
    process.exit(2);
  }
  console.log(`approval claimed: ${CLAIM_FILE}`);
}

// ── 4. Drive the built subprocess ────────────────────────────────────────────
const runRoot = path.join(ROOT, '.tmp', `pri-1182-${MODE}-${Date.now()}`);
fs.mkdirSync(runRoot, {recursive: true});
const countFile = path.join(runRoot, 'fake-request-count.log');
fs.writeFileSync(countFile, '');
const counts = () => fs.readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length;

function runHook({workspaceDir, prompt, adaptive, budgetChars, fakeScores, fakeProvider = route.provider}) {
  const configPath = path.join(workspaceDir, '.pd', 'config.yaml');
  fs.writeFileSync(configPath, yaml.dump(configFor(budgetChars, adaptive)), 'utf8');
  const configSha256 = sha256(configPath);
  const env = {...process.env, CODEX_HOME: path.join(workspaceDir, 'codex-home')};
  env[route.apiKeyEnv] = MODE === 'preflight' ? 'preflight-no-network' : process.env[route.apiKeyEnv];
  if (MODE === 'preflight') {
    env.PD_FAKE_SCORES = JSON.stringify(fakeScores ?? {});
    env.PD_FAKE_COUNT_FILE = countFile;
    env.PD_FAKE_MODEL = route.responseModels[route.responseModels.length - 1];
    env.PD_FAKE_PROVIDER = fakeProvider;
  }
  const payload = JSON.stringify({
    session_id: 's-pri-1182',
    turn_id: 't-pri-1182',
    transcript_path: null,
    cwd: workspaceDir,
    model: 'gpt-5.6',
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
  });
  const args = MODE === 'preflight' ? ['--import', pathToFileURL(PRELOAD).href, HOOK] : [HOOK];
  const startedAt = Date.now();
  const proc = spawnSync(process.execPath, args, {
    input: payload,
    env,
    cwd: workspaceDir,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const wallClockMs = Date.now() - startedAt;
  let stdout = {};
  try {
    stdout = JSON.parse(proc.stdout || '{}');
  } catch {
    problems.push(`hook stdout is not JSON for ${path.basename(workspaceDir)}: ${proc.stdout}`);
  }
  const stderr = proc.stderr ?? '';
  const line = stderr.split('\n').find((entry) => entry.startsWith('[PD] status=')) ?? '';
  const diagnostic = {};
  for (const match of line.matchAll(/([A-Za-z]+)=([^\s]+)/gu)) diagnostic[match[1]] = match[2];
  const scores = {};
  for (const part of (diagnostic.scores ?? '').split(',')) {
    const [id, value] = part.split('=');
    if (id && value !== undefined) scores[id] = Number(value);
  }
  const end = diagnostic.validatedAt ?? diagnostic.cancelledAt;
  return {
    additionalContext: stdout?.hookSpecificOutput?.additionalContext ?? '',
    status: proc.status,
    diagnostic,
    scores,
    wallClockMs,
    configSha256,
    stderr,
    requestLatencyMs: end && diagnostic.requestSentAt
      ? Number(end) - Number(diagnostic.requestSentAt)
      : null,
  };
}

async function prepareCase(entry) {
  const dir = path.join(runRoot, entry.id);
  fs.mkdirSync(dir, {recursive: true});
  await seedFixtureWorkspace(dir, entry.order.map((key) => ({
    key,
    principleId: key,
    text: candidateText(cases.candidates[key]),
  })));
  const costs = await measureFixtureCosts(dir);
  const budgetChars = entry.budget === 'big-first-cannot-fit'
    ? costs.base + costs.byPrincipleId.BIG + 5
    : costs.base + costs.byPrincipleId.SCOPE + costs.byPrincipleId.DELIVERY + 10;
  return {dir, budgetChars};
}

const deliveryText = candidateText(cases.candidates.DELIVERY);
const cap = cases.requestBudget.total;
let sentSoFar = 0;
for (const entry of cases.cases) {
  const {dir, budgetChars} = await prepareCase(entry);
  const nativeBefore = counts();
  const native = runHook({workspaceDir: dir, prompt: entry.prompt, adaptive: false, budgetChars});
  if (MODE === 'preflight') {
    check(`${entry.id} Native arm sends nothing`, counts() === nativeBefore);
  } else {
    check(`${entry.id} Native arm reports zero sends`, (native.diagnostic.sends ?? '0') === '0',
      native.diagnostic.sends);
  }
  const before = counts();
  if (entry.kind === 'decision') {
    // Pre-send reservation: fail closed BEFORE the subprocess can open a socket.
    const reserved = reserveRequest({sentSoFar, cap, caseId: entry.id});
    if (!reserved.ok) {
      fail(`REFUSING to send real requests: ${reserved.reason} at ${entry.id} `
        + `(already sent=${sentSoFar}, cap=${cap})`);
    }
  }
  const adaptive = runHook({
    workspaceDir: dir,
    prompt: entry.prompt,
    adaptive: true,
    budgetChars,
    fakeScores: entry.recordedScores,
    fakeProvider: entry.id === 'append' ? '' : route.provider,
  });
  const sends = MODE === 'preflight'
    ? counts() - before
    : Number(adaptive.diagnostic.sends ?? Number.NaN);
  if (!Number.isInteger(sends)) {
    fail(`REFUSING to continue: ${entry.id} did not report a request count `
      + `(${adaptive.diagnostic.sends ?? 'absent'})`);
  }
  if (sends > 1) {
    fail(`REFUSING to continue: ${entry.id} sent ${sends} requests in one attempt (per-case cap is 1)`);
  }
  sentSoFar += sends;

  check(`${entry.id} sends`, sends === entry.expected.sends, `${sends} != ${entry.expected.sends}`);
  check(`${entry.id} exit status`, adaptive.status === 0, String(adaptive.status));

  if (entry.kind === 'skip') {
    check(`${entry.id} never reaches the endpoint`, sends === 0);
    check(`${entry.id} final body is Native`, adaptive.additionalContext === native.additionalContext);
    check(`${entry.id} reason`,
      adaptive.diagnostic.reason === `adaptive_selection_skipped:${entry.expected.skipReason}`,
      adaptive.diagnostic.reason ?? adaptive.stderr);
    check(`${entry.id} reports zero sends`, adaptive.diagnostic.sends === '0', adaptive.diagnostic.sends);
  } else {
    const status = adaptive.diagnostic.decision?.split(':')[0];
    const allowed = entry.expected.allowedRealDecisions ?? [entry.expected.decision];
    check(`${entry.id} decision is in the frozen allowed set`, allowed.includes(status),
      adaptive.diagnostic.decision ?? adaptive.stderr);
    if (entry.expected.decision === 'selected') {
      check(`${entry.id} selected ref`, adaptive.diagnostic.decision?.split(':')[2] === entry.expected.ref,
        adaptive.diagnostic.decision);
      check(`${entry.id} model identity is in the exact allowlist`,
        route.responseModels.includes(adaptive.diagnostic.modelObserved), adaptive.diagnostic.modelObserved);
      const observedProvider = adaptive.diagnostic.providerObserved ?? 'absent';
      check(`${entry.id} provider field`,
        observedProvider === 'absent' || observedProvider.toLowerCase() === route.provider.toLowerCase(),
        observedProvider);
      check(`${entry.id} measured to a validated table`,
        adaptive.requestLatencyMs !== null && adaptive.requestLatencyMs <= cases.envelope.totalMs,
        String(adaptive.requestLatencyMs));
    }
    if (entry.expected.finalBody === 'delivery_added') {
      check(`${entry.id} Native misses DELIVERY`, !native.additionalContext.includes(deliveryText));
      check(`${entry.id} Adaptive adds DELIVERY`, adaptive.additionalContext.includes(deliveryText));
    } else if (entry.expected.finalBody === 'native_keeps_big') {
      check(`${entry.id} final body is Native (does not fit)`,
        adaptive.additionalContext === native.additionalContext);
      check(`${entry.id} Native keeps BIG`,
        native.additionalContext.includes('避免为假设的未来需求预建抽象和额外服务'));
    } else {
      check(`${entry.id} final body is Native`, adaptive.additionalContext === native.additionalContext);
    }
  }

  results.push({
    id: entry.id,
    kind: entry.kind,
    purpose: entry.purpose,
    sends,
    decision: adaptive.diagnostic.decision ?? null,
    scores: adaptive.scores,
    modelObserved: adaptive.diagnostic.modelObserved ?? null,
    providerObserved: adaptive.diagnostic.providerObserved ?? 'absent',
    reason: adaptive.diagnostic.reason ?? null,
    stage: adaptive.diagnostic.stage ?? null,
    httpStatus: adaptive.diagnostic.httpStatus ?? null,
    firstByteAt: adaptive.diagnostic.firstByteAt ?? null,
    requestSentAt: adaptive.diagnostic.requestSentAt ?? null,
    validatedAt: adaptive.diagnostic.validatedAt ?? null,
    cancelledAt: adaptive.diagnostic.cancelledAt ?? null,
    requestLatencyMs: adaptive.requestLatencyMs,
    wallClockMs: adaptive.wallClockMs,
    configSha256: adaptive.configSha256,
    finalBody: entry.expected.finalBody,
    nativeIdentical: adaptive.additionalContext === native.additionalContext,
    additionalContext: adaptive.additionalContext,
  });
}

// ── 5. Mode gates + evidence ────────────────────────────────────────────────
if (MODE === 'preflight') {
  check('preflight served exactly the expected fake requests', counts() === expectedSends,
    `${counts()} != ${expectedSends}`);
  fs.writeFileSync(path.join(REPORT_DIR, 'preflight-result.json'),
    `${JSON.stringify({mode: MODE, ranAt: new Date().toISOString(), ...binding, fakeRequests: counts(), cases: results}, null, 2)}\n`,
    'utf8');
} else {
  check('batch stayed inside the approval cap', sentSoFar <= cap, `${sentSoFar} > ${cap}`);
  check('the approval was claimed', claim !== null && fs.existsSync(CLAIM_FILE));
  fs.writeFileSync(RESULTS_FILE,
    `${JSON.stringify({
      mode: MODE,
      ranAt: new Date().toISOString(),
      ...binding,
      approvalFile: claim?.approvalFile ?? null,
      approvalSha256,
      claimFile: path.basename(CLAIM_FILE),
      claim,
      approval,
      sends: sentSoFar,
      passed: problems.length === 0,
      problems,
      cases: results,
    }, null, 2)}\n`,
    'utf8');
}

// ── 6. Report ───────────────────────────────────────────────────────────────
console.log(`\nPRI-1182 ${MODE.toUpperCase()}  head=${head.slice(0, 12)} tree=${tree.slice(0, 12)}`);
console.log(`manifest=${manifestSha256}`);
console.log(`config=${binding.isolatedConfigSha256}  endpoint=${route.endpoint}  model=${route.model}`);
console.log(`responseModels=${route.responseModels.join('|')}  envelope=${cases.envelope.totalMs}ms  `
  + `cap=${cases.requestBudget.total}  expires=${cases.expiresAt}\n`);
console.log('case                          sends  decision                          latency  wall    body');
for (const entry of results) {
  console.log(`${entry.id.padEnd(29)} ${String(entry.sends).padEnd(6)} ${(entry.decision ?? '-').padEnd(33)} `
    + `${String(entry.requestLatencyMs ?? '-').padEnd(8)} ${String(entry.wallClockMs).padEnd(7)} ${entry.finalBody}`);
}
if (MODE === 'preflight') console.log(`\nfake requests=${counts()}  real requests=0`);
if (problems.length > 0) {
  console.error(`\nFAIL (${problems.length})`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log(`\nPASS (${results.length} cases)`);
if (MODE === 'preflight') {
  console.log('next: approve, then node scripts/dev/adaptive-activation/run-cases.mjs --approved <approval.json>');
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
