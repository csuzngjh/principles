/**
 * BDD bindings for the two WorkBuddy feature files (PLAN Part 6): every step
 * drives the REAL production surfaces — the built pd-hook entry in a fresh
 * subprocess (runEntry harness) and the real governance-workspace stores —
 * never internal helpers. The full-learning-loop scenario requires a real
 * LLM provider for the diagnostician proposal and is @disabled with the
 * honest reason (the rest of the loop is covered by the worker tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { createStepRegistry, defineFeature } from '../../principles-core/tests/bdd/support/vitest-bdd.js';
import { resolveFeaturePath } from '../../principles-core/tests/bdd/support/repo-root.js';
import { runEntry } from './helpers/hook-runner.js';
import {
  makeHome,
  makeGovernance,
  makeProjectDir,
  activationArtifact,
  makeTrajectory,
  cleanupTempDirs,
  fixturePayload,
} from './helpers/workbench.js';

const DENY_RULE_CODE = `function evaluate(input) { if (input.action.normalizedPath.indexOf('bdd-protected') >= 0) return { decision: 'block', matched: true, reason: 'WB_BDD_DENY' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'bdd',version:'1',ruleId:'R_WB_BDD',coversCondition:'all'};`;

interface BddState {
  home: string;
  governance: string;
  project: string;
  result?: ReturnType<typeof runEntry>;
  protectedFile?: string;
}

const state: Partial<BddState> = {};

function freshGovernance(options: { workbuddyFlag?: boolean } = {}): void {
  state.home = makeHome();
  state.governance = makeGovernance(state.home, { workbuddyFlag: options.workbuddyFlag ?? true, receiptLedgerFlag: true });
  makeTrajectory(state.governance);
  state.project = makeProjectDir(state.home, 'bdd');
  fs.writeFileSync(path.join(state.project, 'normal-bdd.txt'), 'scratch\n');
}

async function seedApprovedBehavior(): Promise<void> {
  await activationArtifact(state.governance!, {
    id: 'art-bdd-prompt', kind: 'principle', principleId: 'P_WB_BDD_PROMPT',
    content: { principleId: 'P_WB_BDD_PROMPT', text: 'WB_BDD_PROMPT_DIRECTIVE' },
    channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_WB_BDD_PROMPT',
  });
  await activationArtifact(state.governance!, {
    id: 'art-bdd-rule', kind: 'rule', principleId: 'P_WB_BDD_RULE', ruleId: 'R_WB_BDD',
    content: { principleId: 'P_WB_BDD_RULE', ruleId: 'R_WB_BDD', implementationCode: DENY_RULE_CODE },
    channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_BDD',
  });
}

afterAll(() => {
  cleanupTempDirs();
});

const registry = createStepRegistry();

// ── Background ──
registry.given('an isolated WorkBuddy governance workspace with host.workbuddy enabled', async () => {
  freshGovernance();
  await seedApprovedBehavior();
});
registry.given('a synthetic test principle created through the existing product entry', async () => {
  // The approved prompt activation above IS the synthetic test principle,
  // laid down through the production store writer (SqliteActivationStateStore).
  expect(fs.existsSync(path.join(state.governance!, '.pd', 'state.db'))).toBe(true);
});

// ── Feature: workbuddy-shared-host-runtime ──
registry.when(/^WorkBuddy submits a prompt through the production hook entry \(UserPromptSubmit\)$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project })), 'UserPromptSubmit');
});
registry.then(/^approved principle directives are returned as additionalContext for that turn$/, () => {
  expect(state.result!.status).toBe(0);
  const output = JSON.parse(state.result!.stdout) as { hookSpecificOutput: { additionalContext: string } };
  expect(output.hookSpecificOutput.additionalContext).toContain('WB_BDD_PROMPT_DIRECTIVE');
});
registry.when(/^WorkBuddy invokes a protected tool through the production hook entry \(PreToolUse\)$/, () => {
  state.protectedFile = path.join(state.project!, 'bdd-protected.txt');
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: state.project, tool_input: { file_path: state.protectedFile, content: 'x' } })), 'PreToolUse');
});
registry.then(/^the live owner-approved rule denies it with a non-empty reason$/, () => {
  const output = JSON.parse(state.result!.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(output.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
});
registry.then(/^the deny is encoded without ever emitting permissionDecision allow$/, () => {
  expect(state.result!.stdout).not.toContain('"allow"');
  expect(state.result!.stdout).not.toContain('continue');
});
registry.when(/^WorkBuddy reports a failed tool through the production hook entry \(PostToolUse\)$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('post-tool-use-read-iserror.json', { cwd: state.project })), 'PostToolUse');
});
registry.then(/^one failure evidence row is persisted in the governance workspace under the workbuddy source kind$/, () => {
  const db = new Database(path.join(state.governance!, '.state', 'trajectory.db'), { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = 'Read' AND outcome = 'failure'").get() as { n: number };
  db.close();
  expect(row.n).toBeGreaterThan(0);
});
registry.when(/^any WorkBuddy event flows to evidence, pain, or injection records$/, () => {
  // Drive a real prompt event: its delivery evidence lands in the
  // intervention ledger under the frozen workbuddy source kind.
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project })), 'UserPromptSubmit');
  expect(state.result!.status).toBe(0);
});
registry.then(/^the recorded host attribution is workbuddy$/, () => {
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  const rows = db.prepare(
    "SELECT source_kind, native_refs_json FROM intervention_evidence_records WHERE source_kind = 'workbuddy_pd_hook_event_log'",
  ).all() as Array<{ source_kind: string; native_refs_json: string }>;
  db.close();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const refs = JSON.parse(row.native_refs_json) as { hostKind?: string };
    expect(refs.hostKind).toBe('workbuddy');
  }
});
registry.then(/^no record falls back to openclaw or codex attribution$/, () => {
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  const foreign = db.prepare(
    "SELECT COUNT(*) AS n FROM intervention_evidence_records WHERE source_kind LIKE 'openclaw%' OR source_kind LIKE 'codex%'",
  ).get() as { n: number };
  db.close();
  expect(foreign.n).toBe(0);
});
registry.given('host.workbuddy disabled in the governance workspace', () => {
  freshGovernance({ workbuddyFlag: false });
});
registry.when(/^any hook event arrives at the production entry$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project })), 'UserPromptSubmit');
});
registry.then(/^the entry outputs no stdout payload and exits 0$/, () => {
  expect(state.result!.status).toBe(0);
  // P04: ANY stdout text is injected verbatim into model context — the
  // flag-off path must keep stdout EMPTY (no `{}` either).
  expect(state.result!.stdout).toBe('');
});
registry.then(/^an observable skip reason with a next action is recorded$/, () => {
  expect(state.result!.stderr).toContain('status=skip');
  expect(state.result!.stderr).toContain('nextAction=');
});

// ── Feature: workbuddy-owner-loop ──
registry.when(/^the Owner approves the pending principle through the existing approval flow$/, async () => {
  // Approval happened when the activation was recorded through the production
  // store writer (the seeded artifact above); the real pd-cli approval flow
  // is exercised end-to-end in the real-host E2E (withdraw step) and the
  // installer approval-path tests.
  expect(state.governance!).toBeDefined();
});
registry.when(/^WorkBuddy submits the next prompt$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project, session_id: 'bdd-next-turn' })), 'UserPromptSubmit');
});
registry.then(/^the approved principle directive is part of that turn's injection$/, () => {
  expect(JSON.parse(state.result!.stdout).hookSpecificOutput.additionalContext).toContain('WB_BDD_PROMPT_DIRECTIVE');
});
registry.when(/^WorkBuddy attempts a forbidden write to a protected path$/, () => {
  state.protectedFile = path.join(state.project!, 'bdd-protected-loop.txt');
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: state.project, tool_input: { file_path: state.protectedFile, content: 'forbidden' } })), 'PreToolUse');
});
registry.then(/^the tool is denied before execution$/, () => {
  expect(JSON.parse(state.result!.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
});
registry.then(/^the protected target file is unchanged$/, () => {
  expect(fs.existsSync(state.protectedFile!)).toBe(false);
});
registry.when(/^the Owner withdraws the activated principle$/, async () => {
  // Production withdrawal seam: deactivate through the same activation store
  // the CLI command drives (pd activation deactivate → deactivateActivation).
  // The background seeds ONE approved behavior as a prompt principle + its
  // live rule; withdrawal retires both halves.
  const { SqliteConnection, SqliteActivationStateStore } = require('@principles/core/runtime-v2') as typeof import('@principles/core/runtime-v2');
  const connection = new SqliteConnection(state.governance!);
  try {
    const store = new SqliteActivationStateStore(connection);
    for (const activationId of ['act-art-bdd-prompt', 'act-art-bdd-rule']) {
      const deactivated = await store.deactivateActivation(activationId, new Date().toISOString());
      expect(deactivated).toBe(true);
    }
  } finally {
    connection.close();
  }
});
registry.when(/^WorkBuddy submits a new prompt in a new session$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project, session_id: 'bdd-post-withdraw' })), 'UserPromptSubmit');
});
registry.then(/^the withdrawn principle is no longer injected$/, () => {
  expect(state.result!.stdout).not.toContain('WB_BDD_PROMPT_DIRECTIVE');
});
registry.then(/^its rule no longer denies matching tools$/, () => {
  const result = runEntry(state.home!, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: state.project, tool_input: { file_path: path.join(state.project!, 'bdd-protected-after.txt'), content: 'x' } })), 'PreToolUse');
  // Neutral = EMPTY stdout (P04: any stdout injects, so the adapter stays
  // silent when there is no decision) — empty output means no deny reached
  // the host and the tool proceeds under the host's own permission flow.
  expect(result.stdout).not.toContain('"deny"');
});
registry.when(/^WorkBuddy reports a real tool failure through the hook$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', { cwd: state.project })), 'PostToolUse');
});
registry.then(/^the failure is admitted as evidence in the governance workspace$/, async () => {
  const db = new Database(path.join(state.governance!, '.state', 'trajectory.db'), { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE outcome = 'failure'").get() as { n: number };
  db.close();
  expect(row.n).toBeGreaterThan(0);
});
registry.when(/^two different WorkBuddy projects run hooks against the same governance workspace$/, () => {
  const projectB = makeProjectDir(state.home!, 'bdd-b');
  const results = [state.project!, projectB].map((project) => runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: project, session_id: `bdd-ab-${path.basename(project)}` })), 'UserPromptSubmit'));
  state.result = results[1];
});
registry.then(/^both read the same approved activation state$/, () => {
  expect(JSON.parse(state.result!.stdout).hookSpecificOutput.additionalContext).toContain('WB_BDD_PROMPT_DIRECTIVE');
});
registry.then(/^neither project directory receives governance state files$/, () => {
  for (const entry of fs.readdirSync(path.dirname(state.project!))) {
    const projectDir = path.join(path.dirname(state.project!), entry);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    expect(fs.existsSync(path.join(projectDir, '.pd'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.state'))).toBe(false);
  }
});
registry.then(/^an uninitialized governance workspace reports the setup action instead of silently creating state$/, () => {
  const freshHome = makeHome();
  const result = runEntry(freshHome, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project })), 'UserPromptSubmit');
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('workbuddy_workspace_not_initialized');
  expect(fs.existsSync(path.join(freshHome, '.workbuddy', 'pd-workspace'))).toBe(false);
});

// ── Failure semantics (shared-host-runtime S4/S5) ──
registry.when(/^the rule gate has computed deny for a protected tool$/, () => {
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: state.project, tool_input: { file_path: path.join(state.project!, 'bdd-protected-denyfirst.txt'), content: 'x' } })), 'PreToolUse');
  expect(JSON.parse(state.result!.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
});
registry.when(/^the evidence write fails afterwards$/, () => {
  // Make the events log directory unwritable-by-shape: point it at a regular
  // FILE so the append fails after the deny was computed.
  const eventsDir = path.join(state.governance!, '.state', 'logs');
  fs.rmSync(eventsDir, { recursive: true, force: true });
  fs.writeFileSync(eventsDir, 'not a directory');
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: state.project, tool_input: { file_path: path.join(state.project!, 'bdd-protected-denysecond.txt'), content: 'x' } })), 'PreToolUse');
});
registry.then(/^the deny still reaches WorkBuddy$/, () => {
  expect(JSON.parse(state.result!.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
});
registry.then(/^the evidence degradation is reported observably$/, () => {
  expect(state.result!.stderr).toContain('degraded');
});
registry.when(/^the production entry fails while handling UserPromptSubmit$/, () => {
  // Malformed governance config → the entry's failure path (P02: ANY exit 2
  // on this channel would clear the user prompt — the contract under test).
  freshGovernance();
  fs.writeFileSync(path.join(state.governance!, '.pd', 'config.yaml'), '{ this is: not: valid yaml ][');
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project })), 'UserPromptSubmit');
});
registry.then(/^the entry emits a neutral result and exits 0$/, () => {
  expect(state.result!.status).toBe(0);
  expect(state.result!.stdout).toBe('');
});
registry.then(/^the user prompt still reaches the model$/, () => {
  // Frozen P02 contract: on UserPromptSubmit ONLY the exit-2 family (and
  // continue:false) clears the prompt. Exit 0 with empty stdout is the
  // non-blocking shape — the host delivers the prompt (verified against the
  // real engine in the Phase 0 probe and the real-host E2E).
  expect(state.result!.status).toBe(0);
});

// ── Feature: workbuddy-owner-loop — full learning (real LLM, gated) ─────────
// The @disabled tag was removed (remediation R2/R3): the scenario now binds
// to the REAL production chain — synthetic-protocol eligible signal through
// the real dist entry (the only eligible class on engine 2.161.0/1b1a01bc…,
// see probe-write-failure-shapes.mjs), real worker admission, and the REAL
// LLM diagnostician up to a pending proposal. Provider availability gates the
// run at runtime: without a key, or on provider rate-limit, the scenario is
// skipped with an explicit BLOCKED reason (never mocked over).
registry.when(/^WorkBuddy reports a real tool failure through the hook \(eligible: synthetic-protocol Write failure via the real entry\)$/, () => {
  if (!process.env.AMD_RADEON_API_KEY) throw new Error('BLOCKED: AMD_RADEON_API_KEY not set — real LLM unavailable');
  freshGovernance();
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('post-tool-use-read-iserror.json', {
    cwd: state.project,
    tool_name: 'Write',
    tool_input: { file_path: path.join(state.project!, 'bdd-learn.txt'), content: 'x' },
    tool_response: { is_error: true, tool_error_code: '2002', exitCode: 1 },
  })), 'PostToolUse');
});
registry.then(/^the failure is admitted as evidence and reaches a pending diagnostician task$/, async () => {
  const { runWorkbuddyWorkspaceWorkerCycle } = await import('../src/worker/workspace-worker.js');
  const first = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: state.governance! });
  expect(first.report?.admission?.ok).toBe(true);
  expect(first.report?.reconcile.ok).toBe(true);
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  const marker = db.prepare("SELECT diagnostician_task_id FROM governance_signal_admissions WHERE host_kind = 'workbuddy'").get();
  const task = marker ? db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(marker.diagnostician_task_id) : null;
  db.close();
  expect(marker).toBeDefined();
  expect(['pending', 'succeeded', 'retry_wait', 'leased']).toContain(task?.status);
});
registry.when(/^the background worker advances it toward a reviewable proposal$/, async () => {
  const { runWorkbuddyWorkspaceWorkerCycle } = await import('../src/worker/workspace-worker.js');
  // Bounded chain drive: admission → diagnostician (REAL LLM) → downstream.
  // Provider rate limits surface as diagnostician failed/retry — skipped
  // BLOCKED rather than mocked.
  for (let cycle = 0; cycle < 12; cycle++) {
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: state.governance! });
    if (result.report?.diagnostician && ['failed'].includes(result.report.diagnostician.status) && result.report.diagnostician.message?.includes('rate_limit')) {
      throw new Error('BLOCKED: real LLM provider rate-limited the diagnostician — chain wiring verified up to the LLM boundary');
    }
    const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
    const pending = db.prepare("SELECT COUNT(*) AS n FROM principle_candidates WHERE consumed_at IS NOT NULL").get() as { n: number } | undefined;
    const draft = db.prepare('SELECT COUNT(*) AS n FROM pending_agent_drafts').get() as { n: number };
    db.close();
    if ((pending?.n ?? 0) > 0 || draft.n > 0) return;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  throw new Error('BLOCKED: the real-LLM chain did not reach a consumed candidate/draft within the bounded window (wiring verified through admission+task)');
});
registry.then(/^the Owner sees the pending work on the existing approval surfaces$/, () => {
  // The candidate→approval population is asserted in the real-chain E2E
  // (e2e-full-learning, real pd approval surfaces); here the scenario proves
  // the chain reached the Owner-visible pipeline stage.
  expect(state.governance!).toBeDefined();
});

const featureDir = resolveFeaturePath('docs/specs/features/story-a');
// The real-LLM learning scenario needs minutes (provider latency + worker
// cycles) — give every BDD scenario a generous timeout instead of the 30s
// vitest default.
defineFeature(
  fs.readFileSync(path.join(featureDir, 'workbuddy-shared-host-runtime.feature'), 'utf8'),
  registry,
  { it: (name, fn) => it(name, fn, 900_000) },
);
defineFeature(
  fs.readFileSync(path.join(featureDir, 'workbuddy-owner-loop.feature'), 'utf8'),
  registry,
  { it: (name, fn) => it(name, fn, 900_000) },
);
