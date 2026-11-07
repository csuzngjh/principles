/**
 * PRI-917 v0.3.2 Phase 3C-3 — ReuseEvaluationRunner tests.
 *
 * Drives the runner through a REAL PDRuntimeAdapter surface using a
 * deterministic in-test adapter (no LLM, no network). Pins the contract the
 * review surface depends on (SPEC §9, §11 T3/T7):
 *
 *   T3 failure semantics — timeout, invalid JSON, schema failure, and repair
 *       success are all observable; nothing degrades silently into "no
 *       candidates, therefore create".
 *   T7a — a payload carrying write / persist / reuseEvidence / decision (or
 *       any other unknown key) is rejected by the contract validator and
 *       never becomes a usable recommendation.
 *   Proposal-only — the runner has no ledger path: every scenario asserts the
 *       ledger file is byte-identical before and after.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReuseEvaluationRunner, ReuseEvaluationError } from '../reuse-evaluation-runner.js';
import type { ReuseEvaluationInput } from '../reuse-evaluation-runner.js';
import { addPrincipleToLedger, loadLedger } from '../../../principle-tree-ledger.js';
import type { LedgerPrinciple } from '../../../principle-tree-ledger.js';
import type {
  PDRuntimeAdapter,
  RunHandle,
  RunStatus,
  RuntimeCapabilities,
  RuntimeArtifactRef,
  RuntimeHealth,
  StartRunInput,
  StructuredRunOutput,
} from '../../runtime-protocol.js';

const INPUT: ReuseEvaluationInput = {
  candidate: {
    text: '不要假设系统支持某能力，先确认已有实现入口。',
    triggerPattern: '在依赖某项能力之前',
    action: '先核查已有实现',
  },
  candidates: [
    {
      principleId: 'p-uuid-1',
      text: '修改前确认已有实现入口。',
      triggerPattern: '修改代码前',
      action: '先查找现有实现',
    },
  ],
};

type ScriptedOutcome =
  | { kind: 'payload'; payload: unknown }
  | { kind: 'error'; error: Error };

/**
 * Minimal scripted adapter: each startRun consumes the next scripted outcome.
 * Poll always succeeds unless the outcome is an error, which surfaces as the
 * run failing — exactly how a real adapter reports a runtime fault.
 */
interface ScriptedAdapterOptions {
  /** Force every poll to this status (models a run that stays in flight). */
  pollStatus?: RunStatus['status'];
  /** Make fetchOutput reject (models unparsable output from a real adapter). */
  fetchThrows?: Error;
  /** Make fetchOutput return null (models an empty run). */
  fetchNull?: boolean;
}

class ScriptedAdapter implements PDRuntimeAdapter {
  readonly startedRuns: StartRunInput[] = [];
  private readonly script: ScriptedOutcome[];
  private readonly options: ScriptedAdapterOptions;
  private index = 0;

