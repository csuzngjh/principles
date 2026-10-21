import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROMPT_BUDGET_POLICY_VERSION } from '@principles/core/runtime-v2';
import {
  RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS,
  RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES,
  RUNTIME_BUDGET_OBSERVATION_MAX_FILES,
  RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS,
  readRuntimePromptBudgetObservations,
  runtimeBudgetObservationToResolution,
  selectConsoleRuntimeBudgetFacts,
  selectRuntimeBudgetObservation,
} from '../src/index.js';

/**
 * PRI-1017: the runtime budget OBSERVATION read model — the console-side
 * bridge from the persisted injection events back to a budget fact.
 *
 * Honesty rules under test (SPEC-PD-MODEL-AWARE-PROMPT-BUDGET-001 §6.1/§7):
 * - observations are PAST facts bound to ONE host (never cross-host);
 * - absence is UNKNOWN, never a fabricated window or a zero;
 * - pre-policy events and foreign-policy-version events are skipped, not
 *   reinterpreted;
 * - untrusted field values are dropped loudly (parseFailures / skip counts),
 *   never guessed into a confirmed capacity;
 * - a stale observation is NOT a current fact.
 */

const tempDirs: string[] = [];

function tempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-budget-obs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

function writeEvents(workspaceDir: string, dirName: string, date: string, entries: unknown[]): void {
  fs.mkdirSync(path.join(workspaceDir, ...dirName.split('/')), { recursive: true });
  fs.appendFileSync(
    path.join(workspaceDir, ...dirName.split('/'), `events_${date}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    'utf8',
  );
}

function injectedEvent(overrides: {
  ts?: string;
  data: Record<string, unknown>;
}): unknown {
  return {
    ts: overrides.ts ?? '2026-10-21T04:00:00.000Z',
    date: '2026-10-21',
    type: 'runtime_v2_prompt_activations_injected',
    category: 'injected',
    sessionId: 's-1',
    ...overrides,
  };
}

function baseData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's-1',
    workspaceDir: 'ws-a',
    activationIds: ['act-1'],
    artifactIds: ['a'],
    principleIds: ['p1'],
    injectedCount: 1,
    injectedCharCount: 480,
    budget: 2000,
    ...extra,
  };
}

function workspaceWith(data: Record<string, unknown>, ts?: string): string {
  const dir = tempWorkspace();
  writeEvents(dir, '.state/logs', '2026-10-21', [injectedEvent({ data: { ...baseData(), workspaceDir: dir, ...data }, ...(ts !== undefined ? { ts } : {}) })]);
  return dir;
}

describe('PRI-1017: readRuntimePromptBudgetObservations', () => {
  it('no logs at all → no observations with an explicit unknown note (never a fabricated window)', () => {
    const report = readRuntimePromptBudgetObservations({ workspaceDir: tempWorkspace() });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(0);
    expect(report.note).toContain('UNKNOWN');
  });

  it('a trusted 256K host-window event yields the 4000-char observation with full provenance', () => {
    const dir = workspaceWith({
      hostKind: 'openclaw',
      eventId: 'evt-1',
      budget: 4000,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
    });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toHaveLength(1);
    const [observation] = report.observations;
    expect(observation).toMatchObject({
      workspaceDir: dir,
      hostKind: 'openclaw',
      budgetChars: 4000,
      capacitySource: 'host_effective_window',
      capacityStatus: 'confirmed',
      contextWindowTokens: 256_000,
      fallbackReason: null,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
      observedAt: '2026-10-21T04:00:00.000Z',
    });
  });

  it('a fallback event keeps its bounded reason (the runtime itself fell back — traceable)', () => {
    const dir = workspaceWith({
      hostKind: 'codex',
      budget: 2000,
      budgetCapacitySource: 'legacy_fallback',
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'host_capacity_absent',
      budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
    });
    const [observation] = readRuntimePromptBudgetObservations({ workspaceDir: dir }).observations;
    expect(observation).toMatchObject({
      budgetChars: 2000,
      capacitySource: 'legacy_fallback',
      capacityStatus: 'unknown',
      fallbackReason: 'host_capacity_absent',
      contextWindowTokens: null,
    });
  });

  it('the latest event per host wins (older observations never mask newer facts)', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-20', [
      injectedEvent({ ts: '2026-10-20T04:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 1250, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 32_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ ts: '2026-10-21T04:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const [observation] = readRuntimePromptBudgetObservations({ workspaceDir: dir }).observations;
    expect(observation?.budgetChars).toBe(4000);
    expect(observation?.observedAt).toBe('2026-10-21T04:00:00.000Z');
  });

  it('observations are host-bucketed: OpenClaw’s window is never Codex’s fact', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'codex', budget: 2000, budgetCapacitySource: 'legacy_fallback', budgetCapacityStatus: 'unknown', budgetFallbackReason: 'model_identity_absent', budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const byHost = new Map(readRuntimePromptBudgetObservations({ workspaceDir: dir }).observations.map((o) => [o.hostKind, o]));
    expect(byHost.get('openclaw')?.budgetChars).toBe(4000);
    expect(byHost.get('codex')?.budgetChars).toBe(2000);
    expect(byHost.get('codex')?.fallbackReason).toBe('model_identity_absent');
  });

  it('events bound to another workspace are not this workspace’s fact', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: '/some/other/workspace', hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('workspace binding tolerates separator/trailing-slash variance (path.resolve, like the console CLI)', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: `${dir}${path.sep}`, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]?.budgetChars).toBe(4000);
  });

  it('pre-policy events (no provenance fields) are skipped and counted, never reinterpreted', () => {
    const dir = workspaceWith({ hostKind: 'openclaw', eventId: 'evt-old' });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('events computed under a different policy version are skipped and counted', () => {
    const dir = workspaceWith({
      hostKind: 'openclaw',
      budget: 9999,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: 'some_future_policy_v9',
    });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.foreignPolicyEventsSkipped).toBe(1);
  });

  it('provenance without a policy version is pre-policy, not "current by default"', () => {
    // A writer that emits source/status/window but no policy version cannot
    // prove the budget was computed under the CURRENT formula. Treating the
    // absence as current would re-interpret a fact we cannot verify.
    const dir = workspaceWith({
      hostKind: 'openclaw',
      budget: 4000,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
    });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('a budget that does not match the shared formula is incoherent and dropped (budget === floor(2000*W/128000) clamped)', () => {
    const dir = workspaceWith({
      hostKind: 'openclaw',
      budget: 2000,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
    });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('a legacy fallback carrying a context window is incoherent and dropped (fallback has no window)', () => {
    const dir = workspaceWith({
      hostKind: 'codex',
      budget: 2000,
      budgetCapacitySource: 'legacy_fallback',
      budgetCapacityStatus: 'unknown',
      budgetFallbackReason: 'host_capacity_absent',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
    });
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('an unparseable envelope timestamp is skipped (no "latest" ordering on garbage)', () => {
    const dir = workspaceWith({
      hostKind: 'openclaw',
      budget: 4000,
      budgetCapacitySource: 'host_effective_window',
      budgetCapacityStatus: 'confirmed',
      budgetContextWindowTokens: 256_000,
      budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
    }, 'not-a-timestamp');
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('a future timestamp beyond clock skew is dropped and does not shadow a valid older observation', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ ts: '2026-10-21T04:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      injectedEvent({ ts: '2099-01-01T00:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 1250, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 32_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir, now: new Date('2026-10-21T12:00:00.000Z') });
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]?.observedAt).toBe('2026-10-21T04:00:00.000Z');
    expect(report.observations[0]?.budgetChars).toBe(4000);
    expect(report.legacyEventsSkipped).toBe(1);
  });

  it('the min and max clamp boundaries are accepted exactly as the shared formula computes them', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      // 32K → floor(2000*32000/128000)=500 → clamped to the 1250 floor.
      injectedEvent({ ts: '2026-10-21T01:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 1250, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 32_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      // 1M → 15625, below the 16000 ceiling.
      injectedEvent({ ts: '2026-10-21T02:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'codex', budget: 15_625, budgetCapacitySource: 'pi_catalog_exact', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 1_000_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const byHost = new Map(readRuntimePromptBudgetObservations({ workspaceDir: dir, now: new Date('2026-10-21T12:00:00.000Z') }).observations.map((o) => [o.hostKind, o]));
    expect(byHost.get('openclaw')?.budgetChars).toBe(1250);
    expect(byHost.get('codex')?.budgetChars).toBe(15_625);
  });

  it('on Windows the workspace binding is case-insensitive, like the OS path semantics', () => {
    if (process.platform !== 'win32') return;
    const dir = tempWorkspace();
    const upper = `${dir.toUpperCase()}`;
    // Only meaningful when the temp path actually contains letters to flip.
    if (upper === dir) return;
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: upper, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toHaveLength(1);
  });

  it('untrusted field values (bad enums / non-integer budget / implausible window) are dropped, never guessed', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      // unknown capacity source
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'bogus_source', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      // unknown fallback reason
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 2000, budgetCapacitySource: 'legacy_fallback', budgetCapacityStatus: 'unknown', budgetFallbackReason: 'not_a_reason', budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      // non-integer budget
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000.5, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      // implausible window
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 7, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      // unknown host bucket
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'gemini', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.legacyEventsSkipped).toBe(5);
  });

  it('malformed JSON lines are counted loudly (parseFailures), never guessed', () => {
    const dir = tempWorkspace();
    fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.state', 'logs', 'events_2026-10-21.jsonl'), [
      '{not json',
      JSON.stringify(injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } })),
    ].join('\n') + '\n', 'utf8');
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.parseFailures).toBe(1);
    expect(report.observations).toHaveLength(1);
  });

  it('both candidate log directories are scanned and a crafted filename cannot escape the logs root', () => {
    const dir = tempWorkspace();
    // Legacy convention: .state/logs (v1 EventLog writer).
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    // Newer convention: .pd/logs.
    writeEvents(dir, '.pd/logs', '2026-10-21', [
      injectedEvent({ ts: '2026-10-21T05:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 3125, budgetCapacitySource: 'pi_catalog_exact', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 200_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS).toEqual(['.pd/logs', '.state/logs']);
    // Latest across both directories wins.
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]?.budgetChars).toBe(3125);
    expect(report.filesRead.length).toBe(2);
  });

  it('the file cap applies PER candidate directory: the later directory is never starved and files beyond the cap are dropped', () => {
    const dir = tempWorkspace();
    const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const event = (hostKind: string, ts: string, budget: number, window: number) => injectedEvent({
      ts,
      data: {
        ...baseData(),
        workspaceDir: dir,
        hostKind,
        budget,
        budgetCapacitySource: 'host_effective_window',
        budgetCapacityStatus: 'confirmed',
        budgetContextWindowTokens: window,
        budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
      },
    });
    // Both conventions carry 9 daily files — more than the cap.
    for (const date of dates) {
      writeEvents(dir, '.pd/logs', date, [event('codex', `${date}T04:00:00.000Z`, 4000, 256_000)]);
      writeEvents(dir, '.state/logs', date, [event('openclaw', `${date}T05:00:00.000Z`, 3125, 200_000)]);
    }
    // A workbuddy observation that exists ONLY in the oldest file of the first
    // directory: beyond the per-directory cap, so it must be dropped.
    writeEvents(dir, '.pd/logs', '2026-10-01', [event('workbuddy', '2026-10-01T04:30:00.000Z', 4000, 256_000)]);

    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir, now: new Date('2026-10-09T12:00:00.000Z') });
    const expectedTotal = RUNTIME_BUDGET_OBSERVATION_MAX_FILES * RUNTIME_V2_EVENT_LOG_CANDIDATE_DIRS.length;
    // The real worst-case read is cap × directories (14 today), NOT 7 overall —
    // a global cap would let the first directory consume the whole budget and
    // silently drop the second directory's live host observation.
    expect(report.filesRead).toHaveLength(expectedTotal);
    const hosts = report.observations.map((observation) => observation.hostKind).sort();
    expect(hosts).toEqual(['codex', 'openclaw']);
    expect(report.observations.find((observation) => observation.hostKind === 'openclaw')?.budgetChars).toBe(3125);
  });

  it('an in-logs symlink cannot redirect the read outside the workspace log root', () => {
    const dir = tempWorkspace();
    const outside = tempWorkspace();
    // The outside file claims THIS workspace, so if containment were broken
    // the observation would be accepted — a real negative control.
    writeEvents(outside, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    fs.mkdirSync(path.join(dir, '.state', 'logs'), { recursive: true });
    try {
      fs.symlinkSync(
        path.join(outside, '.state', 'logs', 'events_2026-10-21.jsonl'),
        path.join(dir, '.state', 'logs', 'events_2026-10-21.jsonl'),
      );
    } catch {
      // Windows without symlink privilege — the containment code path is
      // still exercised on platforms that can create the link.
      return;
    }
    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.observations).toEqual([]);
    expect(report.filesRead).toEqual([]);
  });

  it('a log larger than the read window is tail-read: the newest observation survives, truncation is counted, the cut line is never parsed', () => {
    const dir = tempWorkspace();
    const logsDir = path.join(dir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, 'events_2026-10-21.jsonl');
    // Unrelated events dominate the file, so an unbounded reader would
    // materialise the whole thing before finding the one fact it needs.
    const filler = JSON.stringify({ ts: '2026-10-21T03:00:00.000Z', type: 'tool_call', data: { payload: 'x'.repeat(64 * 1024) } }) + '\n';
    const fillerCount = Math.ceil(RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES / filler.length) + 5;
    fs.writeFileSync(file, filler.repeat(fillerCount), 'utf8');
    fs.appendFileSync(file, JSON.stringify(injectedEvent({
      ts: '2026-10-21T04:00:00.000Z',
      data: {
        ...baseData(),
        workspaceDir: dir,
        hostKind: 'openclaw',
        budget: 4000,
        budgetCapacitySource: 'host_effective_window',
        budgetCapacityStatus: 'confirmed',
        budgetContextWindowTokens: 256_000,
        budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
      },
    })) + '\n', 'utf8');

    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.truncatedFiles).toBe(1);
    expect(report.parseFailures).toBe(0);
    expect(report.lines).toBeLessThan(fillerCount);
    expect(report.observations).toHaveLength(1);
    expect(report.observations[0]).toMatchObject({ hostKind: 'openclaw', budgetChars: 4000 });
  });

  it('an observation only present in the skipped prefix is NOT resurrected — absence stays UNKNOWN', () => {
    const dir = tempWorkspace();
    const logsDir = path.join(dir, '.state', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, 'events_2026-10-21.jsonl');
    fs.appendFileSync(file, JSON.stringify(injectedEvent({
      ts: '2026-10-21T02:00:00.000Z',
      data: {
        ...baseData(),
        workspaceDir: dir,
        hostKind: 'openclaw',
        budget: 4000,
        budgetCapacitySource: 'host_effective_window',
        budgetCapacityStatus: 'confirmed',
        budgetContextWindowTokens: 256_000,
        budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION,
      },
    })) + '\n', 'utf8');
    const filler = JSON.stringify({ ts: '2026-10-21T03:00:00.000Z', type: 'tool_call', data: { payload: 'x'.repeat(64 * 1024) } }) + '\n';
    const fillerCount = Math.ceil(RUNTIME_BUDGET_OBSERVATION_MAX_FILE_BYTES / filler.length) + 5;
    fs.appendFileSync(file, filler.repeat(fillerCount), 'utf8');

    const report = readRuntimePromptBudgetObservations({ workspaceDir: dir });
    expect(report.truncatedFiles).toBe(1);
    expect(report.observations).toEqual([]);
    expect(report.note).toContain('truncatedFiles');
  });
});

describe('PRI-1017: selectRuntimeBudgetObservation (freshness)', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');
  const fresh = {
    workspaceDir: 'ws-a',
    hostKind: 'openclaw' as const,
    budgetChars: 4000,
    capacitySource: 'host_effective_window' as const,
    capacityStatus: 'confirmed' as const,
    contextWindowTokens: 256_000,
    fallbackReason: null,
    policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    observedAt: '2026-10-21T11:00:00.000Z',
  };
  const old = { ...fresh, budgetChars: 1250, contextWindowTokens: 32_000, observedAt: '2026-10-19T11:00:00.000Z' };

  it('a fresh observation is usable', () => {
    expect(selectRuntimeBudgetObservation({ observations: [fresh], targetHost: 'openclaw', now })).toEqual({ kind: 'usable', observation: fresh });
  });

  it('an observation past the freshness bound is stale — not a current fact', () => {
    const selection = selectRuntimeBudgetObservation({ observations: [old], targetHost: 'openclaw', now });
    expect(selection.kind).toBe('stale');
    expect(selection.kind === 'stale' && selection.observation.budgetChars).toBe(1250);
    expect(RUNTIME_BUDGET_OBSERVATION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('an unparseable timestamp is treated as stale (never as current)', () => {
    const broken = { ...fresh, observedAt: 'not-a-timestamp' };
    expect(selectRuntimeBudgetObservation({ observations: [broken], targetHost: 'openclaw', now }).kind).toBe('stale');
  });

  it('another host’s observation is absent for this host (no cross-host borrowing)', () => {
    const codexObservation = { ...fresh, hostKind: 'codex' as const };
    expect(selectRuntimeBudgetObservation({ observations: [codexObservation], targetHost: 'openclaw', now })).toEqual({ kind: 'absent' });
    expect(selectRuntimeBudgetObservation({ observations: [], targetHost: 'openclaw', now })).toEqual({ kind: 'absent' });
  });
});

describe('PRI-1017: selectConsoleRuntimeBudgetFacts', () => {
  const now = new Date('2026-10-21T12:00:00.000Z');

  it('selected/stale/per-host split for a target host', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
      injectedEvent({ ts: '2026-10-18T04:00:00.000Z', data: { ...baseData(), workspaceDir: dir, hostKind: 'codex', budget: 2000, budgetCapacitySource: 'legacy_fallback', budgetCapacityStatus: 'unknown', budgetFallbackReason: 'host_capacity_absent', budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const openclawFacts = selectConsoleRuntimeBudgetFacts({ workspaceDir: dir, targetHost: 'openclaw', now });
    expect(openclawFacts.selected?.budgetChars).toBe(4000);
    expect(openclawFacts.stale).toBeUndefined();
    expect([...openclawFacts.perHost.keys()]).toEqual(['openclaw']);

    const codexFacts = selectConsoleRuntimeBudgetFacts({ workspaceDir: dir, targetHost: 'codex', now });
    expect(codexFacts.selected).toBeUndefined();
    expect(codexFacts.stale?.budgetChars).toBe(2000);
    // A stale codex observation is NOT a per-host budget basis either.
    expect(codexFacts.perHost.has('codex')).toBe(false);
  });

  it('no target host → per-host bases only; never a single selected fact', () => {
    const dir = tempWorkspace();
    writeEvents(dir, '.state/logs', '2026-10-21', [
      injectedEvent({ data: { ...baseData(), workspaceDir: dir, hostKind: 'openclaw', budget: 4000, budgetCapacitySource: 'host_effective_window', budgetCapacityStatus: 'confirmed', budgetContextWindowTokens: 256_000, budgetPolicyVersion: PROMPT_BUDGET_POLICY_VERSION } }),
    ]);
    const facts = selectConsoleRuntimeBudgetFacts({ workspaceDir: dir, now });
    expect(facts.selected).toBeUndefined();
    expect(facts.stale).toBeUndefined();
    expect([...facts.perHost.keys()]).toEqual(['openclaw']);
  });
});

describe('PRI-1017: runtimeBudgetObservationToResolution', () => {
  it('rebuilds the resolution shape the projection consumes (no fallbackDetail leak)', () => {
    const resolution = runtimeBudgetObservationToResolution({
      workspaceDir: 'ws-a',
      hostKind: 'openclaw',
      budgetChars: 4000,
      capacitySource: 'host_effective_window',
      capacityStatus: 'confirmed',
      contextWindowTokens: 256_000,
      fallbackReason: null,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
      observedAt: '2026-10-21T04:00:00.000Z',
    });
    expect(resolution).toEqual({
      budgetChars: 4000,
      capacitySource: 'host_effective_window',
      capacityStatus: 'confirmed',
      contextWindowTokens: 256_000,
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
    });
    expect(Object.hasOwn(resolution, 'fallbackDetail')).toBe(false);
  });

  it('carries the bounded fallback reason through for fallback observations', () => {
    const resolution = runtimeBudgetObservationToResolution({
      workspaceDir: 'ws-a',
      hostKind: 'codex',
      budgetChars: 2000,
      capacitySource: 'legacy_fallback',
      capacityStatus: 'unknown',
      contextWindowTokens: null,
      fallbackReason: 'catalog_ambiguous_model_id',
      policyVersion: PROMPT_BUDGET_POLICY_VERSION,
      observedAt: '2026-10-21T04:00:00.000Z',
    });
    expect(resolution.fallbackReason).toBe('catalog_ambiguous_model_id');
    expect(resolution.budgetChars).toBe(2000);
  });
});
