// PRI-1163 round-key run — OFFLINE negative fixtures (pure gate logic only).
// No host starts, no provider requests, no production access: every case
// feeds explicit inputs to the pure functions in lib/roundkey-gate.mjs and
// asserts the fail-closed behavior the run card promises.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readAppendedBytes, logEvidenceIntegrity, judgeRound, perRoundProductionFence,
  refuseRerun, validateApprovalBinding, envFingerprint,
} from '../dev/aa-controlled-admission/lib/roundkey-gate.mjs';

const SESSION = '6e1f2a3b-4c5d-4e8f-9a0b-1c2d3e4f5a6b';
const FIXTURE_IDS = ['pri1163-roundkey-fixture-01', 'pri1163-roundkey-fixture-02', 'pri1163-roundkey-fixture-03', 'pri1163-roundkey-fixture-04', 'pri1163-roundkey-fixture-05', 'pri1163-roundkey-fixture-06'];
const REG_LINE = 'Principles Disciple Plugin registered. (Path: C:\\pack\\candidate\\principles-disciple)';
const EXPL_LINE = 'PD explicit workspace (pd_env: C:\\pack\\workspace) differs from OpenClaw context (Z:\\decoy). Using PD explicit.';
const TRIG_LINE = (t) => `[PD:Prompt] handleBeforePromptBuild called: workspaceDir=true, trigger=${t}, sessionId=${SESSION}`;
const roundLog = (trigger = 'user') => [REG_LINE, EXPL_LINE, TRIG_LINE(trigger), '[PD:Prompt] round key resolved: round=3'].join('\n');
const injectedEvent = (ordinal, rotStart) => ({ ts: '2026-11-10T05:00:00.000Z', type: 'runtime_v2_prompt_activations_injected', sessionId: SESSION, data: { selectionPolicy: 'fair_rotation_v1', selectionRoundOrdinal: ordinal, rotationStartIndex: rotStart, principleIds: FIXTURE_IDS } });

const goodRoundInputs = (roundId, previous, hostLogText, events, indexes) => ({
  roundId, previous,
  hostExitCode: 0, timedOut: false,
  envelope: { ok: true, sessionId: SESSION },
  endpointServed: 1, endpointRefused: 0,
  endpointPath: '/v1/chat/completions', expectedEndpointPath: '/v1/chat/completions',
  hostLogDeltaText: hostLogText, events,
  trajectoryIndexes: indexes, candidateBundleOk: true,
  candidateRoot: 'C:\\pack\\candidate\\principles-disciple', workspaceDir: 'C:\\pack\\workspace',
  session: SESSION, fixtureIds: FIXTURE_IDS,
});

describe('per-round production fence', () => {
  it('production marker after R1 (run-session rows in production) fails the fence with a stable code', () => {
    const fence = perRoundProductionFence({ roundId: 'R1', before: { total: 1213, runSessionRows: 0 }, after: { total: 1214, runSessionRows: 1 } });
    expect(fence.ok).toBe(false);
    expect(fence.violations.map((v) => v.code)).toContain('PRODUCTION_FENCE_RUN_SESSION_ROWS');
  });

  it('a decreased production total fails the fence', () => {
    const fence = perRoundProductionFence({ roundId: 'R1', before: { total: 1213, runSessionRows: 0 }, after: { total: 1212, runSessionRows: 0 } });
    expect(fence.ok).toBe(false);
    expect(fence.violations.map((v) => v.code)).toContain('PRODUCTION_FENCE_TOTAL_DECREASED');
  });

  it('an unreadable production snapshot is reported incomplete (never silently ignored)', () => {
    const fence = perRoundProductionFence({ roundId: 'R1', before: { total: 1213, runSessionRows: 0 }, after: null });
    expect(fence.ok).toBe(false);
    expect(fence.violations.map((v) => v.code)).toContain('PRODUCTION_FENCE_INCOMPLETE');
  });

  it('a clean round passes the fence', () => {
    const fence = perRoundProductionFence({ roundId: 'R1', before: { total: 1213, runSessionRows: 0 }, after: { total: 1214, runSessionRows: 0 } });
    expect(fence.ok).toBe(true);
  });
});

