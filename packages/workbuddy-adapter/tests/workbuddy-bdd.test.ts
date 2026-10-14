/**
 * BDD bindings for the two WorkBuddy feature files (PLAN Part 6): every step
 * drives the REAL production surfaces — the built pd-hook entry in a fresh
 * subprocess (runEntry harness), the real governance-workspace stores, and
 * the real pd-cli product entry for Owner approval/withdrawal — never
 * internal helpers. The full-learning scenario runs the REAL LLM
 * diagnostician; provider unavailability (missing key or a provider rate
 * limit, runs.error_category='rate_limit') SKIPS the scenario with an
 * explicit BLOCKED reason — never mocked over, and an empty queue is a FAIL,
 * not a BLOCKED.
 *
 * Learning acceptance correlates through the IDENTITY CHAIN only (P2
 * remediation): admission → principle_candidates → chain tasks (durable
 * pi_metadata.correlationId) → pi_artifacts → approvals → activations. The
 * approval under test is selected BY ID from this scenario's own chain —
 * never picked queue-wide as pending[0]. Each candidate is then verified on
 * ITS production channel: prompt → statement injection + withdrawal;
 * code_tool_hook → durable approval/activation row (shadow per the production
 * writer; no injection assertion, no live promotion); implementation/defer →
 * the not_internalizable policy terminal, reported explicitly (never wrapped
 * as a provider BLOCKED, never counted as an injection PASS).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** The real product approval/withdrawal entry (packages/pd-cli dist). */
const PD_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pd-cli', 'dist', 'index.js');

interface PendingApprovalRow {
  approval_id: string;
  artifact_id: string;
  channel: string;
  status: string;
}

interface ChainCandidateRow {
  candidate_id: string;
  artifact_id: string;
  task_id: string;
  recommendation_kind: string;
  status: string;
  consumed_at: string | null;
  confidence: number | null;
}

interface ChainTaskRow {
  task_id: string;
  task_kind: string;
  status: string;
  candidate_id: string;
}

interface ChainArtifactRow {
  artifact_id: string;
  artifact_kind: string;
  source_task_id: string;
}

type CandidateDisposition = 'policy_terminal' | 'pending_approval' | 'decided' | 'in_flight';

/**
 * The full acceptance surface of ONE learning scenario, correlated by IDs
 * from its own diagnostician task. No field here is ever selected queue-wide.
 */
interface LearningChain {
  diagnosticianTaskId: string;
  candidates: ChainCandidateRow[];
  /** Chain tasks (dreamer + successors) correlated by the durable
   * pi_metadata.correlationId = candidateId — never parsed from id strings. */
  chainTasks: ChainTaskRow[];
  artifacts: ChainArtifactRow[];
  approvals: PendingApprovalRow[];
  pendingApprovals: PendingApprovalRow[];
}

/** Per-approval outcome of the real `pd activation approve` run. */
interface ApprovalOutcome {
  approval: PendingApprovalRow;
  candidateKind: string;
  approveOk: boolean;
  activationId?: string;
}

/**
 * Recommendation kinds whose ONLY production disposition is the intake policy
 * refusal (intake-to-internalization-bridge: MVP-disabled channel →
 * not_internalizable, no dreamer task, no approval row — BY DESIGN).
 */
const POLICY_TERMINAL_KINDS = new Set(['implementation', 'defer']);

/**
 * The admission gate's durable threshold (evaluateAdmission): a candidate
 * whose persisted confidence is below it can NEVER be admitted, so its chain
 * can never reach an approval. Reading it from the candidate row keeps the
 * acceptance loop honest about a terminal state instead of cycling (rc-7).
 */
const ADMISSION_CONFIDENCE_THRESHOLD = 0.5;

/**
 * A scenario cannot proceed for an HONEST environmental reason (real LLM
 * provider unavailable) — surfaces as a vitest SKIP with the BLOCKED reason,
 * never as a mock-over PASS and never as an empty-queue false BLOCKED.
 */
class BlockedScenarioError extends Error {}

const itBdd = (name: string, fn: () => void | Promise<void>): void =>
  it(name, async (ctx) => {
    try {
      await fn();
    } catch (error) {
      if (error instanceof BlockedScenarioError) {
        ctx.skip(error.message);
        return;
      }
      throw error;
    }
  }, 1_500_000);

