/**
 * Production-path tests (SPEC §8 三路径): the REAL built entry process against
 * a REAL governance workspace (SQLite state.db + trajectory.db) reached
 * through the production OD-07 resolution (fake home → os.homedir()).
 *
 * Activations are injected through the PRODUCTION store writers
 * (SqliteActivationStateStore.recordActivation) — never by direct writes to
 * evidence tables. Assertions cover:
 *   - approved prompt principle → UserPromptSubmit additionalContext injection;
 *   - live rule deny on a protected path → deny JSON (the P02-verified host
 *     blocker; the target file is never written by the hook);
 *   - a computed deny SURVIVES evidence persistence failure (encode first);
 *   - real PostToolUse failures → shared pain evidence chain, including the
 *     is_error-without-exitCode shape that must NOT default to success;
 *   - A/B project isolation on one governance workspace (P06);
 *   - degraded config never masquerades as healthy and never writes elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { admitBareHostPains } from '@principles/host-runtime';
import {
  SqliteActivationSafetyStore,
  SqliteApprovalQueueStore,
  SqliteConnection,
  computeArtifactDigest,
  mapPiArtifactRow,
} from '@principles/core/runtime-v2';
import { runEntry } from './helpers/hook-runner.js';
import {
  activationArtifact,
  cleanupTempDirs,
  fixturePayload,
  makeGovernance,
  makeHome,
  makeProjectDir,
  makeTrajectory,
} from './helpers/workbench.js';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';

afterAll(() => { cleanupTempDirs(); });

const PROMPT_PRINCIPLE = 'P_WB_PROMPT_601';
const LIVE_RULE = 'R_WB_LIVE_601';
const liveRuleCode = `function evaluate(input) { if (input.action.normalizedPath.indexOf('wb-protected-601') >= 0) return { decision: 'block', matched: true, reason: 'WB_RULE_DENY_601' }; return { decision: 'allow', matched: false, reason: 'safe' }; } var meta={name:'wb',version:'1',ruleId:'R_WB_LIVE_601',coversCondition:'all'};`;

function productionHome(options: { receiptLedger?: boolean } = {}): { home: string; governance: string } {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: options.receiptLedger ?? false });
  return { home, governance };
}

describe('three MVP paths through the real production runtime', () => {
  it('injects an owner-approved prompt principle into the UserPromptSubmit channel', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-prompt-601', kind: 'principle', principleId: PROMPT_PRINCIPLE,
      content: { principleId: PROMPT_PRINCIPLE, text: 'UNIQUE_WB_PROMPT_DIRECTIVE_601' },
      channel: 'prompt', action: 'prompt_activate', target: `ledger://${PROMPT_PRINCIPLE}`,
    });
    const project = makeProjectDir(home, 'inj');
    const payload = fixturePayload('user-prompt-submit.json', { cwd: project });
    const result = runEntry(home, JSON.stringify(payload), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    // Exactly ONE JSON line on stdout — no stray text (P04: raw stdout is injected).
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: expect.stringContaining('UNIQUE_WB_PROMPT_DIRECTIVE_601') },
    });
  });

  it('denies a protected live-rule tool call and leaves the target file unwritten; safe control stays neutral', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-rule-601', kind: 'rule', principleId: 'P_WB_RULE_601', ruleId: LIVE_RULE,
      content: { principleId: 'P_WB_RULE_601', ruleId: LIVE_RULE, implementationCode: liveRuleCode },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: `impl://${LIVE_RULE}`,
    });
    const project = makeProjectDir(home, 'deny');
    const deniedPath = path.join(project, 'wb-protected-601.txt');
    const denied = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: deniedPath, content: 'must not exist' } })), 'PreToolUse');
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'WB_RULE_DENY_601' } });
    // The hook itself never performs the tool; the deny JSON is the P02-verified
    // signal the HOST enforces (probe: target file not written).
    expect(fs.existsSync(deniedPath)).toBe(false);

    const allowedPath = path.join(project, 'wb-safe-601.txt');
    const allowed = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: allowedPath, content: 'x' } })), 'PreToolUse');
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
  });

  it('keeps the computed deny when evidence persistence fails (encode first, record after)', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-rule-602', kind: 'rule', principleId: 'P_WB_RULE_602', ruleId: 'R_WB_LIVE_602',
      content: { principleId: 'P_WB_RULE_602', ruleId: 'R_WB_LIVE_602', implementationCode: liveRuleCode.replace(/601/g, '602') },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_LIVE_602',
    });
    // Real fs failure at the events writer: the file path is a DIRECTORY.
    const today = new Date().toISOString().slice(0, 10);
    fs.mkdirSync(path.join(governance, '.state', 'logs', `events_${today}.jsonl`), { recursive: true });
    const project = makeProjectDir(home, 'persist');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-protected-602.txt'), content: 'x' } })), 'PreToolUse');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'WB_RULE_DENY_602' } });
    expect(result.stderr).toContain('rulehost_evaluation_persist_failed');
  });

  it('records real PostToolUse failures into the shared evidence chain (exitCode AND is_error shapes)', async () => {
    const { home, governance } = productionHome({ receiptLedger: false });
    makeTrajectory(governance);
    const project = makeProjectDir(home, 'post');

    // Bash non-zero exit (fixture shape): explicit error + exitCode 7.
    const bash = runEntry(home, JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', { cwd: project })), 'PostToolUse');
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe('');

    // Read is_error WITHOUT exitCode: decoder normalization must keep it a
    // FAILURE (forbidden to default to success because exitCode is missing).
    // exit_code stays NULL (SPEC-CODEX-PAIN-CLOSURE-001 CR-01, merged from
    // main): a missing exit code is never fabricated as 0 — the failure
    // classification comes from the is_error/error shape, not the exit code.
    const read = runEntry(home, JSON.stringify(fixturePayload('post-tool-use-read-iserror.json', { cwd: project })), 'PostToolUse');
    expect(read.status).toBe(0);
    expect(read.stdout).toBe('');

    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    const rows = db.prepare('SELECT session_id, tool_name, outcome, exit_code FROM tool_calls ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { session_id: '01a130ba-7d8f-7e0a-9c58-a9d7aade3447', tool_name: 'Bash', outcome: 'failure', exit_code: 7 },
      { session_id: '01a130ba-742f-703e-a8d6-2902387259ee', tool_name: 'Read', outcome: 'failure', exit_code: null },
    ]);
  });

  it('delivery evidence lands durably through the frozen workbuddy source kind (schema CHECK migrated for the third host)', async () => {
    // The shared evidence schema now accepts workbuddy host rows (the
    // pre-workbuddy CHECK was migrated in principles-core); this test pins
    // the full success contract: injection + durable evidence rows + the
    // capability declarations for the WorkBuddy host, and NO degradation.
    const { home, governance } = productionHome({ receiptLedger: true });
    await activationArtifact(governance, {
      id: 'art-ev-603', kind: 'principle', principleId: 'P_WB_EV_603',
      content: { principleId: 'P_WB_EV_603', text: 'UNIQUE_WB_EVIDENCE_603' },
      channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_WB_EV_603',
    });
    const project = makeProjectDir(home, 'ev');
    const result = runEntry(home, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: project })), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('UNIQUE_WB_EVIDENCE_603');
    // Evidence append succeeded — no observable degradation (rc-9 would have
    // surfaced one; its absence after the schema fix is the assertion).
    expect(result.stderr).not.toContain('append degraded');
    // Durable normalized delivery rows exist under the frozen source kind.
    const db = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
    try {
      const evidence = db.prepare(
        "SELECT source_kind, record_kind FROM intervention_evidence_records WHERE source_kind = 'workbuddy_pd_hook_event_log'",
      ).all();
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.some((row) => row.record_kind === 'delivery')).toBe(true);
      const capabilities = db.prepare(
        "SELECT capability, status FROM intervention_capability_declarations WHERE host_kind = 'workbuddy'",
      ).all();
      expect(capabilities.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    // The durable raw event line also exists (SPEC §13.7 replay source).
    const logsDir = path.join(governance, '.state', 'logs');
    const injectedLines = fs.readdirSync(logsDir)
      .filter((file) => file.startsWith('events_') && file.endsWith('.jsonl'))
      .flatMap((file) => fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean))
      .filter((line) => line.includes('"runtime_v2_prompt_activations_injected"'));
    expect(injectedLines.length).toBeGreaterThan(0);
  });

  it('deny chain evidence failure never touches the encoded deny (P02 boundary)', async () => {
    const { home, governance } = productionHome({ receiptLedger: true });
    await activationArtifact(governance, {
      id: 'art-rule-604', kind: 'rule', principleId: 'P_WB_RULE_604', ruleId: 'R_WB_LIVE_604',
      content: { principleId: 'P_WB_RULE_604', ruleId: 'R_WB_LIVE_604', implementationCode: liveRuleCode.replace(/601/g, '604') },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_LIVE_604',
    });
    const project = makeProjectDir(home, 'evdeny');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-protected-604.txt'), content: 'x' } })), 'PreToolUse');
    expect(result.status).toBe(0);
    // The deny is the real blocking signal (P02). Evidence now appends
    // cleanly (post schema migration); nothing degrades the decision.
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'WB_RULE_DENY_604' } });
    expect(result.stderr).not.toContain('append degraded');
  });
});

describe('P06 workspace semantics: A/B projects share ONE governance workspace', () => {
  it('both projects read the same governance activations and create no project-local state', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-ab-605', kind: 'principle', principleId: 'P_WB_AB_605',
      content: { principleId: 'P_WB_AB_605', text: 'UNIQUE_WB_AB_DIRECTIVE_605' },
      channel: 'prompt', action: 'prompt_activate', target: 'ledger://P_WB_AB_605',
    });
    const projectA = makeProjectDir(home, 'a');
    const projectB = makeProjectDir(home, 'b');
    for (const project of [projectA, projectB]) {
      const result = runEntry(home, JSON.stringify(fixturePayload('user-prompt-submit.json', { cwd: project, session_id: `sess-ab-${path.basename(project)}` })), 'UserPromptSubmit');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('UNIQUE_WB_AB_DIRECTIVE_605');
      // No governance state ever lands in the PROJECT directory.
      expect(fs.existsSync(path.join(project, '.pd'))).toBe(false);
      expect(fs.existsSync(path.join(project, '.state'))).toBe(false);
    }
  });
});

describe('PostToolUseFailure subscription (OD-02 evidence-driven, engine 2.161.0 re-verified 2026-10-13)', () => {
  it('routes the real thrown-Write-error payload through the shared pain path: failure evidence WITH error attribution, and honestly BELOW the bare-pain admission floor', async () => {
    const { home, governance } = productionHome();
    makeTrajectory(governance);
    const project = makeProjectDir(home, 'ptuf');

    // The REAL engine payload shape (probe P03 fixture + 2026-10-13 lab):
    // thrown `error` + tool_error_code=2009, NO tool_response. The hook result
    // is the after_tool_call neutral — nothing blockable exists there (P02).
    const result = runEntry(home, JSON.stringify(fixturePayload('post-tool-use-failure-write-notread.json', { cwd: project })), 'PostToolUseFailure');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    // Evidence chain: the tool_calls row keeps the REAL failure with the
    // thrown error text and exit_code NULL — normalization must not invent
    // an exit code (CR-01, merged from main: missing stays null, never a
    // fabricated 0) nor misclassify the thrown error as success.
    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    try {
      const calls = db.prepare('SELECT tool_name, outcome, exit_code, error_message FROM tool_calls ORDER BY id').all();
      expect(calls).toEqual([
        { tool_name: 'Write', outcome: 'failure', exit_code: null, error_message: expect.stringContaining('File has not been read yet') },
      ]);
      // pain_events stays EMPTY — and that is the POLICY outcome, not an
      // event loss: the thrown-error shape carries no exitCode, so the shared
      // production score is the risky-path bonus only (20 < the 70 floor of
      // GOVERNANCE_STRONG_PAIN_SCORE), triage stays evidence_only, and the
      // production handler only writes pain rows for ADMITTED failures.
      const pains = db.prepare('SELECT canonical_pain_id, score, host_kind FROM pain_events').all();
      expect(pains).toEqual([]);
    } finally {
      db.close();
    }

    // The durable WorkBuddy event log (rc-9 receipt chain) carries the failure
    // attribution too — paths redacted by telemetry policy, message preserved.
    const logsDir = path.join(governance, '.state', 'logs');
    const toolLines = fs.readdirSync(logsDir)
      .filter((file) => file.startsWith('events_') && file.endsWith('.jsonl'))
      .flatMap((file) => fs.readFileSync(path.join(logsDir, file), 'utf8').split('\n').filter(Boolean))
      .filter((line) => line.includes('"tool_call"'));
    expect(toolLines.length).toBe(1);
    const parsed = JSON.parse(toolLines[0] ?? '{}') as { type?: string; category?: string; data?: { toolName?: string; error?: string } };
    expect(parsed.type).toBe('tool_call');
    expect(parsed.category).toBe('failure');
    expect(parsed.data?.toolName).toBe('Write');
    expect(parsed.data?.error).toContain('File has not been read yet');

    // The worker's bare-pain admission sweep (score>=70 floor) confirms there
    // is nothing to queue for this shape: policy exclusion, nothing stranded.
    const sweep = await admitBareHostPains({ workspaceDir: governance, hostKind: 'workbuddy' });
    expect(sweep.ok).toBe(true);
    expect(sweep.admitted).toBe(0);
    expect(sweep.ensured).toBe(0);
    expect(sweep.skippedInvalid).toBe(0);
  });

  it('decoder keeps PostToolUseFailure honest: a missing thrown error fails loud instead of becoming a success', () => {
    // Belt for the exact payload family this subscription now receives: the
    // decoder's requiredString('error') guard (rc-3) — registered in
    // hooks.json, so a malformed delivery degrades per the after_tool_call
    // channel instead of poisoning the evidence chain with a fake success.
    const payload = fixturePayload('post-tool-use-failure-write-notread.json');
    delete payload['error'];
    const result = runEntry(makeHome(), JSON.stringify(payload), 'PostToolUseFailure');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing or malformed required field "error"');
  });
});

describe('degraded / unsupported never masquerade as healthy', () => {
  it('malformed governance config: neutral result, structured degraded reason, no writes anywhere', () => {
    const home = makeHome();
    makeGovernance(home, { malformed: true });
    const project = makeProjectDir(home, 'malformed');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project })), 'PreToolUse');
    // Degraded workspace is NOT escalated to blocking (the Owner has no working
    // opt-in signal) — and it is not reported as healthy silence either.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/status=degraded reason=[^\s]+/);
    const governance = getWorkbuddyWorkspaceDir(home);
    expect(fs.existsSync(path.join(governance, '.pd', 'state.db'))).toBe(false);
    expect(fs.existsSync(path.join(governance, '.state'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.pd'))).toBe(false);
  });

  it('SPEC §11.3/H13: a v2 artifact NOT stamped for WorkBuddy stays suspended with the structured qualification warning (cross-host artifact refusal)', async () => {
    const home = makeHome();
    const governance = makeGovernance(home, { workbuddyFlag: true, ruleContextV2Flag: true });
    const v2Code = liveRuleCode.replace(/601/g, '606').replace('wb-protected-601', 'wb-v2ctx-606');
    await activationArtifact(governance, {
      id: 'art-v2-606', kind: 'rule', principleId: 'P_WB_V2_606', ruleId: 'R_WB_V2_606',
      content: { principleId: 'P_WB_V2_606', ruleId: 'R_WB_V2_606', requiresContextVersion: 2, implementationCode: v2Code },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_V2_606',
    });
    const project = makeProjectDir(home, 'v2');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-v2ctx-606.txt'), content: 'x' } })), 'PreToolUse');
    // The v2 rule would DENY if loaded; allow + the precise qualification
    // warning proves the WorkBuddy gate refuses to auto-execute a historical
    // V2 artifact that was never issued for this host (SPEC §11.3) — the
    // pre-SPEC behavior (context suspension) masked the sharper reason.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('workbuddy_rule_context_v2_unqualified: activation=act-art-v2-606');
  });

  it('SPEC §6/H08: a WorkBuddy-stamped, Owner-approved v2 artifact with no session history suspends via the provider unavailable context — never context-blind', async () => {
    const home = makeHome();
    const governance = makeGovernance(home, { workbuddyFlag: true, ruleContextV2Flag: true });
    makeTrajectory(governance);
    const v2Code = liveRuleCode.replace(/601/g, '607').replace('wb-protected-601', 'wb-v2ctx-607');
    const artifactId = 'art-v2-607';
    await activationArtifact(governance, {
      id: artifactId, kind: 'rule', principleId: 'P_WB_V2_607', ruleId: 'R_WB_V2_607',
      content: {
        principleId: 'P_WB_V2_607', ruleId: 'R_WB_V2_607', requiresContextVersion: 2,
        implementationCode: v2Code,
        ruleHostInputContract: { version: 1, contextVersion: 2, hostKinds: ['workbuddy'] },
      },
      channel: 'code_tool_hook', action: 'code_tool_hook_shadow_activate', target: 'impl://R_WB_V2_607',
    });
    // Same-artifact Owner approval + digest-bound promotion — the same
    // qualification inputs the Codex V2 gate requires (P4: one gate, no
    // WorkBuddy-specific trust rule).
    const connection = new SqliteConnection(governance);
    try {
      const approvals = new SqliteApprovalQueueStore(connection);
      const approval = await approvals.enqueue({ artifactId, channel: 'code_tool_hook', riskLevel: 'high' }, new Date().toISOString());
      const decision = await approvals.approve(approval.approvalId, 'owner-test', 'WorkBuddy v2 qualification fixture');
      if (!decision.ok) throw new Error(`test approval fixture failed: ${decision.error}`);
      const artifactRow: unknown = connection.getDb().prepare('SELECT artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at FROM pi_artifacts WHERE artifact_id = ?').get(artifactId);
      if (typeof artifactRow !== 'object' || artifactRow === null) throw new Error('fixture artifact row missing');
      // P4: reuse the production digest helpers (same authority the gate
      // verifies against) instead of hand-building the digest (rc-2).
      const digest = computeArtifactDigest(mapPiArtifactRow(artifactRow));
      await new SqliteActivationSafetyStore(connection).commitPromotion({
        decision: {
          decisionId: 'decision-art-v2-607',
          subject: { kind: 'activation', activationId: `act-${artifactId}`, artifactId, artifactDigest: digest },
          decision: 'promote_live',
          principal: { kind: 'configured_owner', ownerId: 'owner-test' },
          authentication: { method: 'console_token', credentialId: 'credential-test' },
          reasonCode: 'workbuddy_v2_test_promotion',
          note: 'Test fixture for a digest-bound live activation.',
          evidenceSnapshotId: 'snapshot-wb-v2-607',
          decidedAt: new Date().toISOString(),
        },
        evidenceSnapshot: {
          snapshotId: 'snapshot-wb-v2-607', snapshotDigest: 'sha256:snapshot-wb-v2-607', artifactDigest: digest,
          lineageRefs: [`task-${artifactId}`], hostRuntimeVersion: 'host-runtime-test',
          safetyGateResults: [{ checkId: 'wb-v2-test', status: 'passed' }],
          shadowSummary: {
            observed: 2, matched: 1, wouldBlock: 1, wouldAllow: 1, requireApproval: 0,
            autoCorrect: 0, errors: 0, neutralControl: 0,
            firstObservedAt: new Date().toISOString(), lastObservedAt: new Date().toISOString(),
          },
          configurationVersion: 'test-config-v1', redaction: { version: 'test-redaction-v1', rawParametersStored: false },
          createdAt: new Date().toISOString(),
        },
        readinessEvaluationId: 'readiness-wb-v2-607',
        evidenceSnapshotDigest: 'sha256:snapshot-wb-v2-607',
        expectedControlVersion: 1,
        idempotencyKey: 'promotion-wb-v2-607',
      });
    } finally {
      connection.close();
    }
    const project = makeProjectDir(home, 'v2h');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-v2ctx-607.txt'), content: 'x' } })), 'PreToolUse');
    // Qualified artifact, but the provider honestly reports no prior session
    // history → the shared gate suspends the rule with the structured
    // unavailable warning; the WorkBuddy boundary note annotates it. The v2
    // rule would DENY if executed context-blind; allow proves suspension.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('rule_context_v2_unavailable');
    expect(result.stderr).toContain('workbuddy_runtime_context_limited');
  });

  it('an undeliverable deny (stdout serialization failure) escalates to blocking exit 2 — never silent {} + exit 0 (SPEC §4.4)', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-rule-607', kind: 'rule', principleId: 'P_WB_RULE_607', ruleId: 'R_WB_LIVE_607',
      content: { principleId: 'P_WB_RULE_607', ruleId: 'R_WB_LIVE_607', implementationCode: liveRuleCode.replace(/601/g, '607') },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_LIVE_607',
    });
    const project = makeProjectDir(home, 'ser');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-protected-607.txt'), content: 'x' } })), 'PreToolUse', {
      // Break serialization ONLY for the hookSpecificOutput document — every
      // other JSON.stringify consumer (gate param hashing, event lines) keeps
      // working, so the fault under test is exactly the stdout contract.
      childPrelude: `(() => {`
        + `  const realStringify = JSON.stringify.bind(JSON);`
        + `  JSON.stringify = (value, ...rest) => {`
        + `    if (value && typeof value === 'object' && Object.hasOwn(value, 'hookSpecificOutput')) throw new Error('forced serialize failure');`
        + `    return realStringify(value, ...rest);`
        + `  };`
        + `})();`,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('hook_stdout_serialize_failed');
  });

  it('a deny whose stdout WRITE fails escalates to blocking exit 2 (P02: stdout-closed exit 2 still blocks)', async () => {
    const { home, governance } = productionHome();
    await activationArtifact(governance, {
      id: 'art-rule-608', kind: 'rule', principleId: 'P_WB_RULE_608', ruleId: 'R_WB_LIVE_608',
      content: { principleId: 'P_WB_RULE_608', ruleId: 'R_WB_LIVE_608', implementationCode: liveRuleCode.replace(/601/g, '608') },
      channel: 'code_tool_hook', action: 'code_tool_hook_live_activate', target: 'impl://R_WB_LIVE_608',
    });
    const project = makeProjectDir(home, 'wrfail');
    const result = runEntry(home, JSON.stringify(fixturePayload('pre-tool-use-write.json', { cwd: project, tool_input: { file_path: path.join(project, 'wb-protected-608.txt'), content: 'x' } })), 'PreToolUse', {
      // The deny SERIALIZES fine but every stdout write throws: the deny bytes
      // are lost, so the exit code must become the blocker — never exit 0.
      childPrelude: `process.stdout.write = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE', syscall: 'write' }); };`,
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('hook_stream_failed');
  });
});