describe('exclusive claim (same pack re-execution)', () => {
  it('refuses when run/, the ledger or the claim file already exists', () => {
    for (const state of [{ runDirExists: true, ledgerExists: false, claimExists: false }, { runDirExists: false, ledgerExists: true, claimExists: false }, { runDirExists: false, ledgerExists: false, claimExists: true }]) {
      const refusal = refuseRerun(state);
      expect(refusal.refused).toBe(true);
      expect(refusal.code).toBe('PACK_ALREADY_CLAIMED');
    }
  });

  it('does not refuse a fresh pack', () => {
    expect(refuseRerun({ runDirExists: false, ledgerExists: false, claimExists: false }).refused).toBe(false);
  });
});

describe('R2 missing its own registration line', () => {
  it('R1 with a registration line passes the identity check', () => {
    const gate = judgeRound(goodRoundInputs('R1', null, roundLog('user'), [injectedEvent(3, 2)], [2]));
    expect(gate.ok).toBe(true);
    expect(gate.violations.filter((v) => v.code === 'candidate-registration-source')).toHaveLength(0);
  });

  it('R2 WITHOUT a registration line fails even though R1 had one (log judged per round)', () => {
    const r1 = judgeRound(goodRoundInputs('R1', null, roundLog('user'), [injectedEvent(3, 2)], [2]));
    expect(r1.ok).toBe(true);
    const logWithoutRegistration = [EXPL_LINE, TRIG_LINE('user'), '[PD:Prompt] round key resolved: round=4'].join('\n');
    const r2 = judgeRound(goodRoundInputs('R2', { ordinal: 3, rotStart: 2 }, logWithoutRegistration, [injectedEvent(4, 3)], [2, 3]));
    expect(r2.ok).toBe(false);
    expect(r2.violations.map((v) => v.code)).toContain('candidate-registration-source');
  });

  it('a non-user trigger in R2 is a real-signal failure (heartbeat must not advance ordinals)', () => {
    const r2 = judgeRound(goodRoundInputs('R2', { ordinal: 3, rotStart: 2 }, roundLog('heartbeat'), [injectedEvent(4, 3)], [2, 3]));
    expect(r2.ok).toBe(false);
    expect(r2.violations.map((v) => v.code)).toContain('trigger-not-user-round');
  });
});