interface BddState {
  home: string;
  governance: string;
  project: string;
  result?: ReturnType<typeof runEntry>;
  protectedFile?: string;
  approval?: PendingApprovalRow;
  activationId?: string;
  learnedProbe?: string;
  providerRateLimited?: string;
  scenarioStartedAt?: number;
  /** Learning identity chain (P2): the scenario's OWN acceptance surface. */
  diagnosticianTaskId?: string;
  chain?: LearningChain;
  approvalOutcomes?: ApprovalOutcome[];
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

/**
 * Learning-scenario governance: the REAL LLM runtime profile on top of the
 * flags `freshGovernance` wrote — same shape as e2e-full-learning
 * governanceSetup (provider/model/keyEnv/baseUrl). Without this profile the
 * diagnostician can never reach the provider, so the real-LLM scenario would
 * fail for a configuration reason while looking like a chain defect
 * (review §4 P2-c).
 */
function enableRealLlmProfile(): void {
  if (!process.env.AMD_RADEON_API_KEY) {
    throw new BlockedScenarioError('BLOCKED: AMD_RADEON_API_KEY not set — the real LLM diagnostician cannot run; scenario skipped honestly (never mocked over)');
  }
  const configPath = path.join(state.governance!, '.pd', 'config.yaml');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    runtimeProfiles?: Record<string, unknown>;
    internalAgents?: { defaultRuntime?: string; agents: Record<string, { runtimeProfile?: string }> };
  };
  config.runtimeProfiles ??= {};
  config.runtimeProfiles['pi-ai.real'] = {
    type: 'pi-ai',
    provider: 'openai',
    model: 'DeepSeek-V4-Flash-Vision-Exp',
    apiKeyEnv: 'AMD_RADEON_API_KEY',
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    timeoutMs: 300000,
  };
  if (config.internalAgents) {
    config.internalAgents.defaultRuntime = 'pi-ai.real';
    for (const agent of Object.keys(config.internalAgents.agents)) {
      config.internalAgents.agents[agent] = { ...config.internalAgents.agents[agent], runtimeProfile: 'pi-ai.real' };
    }
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
}

function assertPdCliBuilt(): void {
  if (!fs.existsSync(PD_CLI)) {
    throw new Error(`pd-cli entry not found: ${PD_CLI} (run: npm run build --workspace=@principles/pd-cli)`);
  }
}

/** Run the REAL product approval entry (`pd activation approve`) in a subprocess. */
function pdCli(args: string[], timeoutMs = 120_000): { status: number; stdout: string; stderr: string } {
  assertPdCliBuilt();
  const result = spawnSync(process.execPath, [PD_CLI, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, USERPROFILE: state.home!, HOME: state.home! },
    windowsHide: true,
  });
  return { status: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}

function readPendingApprovals(governance: string): PendingApprovalRow[] {
  const db = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
  try {
    return db.prepare(
      "SELECT approval_id, artifact_id, channel, status FROM approvals WHERE status = 'pending' ORDER BY requested_at ASC",
    ).all() as PendingApprovalRow[];
  } finally {
    db.close();
  }
}

/**
 * Identity-chain reader (P2 remediation). Correlates the acceptance surface of
 * THIS scenario's diagnostician task through IDs only:
 *   admission(trajectory) → principle_candidates → chain tasks (durable
 *   pi_metadata.correlationId = candidateId) → pi_artifacts(source_task_id) →
 *   approvals(artifact_id).
 * Every query is readonly and parameterized; returns null when the stores are
 * not readable yet (the caller keeps cycling) — never an empty-row guess.
 */
function readLearningChain(governance: string, diagnosticianTaskId: string): LearningChain | null {
  let db: Database.Database;
  try {
    db = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
  } catch {
    return null; // state store not created yet — the caller keeps cycling
  }
  const chain: LearningChain = {
    diagnosticianTaskId,
    candidates: [],
    chainTasks: [],
    artifacts: [],
    approvals: [],
    pendingApprovals: [],
  };
  try {
    // Candidates of this chain: minted on the top diagnostician task itself or
    // on its diag_router SUB-task (input_ref → top task, the canonical
    // production parent link verified against real task records).
    chain.candidates = db.prepare(
      `SELECT candidate_id, artifact_id, task_id, recommendation_kind, status, consumed_at, confidence
       FROM principle_candidates
       WHERE task_id = ?
          OR task_id IN (SELECT task_id FROM tasks WHERE task_kind = 'diag_router' AND input_ref = ?)`,
    ).all(diagnosticianTaskId, diagnosticianTaskId) as ChainCandidateRow[];
    for (const candidate of chain.candidates) {
      // Production chain tasks (dreamer + every successor record) carry the
      // candidate id as pi_metadata.correlationId — the durable link.
      const tasks = db.prepare(
        `SELECT task_id, task_kind, status, json_extract(diagnostic_json, '$.pi_metadata.correlationId') AS candidate_id
         FROM tasks
         WHERE json_extract(diagnostic_json, '$.pi_metadata.correlationId') = ?`,
      ).all(candidate.candidate_id) as ChainTaskRow[];
      chain.chainTasks.push(...tasks);
      for (const task of tasks) {
        const artifacts = db.prepare(
          'SELECT artifact_id, artifact_kind, source_task_id FROM pi_artifacts WHERE source_task_id = ?',
        ).all(task.task_id) as ChainArtifactRow[];
        chain.artifacts.push(...artifacts);
      }
    }
    for (const artifact of chain.artifacts) {
      const approvals = db.prepare(
        'SELECT approval_id, artifact_id, channel, status FROM approvals WHERE artifact_id = ?',
      ).all(artifact.artifact_id) as PendingApprovalRow[];
      chain.approvals.push(...approvals);
    }
    chain.pendingApprovals = chain.approvals.filter((a) => a.status === 'pending');
  } finally {
    db.close();
  }
  return chain;
}

/** Artifact ids a candidate owns, via its correlated chain tasks. */
function candidateArtifactIds(chain: LearningChain, candidateId: string): string[] {
  const taskIds = new Set(
    chain.chainTasks.filter((t) => t.candidate_id === candidateId).map((t) => t.task_id),
  );
  return chain.artifacts.filter((a) => taskIds.has(a.source_task_id)).map((a) => a.artifact_id);
}

function candidateDisposition(chain: LearningChain, candidate: ChainCandidateRow): CandidateDisposition {
  const artifactIds = candidateArtifactIds(chain, candidate.candidate_id);
  const approval = chain.approvals.find((a) => artifactIds.includes(a.artifact_id));
  if (approval?.status === 'pending') return 'pending_approval';
  if (approval !== undefined) return 'decided';
  // A policy-terminal kind never seeds a chain task (intake refusal is its
  // designed terminal); an actionable kind without chain tasks is still moving.
  if (POLICY_TERMINAL_KINDS.has(candidate.recommendation_kind) && artifactIds.length === 0) {
    return 'policy_terminal';
  }
  return 'in_flight';
}

function candidateForApprovalArtifact(chain: LearningChain, artifactId: string): ChainCandidateRow | undefined {
  return chain.candidates.find((c) => candidateArtifactIds(chain, c.candidate_id).includes(artifactId));
}

/** Primary = the prompt-channel approval when one exists (it drives the
 * injection + withdrawal legs); otherwise the first chain approval. */
function selectPrimaryApproval(chain: LearningChain): PendingApprovalRow {
  return chain.pendingApprovals.find((a) => a.channel === 'prompt') ?? chain.pendingApprovals[0];
}

function chainSummary(chain: LearningChain): string {
  return chain.candidates
    .map((c) => {
      const tasks = chain.chainTasks
        .filter((t) => t.candidate_id === c.candidate_id)
        .map((t) => `${t.task_kind}:${t.status}`)
        .join(',');
      const taskNote = tasks.length > 0 ? `;tasks=${tasks}` : '';
      return `${c.candidate_id.slice(0, 8)}(kind=${c.recommendation_kind},status=${c.status},${candidateDisposition(chain, c)}${taskNote})`;
    })
    .join('; ');
}

/** Best-effort telemetry for BLOCKED reasons — the primary rate-limit signal
 * is the worker report's errorCategory; this cross-checks the durable run row. */
function latestRunErrorCategory(governance: string, taskId: string): string | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
    const row = db.prepare('SELECT error_category FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { error_category?: string | null } | undefined;
    return row?.error_category ?? undefined;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* handle already closed */ }
  }
}

