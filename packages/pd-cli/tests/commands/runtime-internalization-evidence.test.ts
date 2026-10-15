/**
 * PRI-983 (SPEC-PD-IAER-001 FR-03/FR-06) — `pd runtime internalization
 * evidence` command tests.
 *
 * Two layers, both through public seams:
 *
 *  1. Parser-level registration (cli-7 / EP-04): the REAL Commander tree built
 *     by registerRuntimeInternalizationEvidenceCommand — flag parsing,
 *     required options, variadic --positive, default-dry-run semantics
 *     (--confirm absent → undefined), subcommand wiring.
 *
 *  2. Handler behavior against a REAL temp-workspace SQLite store: dry-run
 *     writes nothing, --confirm persists through the core service (T05 cycle
 *     through the CLI entry), refusals exit 1 with reason + nextAction
 *     (cli-2/cli-5/cli-6), --json prints exactly one JSON object (cli-1).
 *     Only the plugin assembler module is doubled (vi.mock) — the state
 *     layer, CAS and audit are the production paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
  hydratePITaskRecord,
  createOwnerEvidenceScopeError,
  type BehaviorExamplePack,
} from '@principles/core/runtime-v2';
import {
  handleRuntimeInternalizationEvidenceAttach,
  handleRuntimeInternalizationEvidenceList,
  handleRuntimeInternalizationEvidenceResume,
  registerRuntimeInternalizationEvidenceCommand,
} from '../../src/commands/runtime-internalization-evidence.js';
import { listOwnerEvidenceActions } from '@principles/core/runtime-v2';

// ── plugin module double ────────────────────────────────────────────────────

const V2_RULE_CONTEXT = {
  version: 2 as const,
  history: { status: 'available' as const, truncated: false, calls: [] },
  facts: { priorReadOfTarget: 'unknown' as const, readCount: 0, writeCount: 0, uniqueWritePathCount: 0, sameActionBlockCount: null },
};

function makePack(outcome: string): BehaviorExamplePack {
  return {
    sourceNegativeCase: {
      caseId: 'negative-1', kind: 'negative', toolName: 'write_file',
      params: { path: '/etc/passwd' }, expectedDecision: 'block', ruleContext: V2_RULE_CONTEXT,
    },
    ownerDesiredOutcome: outcome,
    positiveCounterexamples: [{
      caseId: 'positive-1', kind: 'positive', toolName: 'write_file',
      params: { path: '/project/file.txt' }, expectedDecision: 'allow', ruleContext: V2_RULE_CONTEXT,
    }],
    evidenceRefs: ['pain:pain_001', 'tool_call:42', 'tool_call:7'],
    redactionNotes: [],
  };
}

const hoisted = vi.hoisted(() => ({
  state: {
    pack: null as BehaviorExamplePack | null,
    throwOnError: null as unknown | null,
  },
}));

vi.mock('principles-disciple/rulehost-evidence', () => {
  class StubAssembler {
    assemble(): BehaviorExamplePack {
      if (hoisted.state.throwOnError !== null) {
        throw hoisted.state.throwOnError;
      }
      if (hoisted.state.pack === null) throw new Error('stub pack not configured');
      return hoisted.state.pack;
    }
  }
  return {
    BehaviorExamplePackAssembler: StubAssembler,
    RuleHostEvidenceRegistry: { dispose: vi.fn() },
  };
});

// ── parser-level registration tests (cli-7) ────────────────────────────────

describe('Commander wiring for pd runtime internalization evidence', () => {
  function createProgram() {
    const program = new Command();
    program.exitOverride();
    const captured: Record<string, unknown> = {};
    const calls: string[] = [];
    const runtimeCmd = program.command('runtime');
    const internalizationCmd = runtimeCmd.command('internalization');
    registerRuntimeInternalizationEvidenceCommand(internalizationCmd, {
      list: async (opts) => { calls.push('list'); Object.assign(captured, opts); },
      attach: async (opts) => { calls.push('attach'); Object.assign(captured, opts); },
      resume: async (opts) => { calls.push('resume'); Object.assign(captured, opts); },
    });
    return { program, captured, calls };
  }

  it('EVID-CMD-01: routes evidence list and parses --workspace/--json', async () => {
    const { program, calls, captured } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'list', '--workspace', 'D:/tmp/ws', '--json']);
    expect(calls).toEqual(['list']);
    expect(captured.workspace).toBe('D:/tmp/ws');
    expect(captured.json).toBe(true);
  });

  it('EVID-CMD-02: attach parses --negative as number and variadic --positive into an array', async () => {
    const { program, calls, captured } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'attach',
      '--task', 'artificer-1', '--pain', 'pain_001', '--negative', '42', '--positive', '7', '8', '--outcome', 'block writes']);
    expect(calls).toEqual(['attach']);
    expect(captured.task).toBe('artificer-1');
    expect(captured.pain).toBe('pain_001');
    expect(captured.negative).toBe(42);
    expect(captured.positive).toEqual(['7', '8']);
    expect(captured.outcome).toBe('block writes');
    // default dry-run: no --confirm on the line → undefined
    expect(captured.confirm).toBeUndefined();
  });

  it('EVID-CMD-03: attach --confirm and --decidedBy parse', async () => {
    const { program, captured } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'attach',
      '--task', 'a', '--pain', 'p', '--negative', '1', '--positive', '2', '--outcome', 'o', '--confirm', '--decidedBy', 'martin']);
    expect(captured.confirm).toBe(true);
    expect(captured.decidedBy).toBe('martin');
  });

  it('EVID-CMD-04: missing required attach options → parse error (exit override)', async () => {
    const { program } = createProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'attach', '--task', 'a']),
    ).rejects.toThrow();
  });

  it('EVID-CMD-05: resume parses --task/--confirm; default dry-run', async () => {
    const { program, calls, captured } = createProgram();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'resume', '--task', 'art-9']);
    expect(calls).toEqual(['resume']);
    expect(captured.task).toBe('art-9');
    expect(captured.confirm).toBeUndefined();
    await program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'resume', '--task', 'art-9', '--confirm']);
    expect(captured.confirm).toBe(true);
  });

  it('EVID-CMD-06: missing --task on resume → parse error', async () => {
    const { program } = createProgram();
    await expect(
      program.parseAsync(['node', 'pd', 'runtime', 'internalization', 'evidence', 'resume']),
    ).rejects.toThrow();
  });
});

// ── handler behavior against a real temp workspace ──────────────────────────

const TASK_ID = 'artificer-evidence-cli-001';
const dirs: string[] = [];

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-evidence-cli-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  return root;
}

async function seedEvidenceNhrTask(workspaceDir: string): Promise<void> {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    // Real chain: only the Dreamer seed owns the canonical Pain.
    const dreamerSeed = createPITaskDiagnosticJson({
      dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 300_000,
      inputArtifactRefs: [], outputArtifactRefs: [],
    });
    await handle.stateManager.createTask({
      taskId: 'dreamer-evidence-cli-seed', taskKind: 'dreamer',
      status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        ...JSON.parse(dreamerSeed) as Record<string, unknown>,
        sourcePainId: 'pain_001',
      }),
    });
    await handle.stateManager.createTask({
      taskId: 'scribe-evidence-cli-seed', taskKind: 'scribe',
      status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: ['dreamer-evidence-cli-seed'],
        parentTaskId: 'dreamer-evidence-cli-seed',
        channel: 'code_tool_hook', timeoutMs: 300_000,
        inputArtifactRefs: [], outputArtifactRefs: [],
      }),
    });
    await handle.stateManager.createTask({
      taskId: TASK_ID,
      taskKind: 'artificer',
      status: 'needs_human_review',
      attemptCount: 2,
      maxAttempts: 3,
      diagnosticJson: createPITaskDiagnosticJson({
        dependencyTaskIds: ['scribe-evidence-cli-seed'],
        parentTaskId: 'scribe-evidence-cli-seed',
        channel: 'code_tool_hook',
        timeoutMs: 300_000,
        inputArtifactRefs: [],
        outputArtifactRefs: [],
        humanReviewContext: {
          reasonCode: 'owner_behavior_examples_required',
          sourceRunId: 'evidence-preflight',
          revisionEpoch: 0,
          detail: 'preflight block',
          createdAt: new Date().toISOString(),
        },
      }),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTask(workspaceDir: string) {
  const handle = await createRuntimeStateHandle({ workspaceDir, readonly: false });
  try {
    const task = await handle.stateManager.getTask(TASK_ID);
    return { task, piTask: task ? hydratePITaskRecord(task) : null };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function captureStdioJson(): { stdout: string[]; restore: () => void } {
  const stdout: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(' '));
  });
  return {
    stdout,
    restore: () => spy.mockRestore(),
  };
}

beforeEach(() => {
  // process.exitCode leaks across tests in a file — each test asserts it explicitly.
  process.exitCode = undefined;
  hoisted.state.pack = makePack('block writes outside the workspace');
  hoisted.state.throwOnError = null;
});

afterEach(async () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    if (lastError !== null) throw new Error(`cleanup failed on ${dir}: ${String(lastError).slice(0, 120)}`);
  }
});

describe('handleRuntimeInternalizationEvidenceList', () => {
  it('lists a waiting task in --json mode (single object, exit 0)', async () => {
    const ws = makeWorkspace();
    await seedEvidenceNhrTask(ws);
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceList({ workspace: ws, json: true });
      expect(process.exitCode).toBeUndefined();
      const objects = cap.stdout.join('\n').trim();
      const parsed = JSON.parse(objects) as { status: string; count: number; tasks: Array<{ taskId: string; reasonCode: string; nextAction: string }> };
      expect(parsed.status).toBe('complete');
      expect(parsed.count).toBe(1);
      expect(parsed.tasks[0].taskId).toBe(TASK_ID);
      expect(parsed.tasks[0].reasonCode).toBe('owner_behavior_examples_required');
      expect(parsed.tasks[0].nextAction).toContain('evidence attach');
    } finally {
      cap.restore();
    }
  });

  it('refuses an uninitialized workspace with exit 1 (no bootstrap)', async () => {
    const ws = makeWorkspace();
    fs.rmSync(path.join(ws, '.pd'), { recursive: true, force: true });
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceList({ workspace: ws, json: true });
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; reason: string };
      expect(parsed.status).toBe('failed');
      expect(parsed.reason).toBe('workspace_not_initialized');
      expect(fs.existsSync(path.join(ws, '.pd', 'state.db'))).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

describe('handleRuntimeInternalizationEvidenceAttach', () => {
  const baseOpts = {
    task: TASK_ID,
    pain: 'pain_001',
    negative: 42,
    positive: ['7'],
    outcome: 'block writes outside the workspace',
  };

  it('dry-run: reports wouldPersist, writes NOTHING, exit 0', async () => {
    const ws = makeWorkspace();
    await seedEvidenceNhrTask(ws);
    const before = await readTask(ws);
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceAttach({ ...baseOpts, workspace: ws, json: true });
      expect(process.exitCode).toBeUndefined();
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; wouldPersist: { revision: number; contentDigest: string } };
      expect(parsed.status).toBe('dry_run');
      expect(parsed.wouldPersist.revision).toBe(1);
      expect(parsed.wouldPersist.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      const after = await readTask(ws);
      expect(after.task?.diagnosticJson).toBe(before.task?.diagnosticJson);
      expect(listOwnerEvidenceActions(ws)).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  it('--confirm: persists the selection; task STAYS needs_human_review; audit written; exit 0', async () => {
    const ws = makeWorkspace();
    await seedEvidenceNhrTask(ws);
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceAttach({ ...baseOpts, workspace: ws, json: true, confirm: true, decidedBy: 'martin' });
      expect(process.exitCode).toBeUndefined();
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; taskStillNeedsHumanReview: boolean; ownerOperation: string };
      expect(parsed.status).toBe('attached');
      expect(parsed.taskStillNeedsHumanReview).toBe(true);
      expect(parsed.ownerOperation).toBe('cli:attach:martin');

      const { task, piTask } = await readTask(ws);
      expect(task?.status).toBe('needs_human_review');
      expect(piTask?.ownerEvidenceSelection?.revision).toBe(1);
      expect(listOwnerEvidenceActions(ws, { taskId: TASK_ID })).toHaveLength(1);
    } finally {
      cap.restore();
    }
  });

  it('invalid --positive ids → refused with exit 1 and zero state change (cli-5)', async () => {
    const ws = makeWorkspace();
    await seedEvidenceNhrTask(ws);
    const before = await readTask(ws);
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceAttach({ ...baseOpts, positive: ['7', '7'], workspace: ws, json: true, confirm: true });
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; reason: string };
      expect(parsed.status).toBe('refused');
      expect(parsed.reason).toBe('invalid_positive_ids');
      expect((await readTask(ws)).task?.diagnosticJson).toBe(before.task?.diagnosticJson);
    } finally {
      cap.restore();
    }
  });
});

describe('handleRuntimeInternalizationEvidenceResume', () => {
  async function attachedWorkspace(): Promise<string> {
    const ws = makeWorkspace();
    await seedEvidenceNhrTask(ws);
    await handleRuntimeInternalizationEvidenceAttach({
      task: TASK_ID, pain: 'pain_001', negative: 42, positive: ['7'],
      outcome: 'block writes outside the workspace', workspace: ws, confirm: true, json: true,
    });
    process.exitCode = undefined;
    return ws;
  }

  it('T05 via CLI: dry-run verified → --confirm resumes → task pending, audit has both records', async () => {
    const ws = await attachedWorkspace();
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceResume({ task: TASK_ID, workspace: ws, json: true });
      expect(process.exitCode).toBeUndefined();
      const dry = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; reasonCode: string; previousAttemptCount: number };
      expect(dry.status).toBe('dry_run');
      expect(dry.reasonCode).toBe('owner_behavior_examples_verified');
      expect(dry.previousAttemptCount).toBe(2);
      cap.stdout.length = 0;

      await handleRuntimeInternalizationEvidenceResume({ task: TASK_ID, workspace: ws, json: true, confirm: true, decidedBy: 'martin' });
      expect(process.exitCode).toBeUndefined();
      const resumed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; newStatus: string };
      expect(resumed.status).toBe('resumed');
      expect(resumed.newStatus).toBe('pending');

      const { task } = await readTask(ws);
      expect(task?.status).toBe('pending');
      const audit = listOwnerEvidenceActions(ws, { taskId: TASK_ID }).map((a) => a.action);
      expect(audit).toEqual(['attach_evidence', 'resume_evidence']);
    } finally {
      cap.restore();
    }
  });

  it('stale trajectory (digest mismatch) → refused owner_behavior_examples_stale with exit 1, zero mutation', async () => {
    const ws = await attachedWorkspace();
    // Trajectory changed since attach: the assembler now yields different content.
    hoisted.state.pack = makePack('block ALL writes everywhere');
    const before = await readTask(ws);
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceResume({ task: TASK_ID, workspace: ws, json: true, confirm: true });
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; reason: string };
      expect(parsed.status).toBe('refused');
      expect(parsed.reason).toBe('owner_behavior_examples_stale');
      expect((await readTask(ws)).task?.diagnosticJson).toBe(before.task?.diagnosticJson);
    } finally {
      cap.restore();
    }
  });

  it('typed scope error from the assembler → refused owner_behavior_examples_scope_mismatch with exit 1', async () => {
    const ws = await attachedWorkspace();
    hoisted.state.throwOnError = createOwnerEvidenceScopeError('session_mismatch', 'selected tool call 7 session mismatch');
    const cap = captureStdioJson();
    try {
      await handleRuntimeInternalizationEvidenceResume({ task: TASK_ID, workspace: ws, json: true, confirm: true });
      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(cap.stdout.join('\n').trim()) as { status: string; reason: string };
      expect(parsed.status).toBe('refused');
      expect(parsed.reason).toBe('owner_behavior_examples_scope_mismatch');
    } finally {
      cap.restore();
    }
  });
});