describe('byte-exact log deltas with Chinese content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rk-gate-test-'));
  const logPath = join(dir, 'openclaw-host.log');
  const first = `[PD:Prompt] 轮次序数解析：round=3，会话=${SESSION}\n中文行带符号：＜脆弱＞＆"引号"\n`;
  const second = '[PD:Prompt] round key resolved: round=4, sessionId=fixture-sess\n[PD:Config] 中文增量第二段：序数推进 ✓\n';

  it('reads the appended delta by BYTES so multi-byte UTF-8 is never split or mangled', () => {
    writeFileSync(logPath, first, 'utf8');
    const beforeBytes = statSync(logPath).size;
    writeFileSync(logPath, first + second, 'utf8'); // append
    const delta = readAppendedBytes(logPath, beforeBytes);
    expect(delta.shrunk).toBe(false);
    expect(delta.truncated).toBe(false);
    expect(delta.text).toBe(second);
    expect(delta.text).toContain('中文增量第二段：序数推进 ✓');
    expect(delta.bytes).toBe(Buffer.byteLength(second, 'utf8'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a shrunken log as HOST_LOG_SHRUNK (evidence incomplete)', () => {
    const shrunk = { text: '', bytes: 0, truncated: false, shrunk: true };
    const integrity = logEvidenceIntegrity({ hostLogDelta: shrunk, eventFiles: [] });
    expect(integrity.complete).toBe(false);
    expect(integrity.steps.map((s) => s.code)).toContain('HOST_LOG_SHRUNK');
  });

  it('reads events appended after a CJK-heavy baseline without counting old lines', () => {
    const eventsDir = join(dir, 'logs');
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, 'events_2026-11-10.jsonl');
    const oldLine = JSON.stringify({ ts: '2026-11-10T04:00:00.000Z', type: 'runtime_v2_prompt_activations_injected', data: { selectionPolicy: 'legacy_fifo_prefix_v1', 中文备注: '旧轮' } }) + '\n';
    writeFileSync(eventsPath, oldLine, 'utf8');
    const before = new Map([['events_2026-11-10.jsonl', statSync(eventsPath).size]]);
    const newLine = JSON.stringify(injectedEvent(4, 3)) + '\n';
    writeFileSync(eventsPath, oldLine + newLine, 'utf8');
    // byte-exact reader over the delta only
    const delta = readAppendedBytes(eventsPath, before.get('events_2026-11-10.jsonl'));
    const parsed = delta.text.split('\n').filter((l) => l.includes('runtime_v2_prompt_activations_injected')).map((l) => JSON.parse(l));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].data.selectionRoundOrdinal).toBe(4);
    const integrity = logEvidenceIntegrity({ hostLogDelta: { text: '', bytes: 0, truncated: false, shrunk: false }, eventFiles: [{ name: 'events_2026-11-10.jsonl', ...delta }] });
    expect(integrity.complete).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('approval binding (PRI-1152 #2424 validation pattern)', () => {
  const manifest = {
    cardVersion: 'pri1163-round-key-run-card-v2',
    budgets: { hostTurns: 2, httpRequests: 2, toolCalls: 0, paidCalls: 0 },
    executionCode: { scripts: [{ path: 'round-key-run.mjs', sha256: 'aaa' }, { path: 'lib/roundkey-gate.mjs', sha256: 'bbb' }] },
  };

  const goodApproval = {
    schemaVersion: 'pd-round-key-run-approval/v1',
    cardVersion: manifest.cardVersion,
    manifestSha256: 'm-sha',
    budgets: manifest.budgets,
    executionCode: manifest.executionCode,
    approvedBy: 'owner',
    approvedAt: '2026-11-10T05:00:00Z',
  };

  it('accepts a fully-bound, signed approval with unchanged scripts', () => {
    const violations = validateApprovalBinding({ approval: goodApproval, manifest, manifestSha256: 'm-sha', executionCodeNow: manifest.executionCode });
    expect(violations).toHaveLength(0);
  });

  it('refuses when the executing scripts changed after prepare (EXECUTION_CODE_DRIFT)', () => {
    const drifted = { scripts: [{ path: 'round-key-run.mjs', sha256: 'aaa' }, { path: 'lib/roundkey-gate.mjs', sha256: 'CHANGED' }] };
    const violations = validateApprovalBinding({ approval: goodApproval, manifest, manifestSha256: 'm-sha', executionCodeNow: drifted });
    expect(violations.map((v) => v.code)).toContain('EXECUTION_CODE_DRIFT');
  });

  it('refuses budgets that differ from the frozen manifest', () => {
    const violations = validateApprovalBinding({ approval: { ...goodApproval, budgets: { hostTurns: 4, httpRequests: 4, toolCalls: 1, paidCalls: 0 } }, manifest, manifestSha256: 'm-sha', executionCodeNow: manifest.executionCode });
    expect(violations.map((v) => v.code)).toContain('APPROVAL_BUDGETS');
  });

  it('refuses an approval that does not bind the execution code', () => {
    const { executionCode, ...withoutCode } = goodApproval;
    const violations = validateApprovalBinding({ approval: withoutCode, manifest, manifestSha256: 'm-sha', executionCodeNow: manifest.executionCode });
    expect(violations.map((v) => v.code)).toContain('APPROVAL_EXECUTION_CODE');
  });

  it('refuses an unsigned or stale-card approval', () => {
    const unsigned = validateApprovalBinding({ approval: { ...goodApproval, approvedBy: '' }, manifest, manifestSha256: 'm-sha' });
    expect(unsigned.map((v) => v.code)).toContain('APPROVAL_UNSIGNED');
    const stale = validateApprovalBinding({ approval: { ...goodApproval, cardVersion: 'pri1163-round-key-run-card-v1' }, manifest, manifestSha256: 'm-sha' });
    expect(stale.map((v) => v.code)).toContain('APPROVAL_CARD_VERSION');
  });
});

describe('env parity', () => {
  it('fingerprints are stable for identical envs and differ on any value change', () => {
    const a = envFingerprint({ A: '1', B: '中文' });
    expect(envFingerprint({ B: '中文', A: '1' })).toBe(a);
    expect(envFingerprint({ A: '1', B: '不同' })).not.toBe(a);
    expect(envFingerprint({ A: '1' })).not.toBe(a);
  });
});