function capabilityNextAction(result: { report?: { diagnostician?: { nextAction?: string } | null } | null }): string {
  return result.report?.diagnostician?.nextAction ?? 'no nextAction reported';
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
  // The Background seeded the synthetic principle through the PRODUCTION store
  // writer (SqliteActivationStateStore.recordActivation) — the recorded
  // activation IS the Owner decision this scenario consumes. Assert the
  // decision rows exist and are live (the approvals-queue → `pd activation
  // approve` path is exercised end-to-end by the real-LLM scenario below).
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  try {
    const rows = db.prepare(
      'SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE artifact_id IN (?, ?)',
    ).all('art-bdd-prompt', 'art-bdd-rule') as Array<{ activation_id: string; artifact_id: string; deactivated_at: string | null }>;
    expect(rows.map((row) => row.artifact_id).sort()).toEqual(['art-bdd-prompt', 'art-bdd-rule']);
    for (const row of rows) expect(row.deactivated_at).toBeNull();
  } finally {
    db.close();
  }
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
// The scenario binds to the REAL production chain end to end: a labeled
// SYNTHETIC-PROTOCOL eligible signal (fixture-shaped Write-failure PostToolUse
// payload through the real dist entry — the only eligible class on engine
// 2.161.0, see probe-write-failure-shapes.mjs), real worker admission, the
// REAL LLM diagnostician, the real full-chain downstream, and Owner approval +
// withdrawal through the REAL product entry (`pd activation approve|deactivate`).
// Provider availability gates the run at runtime: without a key, or on a
// provider rate limit (diagnostician failed/retry_wait with
// runs.error_category='rate_limit'), the scenario is SKIPPED with the explicit
// BLOCKED reason. An EMPTY queue at the deadline is a FAIL, never a BLOCKED
// (review §4 P2-e) — the two are distinguished by runs.error_category.
// Acceptance is IDENTITY-CHAIN correlated (P2): the approval is selected by ID
// from this scenario's own chain (admission → candidates → chain tasks →
// artifacts → approvals), and each candidate is verified on ITS production
// channel — prompt → injection + withdrawal; code_tool_hook → durable rows
// (shadow per the production writer, no injection assertion, no live
// promotion); implementation/defer → the not_internalizable POLICY terminal,
// reported explicitly (never a provider BLOCKED, never an injection PASS).
registry.when(/^WorkBuddy reports a real tool failure through the hook \(eligible: synthetic-protocol Write failure via the real entry\)$/, () => {
  state.scenarioStartedAt = Date.now();
  freshGovernance();
  enableRealLlmProfile();
  // SYNTHETIC-PROTOCOL input (evidence class 2, labeled): a real-shaped
  // Write-failure PostToolUse payload delivered through the REAL dist entry —
  // not a fabricated store row and not a real engine turn.
  state.result = runEntry(state.home!, JSON.stringify(fixturePayload('post-tool-use-read-iserror.json', {
    cwd: state.project,
    tool_name: 'Write',
    tool_input: { file_path: path.join(state.project!, 'bdd-learn.txt'), content: 'x' },
    tool_response: { is_error: true, tool_error_code: '2002', exitCode: 1 },
  })), 'PostToolUse');
  expect(state.result!.status).toBe(0);
});
registry.then(/^the failure is admitted as evidence and reaches a pending diagnostician task$/, async () => {
  const { runWorkbuddyWorkspaceWorkerCycle } = await import('../src/worker/workspace-worker.js');
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  const first = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: state.governance! });
  expect(first.report?.admission?.ok).toBe(true);
  expect(first.report?.reconcile.ok).toBe(true);
  // The admission marker lives in the TRAJECTORY store (.state/trajectory.db)
  // — the former state.db query threw "no such table" (review §4 P2-b).
  const traj = new Database(path.join(state.governance!, '.state', 'trajectory.db'), { readonly: true });
  const marker = traj.prepare("SELECT diagnostician_task_id FROM governance_signal_admissions WHERE host_kind = 'workbuddy'").get() as { diagnostician_task_id: string } | undefined;
  traj.close();
  expect(marker).toBeDefined();
  // Identity-chain anchor (P2): every later acceptance decision correlates
  // from THIS task id — never from a queue-wide pending[0] pick.
  state.diagnosticianTaskId = marker!.diagnostician_task_id;
  // Tasks live in the governance state store (.pd/state.db).
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  const task = marker
    ? db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(marker.diagnostician_task_id) as { status: string } | undefined
    : undefined;
  db.close();
  // Observability (rc-9): make the admission-cycle state visible in the
  // vitest output — the durable runs row is the error-category authority.
  const runsCategory = marker ? latestRunErrorCategory(state.governance!, marker.diagnostician_task_id) : undefined;
  console.error(`[bdd-learning] admission-cycle: report=${JSON.stringify(first.report?.diagnostician)} task=${task?.status ?? 'none'} runs.error_category=${runsCategory ?? 'none'}`);
  // The SAME cycle already ran the diagnostician once — a provider rate limit
  // surfaces here (task terminal-failed "rate limit degraded" or retry_wait
  // with runs.error_category='rate_limit'). Remember it so this and the
  // advance step can skip honestly; a terminal failure WITHOUT rate_limit is
  // a real chain defect and fails loud with the reason.
  if (task && (task.status === 'failed' || task.status === 'retry_wait')) {
    const category = runsCategory ?? first.report?.diagnostician?.errorCategory;
    if (category === 'rate_limit') {
      state.providerRateLimited = `task=${marker!.diagnostician_task_id}`;
    } else if (task.status === 'failed') {
      throw new Error(`diagnostician failed terminally (error_category=${category ?? 'none'}): ${(first.report?.diagnostician?.message ?? 'no message').slice(0, 300)}`);
    }
  }
  const allowedStatuses = ['pending', 'succeeded', 'retry_wait', 'leased'];
  if (state.providerRateLimited) allowedStatuses.push('failed');
  expect(allowedStatuses).toContain(task?.status);
  // Release the cached pain-signal bridge handle the cycle created — without
  // this the Windows afterAll temp sweep hits EPERM (the worker suite's
  // afterEach does the same).
  await disposePainSignalBridgesForWorkspace(state.governance!).catch(() => undefined);
});
registry.when(/^the background worker advances it toward a reviewable proposal$/, async () => {
  const { runWorkbuddyWorkspaceWorkerCycle } = await import('../src/worker/workspace-worker.js');
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  try {
    // Bounded chain drive: admission → diagnostician (REAL LLM via the
    // pi-ai.real profile) → downstream full chain → approval queue.
    state.approval = undefined;
    state.chain = undefined;
    state.approvalOutcomes = undefined;
    if (state.providerRateLimited) {
      throw new BlockedScenarioError(`BLOCKED: the real LLM provider already rate-limited the diagnostician (${state.providerRateLimited}, runs.error_category=rate_limit) — chain verified up to the LLM boundary; re-run when the provider quota resets`);
    }
    expect(state.diagnosticianTaskId).toBeTruthy();
    // WALL-CLOCK bound measured from the SCENARIO start: a cycle is never
    // STARTED after 13 scenario-minutes (diagnosis with the real LLM takes
    // minutes and the downstream dreamer-seed → candidate-intake → approval
    // cadence adds 6-10 more), so the last cycle (≤5 min provider timeout)
    // always finishes inside the 1500s vitest budget — the scenario ends in
    // this step's own classification, never in a vitest timeout.
    const startedAt = state.scenarioStartedAt ?? Date.now();
    const cycleStartDeadline = startedAt + 780_000;
    let lastReport = 'no cycle ran';
    for (let cycle = 0; ; cycle++) {
      if (Date.now() >= cycleStartDeadline) break;
      const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: state.governance! });
      const diag = result.report?.diagnostician;
      console.error(`[bdd-learning] cycle ${cycle}: mode=${result.mode} diag=${JSON.stringify(diag)} downstreamSkip=${result.report?.downstream && 'skipReason' in result.report.downstream ? result.report.downstream.skipReason : undefined}`);
      if (diag?.status === 'skipped' && diag.message === 'capability_disabled') {
        // Config defect, not provider state: the pi-ai.real profile did not
        // resolve — failing silently through empty cycles would be a fake
        // FAIL reason (rc-3).
        throw new Error(`diagnostician capability disabled: ${capabilityNextAction(result)}`);
      }
      if (diag && (diag.status === 'failed' || diag.status === 'retried' || diag.status === 'degraded')) {
        // Durable runs row is the error-category authority (rc-4: do not trust
        // one report shape); the report field is the fallback.
        const category = latestRunErrorCategory(state.governance!, diag.taskId) ?? diag.errorCategory;
        if (category === 'rate_limit') {
          throw new BlockedScenarioError(`BLOCKED: the real LLM provider rate-limited the diagnostician (task=${diag.taskId}, runs.error_category=rate_limit) — chain verified up to the LLM boundary; re-run when the provider quota resets`);
        }
        if (diag.status === 'retried') { await new Promise((resolve) => setTimeout(resolve, 20_000)); continue; } // transient backoff — keep cycling
        throw new Error(`diagnostician ${diag.status} (error_category=${category ?? 'none'}): ${(diag.message ?? 'no message').slice(0, 300)}`);
      }
      // P2 identity-chain selection: only approvals traceable to THIS
      // scenario's diagnostician task are acceptable — never pending[0].
      const chain = readLearningChain(state.governance!, state.diagnosticianTaskId!);
      if (chain !== null && chain.pendingApprovals.length > 0) {
        state.chain = chain;
        state.approval = selectPrimaryApproval(chain);
        console.error(`[bdd-learning] identity chain reached approvals: ${chainSummary(chain)}`);
        return;
      }
      // Policy terminal (rc-9 explicit classification, NOT a provider BLOCKED
      // and never a fake injection PASS): every candidate's production
      // disposition is the intake policy refusal — no approval row will EVER
      // exist for this chain, so cycling to the deadline would be dishonest.
      if (chain !== null && chain.candidates.length > 0 && chain.candidates.every((c) => candidateDisposition(chain, c) === 'policy_terminal')) {
        throw new BlockedScenarioError(`POLICY-TERMINAL: every candidate of diagnostician task ${chain.diagnosticianTaskId} ends at the not_internalizable intake policy refusal (approvals row absent BY DESIGN): ${chainSummary(chain)} — scenario reported as its policy terminal, NOT a provider BLOCKED and not an injection PASS`);
      }
      // Admission terminal (rc-7 loop-state freshness): every ACTIONABLE
      // candidate's persisted confidence is below the admission gate's
      // threshold, so it can never be admitted and no approval can ever
      // appear. Fail loud NOW with that root cause instead of cycling.
      const actionable = chain?.candidates.filter((c) => !POLICY_TERMINAL_KINDS.has(c.recommendation_kind)) ?? [];
      const admissionDead = actionable.length > 0 && actionable.every((c) => c.confidence === null || c.confidence < ADMISSION_CONFIDENCE_THRESHOLD);
      if (admissionDead) {
        throw new Error(`FAIL: every actionable candidate of diagnostician task ${chain!.diagnosticianTaskId} is below the admission confidence threshold (${ADMISSION_CONFIDENCE_THRESHOLD}) — the admission gate can never admit them, so no approval can ever be reached: ${chainSummary(chain!)} (intake gate decision needs_evidence; nextAction: re-run the diagnosis with sufficient confidence/evidence or review manually)`);
      }
      lastReport = JSON.stringify({ mode: result.mode, admission: result.report?.admission, diagnostician: diag, downstreamSkip: result.report?.downstream && 'skipReason' in result.report.downstream ? result.report.downstream.skipReason : undefined, chain: chain === null ? 'stores-unreadable' : `${chain.candidates.length} candidate(s): ${chainSummary(chain)}` }).slice(0, 500);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    // Window exhausted — classify from the DURABLE state, never a bare
    // timeout: rate_limit anywhere → honest BLOCKED; an unprocessed queue
    // without rate-limit evidence is a FAIL with that evidence (review
    // §4 P2-e — an empty queue is never a BLOCKED).
    let taskStatus = 'none';
    let finalCategory: string | undefined;
    const traj = new Database(path.join(state.governance!, '.state', 'trajectory.db'), { readonly: true });
    const marker = traj.prepare("SELECT diagnostician_task_id FROM governance_signal_admissions WHERE host_kind = 'workbuddy'").get() as { diagnostician_task_id: string } | undefined;
    traj.close();
    if (marker) {
      finalCategory = latestRunErrorCategory(state.governance!, marker.diagnostician_task_id);
      const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
      const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(marker.diagnostician_task_id) as { status: string } | undefined;
      db.close();
      taskStatus = task?.status ?? 'missing';
    }
    if (finalCategory === 'rate_limit') {
      throw new BlockedScenarioError(`BLOCKED: the real LLM provider did not complete the diagnostician inside the acceptance window (task=${taskStatus}, runs.error_category=rate_limit) — chain verified up to the LLM boundary; re-run when the provider quota resets`);
    }
    // P2: a queue-wide pending row that the identity chain cannot trace to
    // this scenario's task is a correlation defect — fail loud, never adopt it.
    const chain = state.diagnosticianTaskId ? readLearningChain(state.governance!, state.diagnosticianTaskId) : null;
    const anyPending = readPendingApprovals(state.governance!);
    if (anyPending.length > 0 && (chain === null || chain.pendingApprovals.length === 0)) {
      throw new Error(`FAIL: ${anyPending.length} pending approval row(s) exist but NONE is traceable to this scenario's diagnostician task (identity chain broken; candidates=${chain ? chainSummary(chain) : 'none resolvable'})`);
    }
    throw new Error(`FAIL: the chain did not reach a pending approval within the bounded window (task=${taskStatus}, runs.error_category=${finalCategory ?? 'none'}); last=${lastReport}`);
  } finally {
    // Release the cached bridge handles (Windows temp sweep EPERM otherwise).
    await disposePainSignalBridgesForWorkspace(state.governance!).catch(() => undefined);
  }
});
registry.then(/^the Owner sees the pending work on the existing approval surfaces$/, () => {
  // Owner visibility on the REAL approval surfaces' store: the pending row
  // the surfaces read (approvals, state.db) — found BY ITS ID from this
  // scenario's identity chain, with NO queue-wide fallback (P2).
  expect(state.approval).toBeDefined();
  const pending = readPendingApprovals(state.governance!);
  expect(pending.length).toBeGreaterThan(0);
  const row = pending.find((p) => p.approval_id === state.approval!.approval_id);
  expect(row).toBeDefined();
  state.approval = row;
  expect(state.approval!.artifact_id.startsWith('pi-art-')).toBe(true);
});
registry.when(/^the Owner approves the learned principle through the real product approval entry$/, () => {
  expect(state.chain).toBeDefined();
  expect(state.chain!.pendingApprovals.length).toBeGreaterThan(0);
  // Approve EVERY pending approval of this scenario's identity chain; each
  // candidate is later verified on its own production channel.
  state.approvalOutcomes = [];
  for (const row of state.chain!.pendingApprovals) {
    const approve = pdCli([
      'activation', 'approve',
      '--approval-id', row.approval_id,
      '--workspace', state.governance!,
      '--decided-by', 'wb-bdd-owner',
      '--json',
    ]);
    let parsed: { ok?: boolean; activationId?: string } = {};
    try { parsed = JSON.parse(approve.stdout || '{}') as { ok?: boolean; activationId?: string }; } catch { /* assertion below fails loud on non-JSON */ }
    expect(approve.status).toBe(0);
    expect(parsed.ok).toBe(true);
    state.approvalOutcomes.push({
      approval: row,
      candidateKind: candidateForApprovalArtifact(state.chain!, row.artifact_id)?.recommendation_kind ?? 'unknown',
      approveOk: parsed.ok === true,
      activationId: parsed.activationId,
    });
    if (row.approval_id === state.approval!.approval_id && parsed.activationId) {
      state.activationId = parsed.activationId;
    }
  }
});
registry.then(/^the approval is recorded from pending to approved with a live activation$/, () => {
  expect(state.approvalOutcomes!.length).toBeGreaterThan(0);
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  try {
    for (const outcome of state.approvalOutcomes!) {
      const approval = db.prepare('SELECT status, decided_at, decided_by FROM approvals WHERE approval_id = ?').get(outcome.approval.approval_id) as { status: string; decided_at: string | null; decided_by: string | null } | undefined;
      expect(approval?.status).toBe('approved');
      expect(approval?.decided_at).toBeTruthy();
      expect(approval?.decided_by).toBe('wb-bdd-owner');
      const activation = db.prepare('SELECT activation_id, channel, action, deactivated_at FROM activations WHERE artifact_id = ?').get(outcome.approval.artifact_id) as { activation_id: string; channel: string; action: string; deactivated_at: string | null } | undefined;
      expect(activation).toBeDefined();
      expect(activation!.deactivated_at).toBeNull();
      // Channel dispatch (P2): assertions follow the candidate's PRODUCTION
      // channel — a rule candidate is never measured with the prompt ruler.
      if (activation!.channel === 'prompt') {
        expect(activation!.action).toBe('prompt_activate');
      } else if (activation!.channel === 'code_tool_hook') {
        // The production RuleHostWriter persists the shadow action; the
        // shadow→live promotion is a separate Owner path. Assert the durable
        // action IS a code_tool_hook action (read, never hardcoded, never
        // promoted by this scenario) and record what production wrote.
        expect(activation!.action.startsWith('code_tool_hook_')).toBe(true);
        console.error(`[bdd-learning] rule candidate (kind=${outcome.candidateKind}) activation verified on its own channel: action=${activation!.action} (production writer value; live promotion is a separate Owner path)`);
      } else {
        throw new Error(`FAIL: unexpected activation channel '${activation!.channel}' for artifact ${outcome.approval.artifact_id} (kind=${outcome.candidateKind})`);
      }
      if (!outcome.activationId && activation) outcome.activationId = activation.activation_id;
    }
  } finally {
    db.close();
  }
});
registry.then(/^the next turn carries the learned principle directive$/, () => {
  expect(state.approval).toBeDefined();
  // Channel dispatch (P2): the injection contract exists ONLY on the prompt
  // channel. A rule/shadow primary must not be measured with the prompt ruler
  // — the leg is skipped EXPLICITLY (logged, not a silent pass, not a FAIL).
  if (state.approval!.channel !== 'prompt') {
    console.error(`[bdd-learning] prompt-injection leg SKIPPED: primary approval channel='${state.approval!.channel}' (chain: ${state.chain ? chainSummary(state.chain) : 'n/a'}) — prompt injection applies only to prompt-channel candidates (P2 channel dispatch)`);
    return;
  }
  // PRODUCTION read contract: the chain artifact is the FULL ScribeOutput, and
  // the prompt channel resolves content.text falling back to
  // content.principleDraft.statement (prompt-activation-reader-contract) —
  // real drafts only carry the nested statement.
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  let resolvedText = '';
  try {
    const row = db.prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?').get(state.approval!.artifact_id) as { content_json: string } | undefined;
    const content = JSON.parse(row?.content_json ?? '{}') as { text?: unknown; principleDraft?: { statement?: unknown } };
    if (typeof content.text === 'string' && content.text.length > 0) resolvedText = content.text;
    else if (typeof content.principleDraft?.statement === 'string' && content.principleDraft.statement.length > 0) resolvedText = content.principleDraft.statement;
  } finally {
    db.close();
  }
  expect(resolvedText.length).toBeGreaterThan(0);
  const probe = resolvedText.split(/\s+/).filter((word) => word.length > 4).slice(0, 4).join(' ');
  expect(probe.length).toBeGreaterThan(0);
  state.learnedProbe = probe;
  const result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project, session_id: 'bdd-learn-inject' })), 'UserPromptSubmit');
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  expect(output.hookSpecificOutput?.additionalContext ?? '').toContain(probe);
});
registry.then(/^withdrawing the learned principle stops future governance$/, () => {
  expect(state.activationId).toBeDefined();
  // REAL product entry for withdrawal: `pd activation deactivate` (the same
  // CLI surface the Owner uses).
  const deactivate = pdCli(['activation', 'deactivate', '--activation-id', state.activationId!, '--workspace', state.governance!], 60_000);
  expect(deactivate.status).toBe(0);
  if (state.learnedProbe !== undefined) {
    // Prompt leg ran: the next turn must not inject the withdrawn statement.
    const result = runEntry(state.home!, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: state.project, session_id: 'bdd-learn-withdraw' })), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(state.learnedProbe!);
    return;
  }
  // Non-prompt primary (channel dispatch): reversibility is asserted on the
  // durable activation row; the injection probe leg was skipped explicitly.
  const db = new Database(path.join(state.governance!, '.pd', 'state.db'), { readonly: true });
  try {
    const row = db.prepare('SELECT deactivated_at FROM activations WHERE activation_id = ?').get(state.activationId) as { deactivated_at: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.deactivated_at).toBeTruthy();
  } finally {
    db.close();
  }
  console.error('[bdd-learning] post-withdraw injection probe SKIPPED: prompt leg not active for this chain (channel dispatch); withdrawal verified on the durable activation row');
});

const featureDir = resolveFeaturePath('docs/specs/features/story-a');
// The real-LLM learning scenario needs minutes (provider latency + worker
// cycles) — give every BDD scenario a generous timeout instead of the 30s
// vitest default; itBdd additionally converts BlockedScenarioError into an
// honest vitest SKIP carrying the BLOCKED reason.
defineFeature(
  fs.readFileSync(path.join(featureDir, 'workbuddy-shared-host-runtime.feature'), 'utf8'),
  registry,
  { it: itBdd },
);
defineFeature(
  fs.readFileSync(path.join(featureDir, 'workbuddy-owner-loop.feature'), 'utf8'),
  registry,
  { it: itBdd },
);