  constructor(script: ScriptedOutcome[], options: ScriptedAdapterOptions = {}) {
    this.script = script;
    this.options = options;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  kind(): 'test-double' {
    return 'test-double';
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async healthCheck(): Promise<RuntimeHealth> {
    return { healthy: true, degraded: false, warnings: [], lastCheckedAt: '2026-09-29T00:00:00.000Z' };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.startedRuns.push(input);
    return {
      runId: `run-${this.startedRuns.length}`,
      runtimeKind: 'test-double',
      startedAt: '2026-09-29T00:00:00.000Z',
    };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    if (this.options.pollStatus !== undefined) {
      return { runId, status: this.options.pollStatus };
    }
    const outcome = this.script[Math.min(this.index, this.script.length - 1)];
    if (outcome?.kind === 'error') {
      return { runId, status: 'failed', reason: outcome.error.message };
    }
    return { runId, status: 'succeeded' };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput | null> {
    if (this.options.fetchThrows) {
      throw this.options.fetchThrows;
    }
    if (this.options.fetchNull) {
      return null;
    }
    const outcome = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (!outcome || outcome.kind !== 'payload') {
      return null;
    }
    return { runId, payload: outcome.payload };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async cancelRun(runId: string): Promise<void> {
    void runId;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async fetchArtifacts(runId: string): Promise<RuntimeArtifactRef[]> {
    void runId;
    return [];
  }
}

let stateDir: string;
let ledgerPath: string;

function seedLedger(): void {
  const principle: LedgerPrinciple = {
    id: 'p-uuid-1',
    version: 1,
    text: '修改前确认已有实现入口。',
    triggerPattern: '修改代码前',
    action: '先查找现有实现',
    status: 'active',
    priority: 'P1',
    scope: 'general',
    evaluability: 'manual_only',
    valueScore: 0,
    adherenceRate: 0,
    painPreventedCount: 0,
    derivedFromPainIds: ['candidate-src-1'],
    ruleIds: [],
    conflictsWithPrincipleIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  addPrincipleToLedger(stateDir, principle);
  ledgerPath = path.join(stateDir, 'principle_training_state.json');
}

function ledgerBytes(): string {
  return fs.readFileSync(ledgerPath, 'utf8');
}

function runner(adapter: ScriptedAdapter, options: Record<string, number> = {}): ReuseEvaluationRunner {
  return new ReuseEvaluationRunner(
    { runtimeAdapter: adapter },
    { pollIntervalMs: 1, timeoutMs: 200, ...options },
  );
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-reuse-eval-runner-'));
  seedLedger();
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('ReuseEvaluationRunner — happy path returns a validated recommendation', () => {
  it('returns the recommendation verbatim and leaves the ledger untouched', async () => {
    const adapter = new ScriptedAdapter([
      {
        kind: 'payload',
        payload: {
          recommendation: 'reuse',
          selectedPrincipleId: 'p-uuid-1',
          rationale: 'same experience, different wording',
          confidence: 0.82,
        },
      },
    ]);
    const before = ledgerBytes();

    const result = await runner(adapter).recommend(INPUT);

    expect(result).toEqual({
      recommendation: 'reuse',
      selectedPrincipleId: 'p-uuid-1',
      rationale: 'same experience, different wording',
      confidence: 0.82,
    });
    // The run declared the Phase 3C-1 schema ref to the adapter.
    expect(adapter.startedRuns[0]?.outputSchemaRef).toBe('reuse-evaluation-output-v1');
    // T7: proposal-only — the ledger is byte-identical.
    expect(ledgerBytes()).toBe(before);
    expect(loadLedger(stateDir).tree.principles['p-uuid-1']?.reuseEvidence).toBeUndefined();
  });

  it('accepts a create recommendation without selectedPrincipleId', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'payload', payload: { recommendation: 'create', rationale: 'different demand', confidence: 0.3 } },
    ]);
    const result = await runner(adapter).recommend(INPUT);
    expect(result.recommendation).toBe('create');
    expect(result.selectedPrincipleId).toBeUndefined();
  });

  it('includes the shortlist and the "recommend, do not decide" boundary in the prompt', () => {
    const prompt = ReuseEvaluationRunner.buildPrompt(INPUT);
    expect(prompt).toContain('p-uuid-1');
    expect(prompt).toContain('不要假设系统支持某能力');
    expect(ReuseEvaluationRunner.SYSTEM_PROMPT).toContain('NOT a decision maker');
  });
});

describe('T3 — failure semantics are observable, never a silent create', () => {
  it('a failed run surfaces as ReuseEvaluationError(run_failed) and writes nothing', async () => {
    const adapter = new ScriptedAdapter([{ kind: 'error', error: new Error('provider 402') }]);
    const before = ledgerBytes();

    await expect(runner(adapter).recommend(INPUT)).rejects.toMatchObject({
      name: 'ReuseEvaluationError',
      reason: 'run_failed',
    });
    expect(ledgerBytes()).toBe(before);
  });

  it('a run that never reaches a terminal state times out and is cancelled', async () => {
    // Poll always reports 'succeeded' is wrong for this case; a run that stays
    // in-flight is modelled by an error-free adapter whose script is exhausted.
    const stalling = new ScriptedAdapter([{ kind: 'payload', payload: { unreachable: true } }], { pollStatus: 'running' });
    const before = ledgerBytes();

    await expect(runner(stalling, { timeoutMs: 30 }).recommend(INPUT)).rejects.toMatchObject({
      name: 'ReuseEvaluationError',
      reason: 'timeout',
    });
    expect(ledgerBytes()).toBe(before);
  });

  it('an adapter that throws on fetch (invalid JSON / unparsable) surfaces as output_invalid', async () => {
    // The run SUCCEEDS, but fetching throws — this is where a real adapter
    // reports unparsable output (pi-ai repairs internally first, then fails).
    const throwing = new ScriptedAdapter(
      [{ kind: 'payload', payload: { unreachable: true } }],
      { fetchThrows: new Error('no_json_object_found') },
    );
    const before = ledgerBytes();

    await expect(runner(throwing).recommend(INPUT)).rejects.toMatchObject({
      name: 'ReuseEvaluationError',
      reason: 'output_invalid',
    });
    expect(ledgerBytes()).toBe(before);
  });

  it('an empty payload surfaces as output_unavailable', async () => {
    const emptying = new ScriptedAdapter(
      [{ kind: 'payload', payload: { unreachable: true } }],
      { fetchNull: true },
    );
    const before = ledgerBytes();

    await expect(runner(emptying).recommend(INPUT)).rejects.toMatchObject({
      name: 'ReuseEvaluationError',
      reason: 'output_unavailable',
    });
    expect(ledgerBytes()).toBe(before);
  });

  it('a schema-invalid payload that repair cannot fix fails closed (repair_failed)', async () => {
    // First run violates the contract; the repair run returns the same
    // violation, so the runner must give up loudly rather than pass it through.
    const bad = { recommendation: 'reuse', rationale: 'no principle id', confidence: 0.9 };
    const adapter = new ScriptedAdapter([
      { kind: 'payload', payload: bad },
      { kind: 'payload', payload: bad },
    ]);
    const before = ledgerBytes();

    const error = await runner(adapter).recommend(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReuseEvaluationError);
    expect((error as ReuseEvaluationError).reason).toBe('repair_failed');
    expect(ledgerBytes()).toBe(before);
  });

  it('repairs a contract violation through the SAME adapter and returns a valid recommendation', async () => {
    const adapter = new ScriptedAdapter([
      // Run 1: the model used the forbidden `decision` key (T7a case).
      { kind: 'payload', payload: { decision: 'reuse', selectedPrincipleId: 'p-uuid-1', rationale: 'same experience', confidence: 0.8 } },
      // Run 2 (repair): corrected shape.
      { kind: 'payload', payload: { recommendation: 'reuse', selectedPrincipleId: 'p-uuid-1', rationale: 'same experience', confidence: 0.8 } },
    ]);
    const before = ledgerBytes();

    const result = await runner(adapter).recommend(INPUT);

    expect(result.recommendation).toBe('reuse');
    expect(result.selectedPrincipleId).toBe('p-uuid-1');
    // Two runs: initial + exactly one repair round through the same adapter.
    expect(adapter.startedRuns).toHaveLength(2);
    expect(adapter.startedRuns[0]?.outputSchemaRef).toBe('reuse-evaluation-output-v1');
    expect(ledgerBytes()).toBe(before);
  });

  it('maxRepairAttempts: 0 disables repair and fails closed on the first violation', async () => {
    const adapter = new ScriptedAdapter([
      { kind: 'payload', payload: { recommendation: 'reuse', rationale: 'missing id', confidence: 0.9 } },
    ]);
    await expect(runner(adapter, { maxRepairAttempts: 0 }).recommend(INPUT)).rejects.toMatchObject({
      reason: 'repair_failed',
    });
    expect(adapter.startedRuns).toHaveLength(1);
  });
});

describe('T7a — a payload that tries to smuggle persistence is rejected', () => {
  const smuggled: [string, Record<string, unknown>][] = [
    ['write', { recommendation: 'reuse', selectedPrincipleId: 'p-uuid-1', rationale: 'r', confidence: 0.9, write: { principleId: 'other' } }],
    ['persist', { recommendation: 'reuse', selectedPrincipleId: 'p-uuid-1', rationale: 'r', confidence: 0.9, persist: true }],
    ['reuseEvidence', { recommendation: 'reuse', selectedPrincipleId: 'p-uuid-1', rationale: 'r', confidence: 0.9, reuseEvidence: [{ painId: 'p', candidateId: 'c' }] }],
    ['decision', { decision: 'reuse', rationale: 'r', confidence: 0.9 }],
  ];

  it.each(smuggled)('rejects an output carrying "%s" and never treats it as a recommendation', async (key, payload) => {
    // Repair returns the same violation → fail closed.
    const adapter = new ScriptedAdapter([
      { kind: 'payload', payload },
      { kind: 'payload', payload },
    ]);
    const before = ledgerBytes();

    const error = await runner(adapter).recommend(INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReuseEvaluationError);
    expect((error as ReuseEvaluationError).detail ?? '').toContain(`unknown_field:${key}`);
    // T7: nothing about the ledger moved.
    expect(ledgerBytes()).toBe(before);
  });
});
