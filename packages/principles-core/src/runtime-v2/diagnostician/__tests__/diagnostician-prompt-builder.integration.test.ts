/**
 * DiagnosticianPromptBuilder → OpenClawCliRuntimeAdapter integration tests.
 *
 * Tests the full m6-03 pipeline:
 *   DiagnosticianContextPayload → buildPrompt() → PromptInput JSON
 *   → OpenClawCliRuntimeAdapter.startRun(inputPayload: JSON string)
 *
 * Phase: m6-03
 * Requirements: DPB-01~05, OCRA-06, OCRA-07
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticianPromptBuilder } from '../../diagnostician-prompt-builder.js';
import { OpenClawCliRuntimeAdapter } from '../../adapter/openclaw-cli-runtime-adapter.js';
import type { CliOutput } from '../../utils/cli-process-runner.js';
import type { DiagnosticianContextPayload } from '../../context-payload.js';

// Mock runCliProcess for OpenClawCliRuntimeAdapter
vi.mock('../../utils/cli-process-runner.js', () => ({
  runCliProcess: vi.fn(),
}));

import { runCliProcess } from '../../utils/cli-process-runner.js';

const mockRunCliProcess = runCliProcess as ReturnType<typeof vi.fn>;

const REALISTIC_PAYLOAD: DiagnosticianContextPayload = {
  contextId: 'ctx-integration-1',
  contextHash: 'sha256-abc123def456',
  taskId: 'task-pd-001',
  workspaceDir: 'D:/work/.pd',
  sourceRefs: ['pain://event-123', 'trajectory://traj-456'],
  diagnosisTarget: {
    painId: 'pain-123',
    reasonSummary: 'Agent failed to call get_shit_done planner agent',
    severity: 'high',
    source: 'tool-call-gate',
  },
  conversationWindow: [
    { ts: '2026-04-24T10:00:00Z', role: 'user', text: 'Plan the implementation', toolName: undefined, toolResultSummary: undefined, eventType: undefined },
    { ts: '2026-04-24T10:00:01Z', role: 'assistant', text: 'I will use the planner agent', toolName: undefined, toolResultSummary: undefined, eventType: undefined },
    { ts: '2026-04-24T10:00:02Z', role: 'tool', text: undefined, toolName: 'planner_agent', toolResultSummary: 'Agent not found in registry', eventType: undefined },
  ],
  eventSummaries: [{ eventType: 'tool-call-failure', toolName: 'planner_agent' }],
  ambiguityNotes: ['Multiple failure modes detected — gate rejection vs agent not found'],
};

const VALID_OUTPUT = {
  valid: true,
  diagnosisId: 'diag-pipeline-1',
  taskId: 'task-pd-001',
  summary: 'Agent failed because planner_agent is not in the registry',
  rootCause: 'Tool call gate rejected the request due to missing agent registration',
  violatedPrinciples: [{ principleId: 'use-registered-agents', title: 'Use Registered Agents', rationale: 'Agents must be registered before use' }],
  evidence: [{ sourceRef: 'pain://event-123', note: 'toolName: planner_agent not found' }],
  recommendations: [{ kind: 'principle' as const, description: 'Register planner_agent before attempting to call it' }],
  confidence: 0.92,
};

function makeCliOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    durationMs: 100,
    ...overrides,
  };
}

describe('DiagnosticianPromptBuilder → OpenClawCliRuntimeAdapter pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // DPB-01 + OCRA-02: buildPrompt() output becomes startRun() inputPayload
  it('buildPrompt() message can be passed directly to startRun() as inputPayload', async () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local' });
    mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_OUTPUT) }));

    await adapter.startRun({
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      inputPayload: message, // DPB-01: buildPrompt output becomes startRun input
      contextItems: [],
      timeoutMs: 60000,
    });

    expect(mockRunCliProcess).toHaveBeenCalledTimes(1);
  });

  // DPB-04: taskId appears at top level of the JSON passed to --message
  it('taskId appears at top level of the JSON message (DPB-04)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const parsed = JSON.parse(message);
    expect(parsed.taskId).toBe('task-pd-001');
    expect(parsed.context.taskId).toBe('task-pd-001'); // also in nested context
  });

  // DPB-04: contextHash appears at top level
  it('contextHash appears at top level of the JSON message (DPB-04)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const parsed = JSON.parse(message);
    expect(parsed.contextHash).toBe('sha256-abc123def456');
  });

  // DPB-04: diagnosisTarget appears at top level
  it('diagnosisTarget appears at top level of the JSON message (DPB-04)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const parsed = JSON.parse(message);
    expect(parsed.diagnosisTarget).toEqual(REALISTIC_PAYLOAD.diagnosisTarget);
    expect(parsed.diagnosisTarget.painId).toBe('pain-123');
  });

  // DPB-04: sourceRefs appears at top level
  it('sourceRefs appears at top level of the JSON message (DPB-04)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const parsed = JSON.parse(message);
    expect(parsed.sourceRefs).toEqual(['pain://event-123', 'trajectory://traj-456']);
  });

  // DPB-04: conversationWindow appears at top level
  it('conversationWindow appears at top level of the JSON message (DPB-04)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const parsed = JSON.parse(message);
    expect(parsed.conversationWindow).toEqual(REALISTIC_PAYLOAD.conversationWindow);
    expect(parsed.conversationWindow).toHaveLength(3);
  });

  // OCRA-06: workspaceDir accessible via nested context (not at top level)
  it('workspaceDir is accessible via promptInput.context.workspaceDir (OCRA-06)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { promptInput } = builder.buildPrompt(REALISTIC_PAYLOAD);

    expect(promptInput.context.workspaceDir).toBe('D:/work/.pd');
    // Verify workspaceDir is NOT at top level (reduces exposure)
    expect((promptInput as Record<string, unknown>)).not.toHaveProperty('workspaceDir');
  });

  // OCRA-07: runtimeMode='local' passes --local to CLI
  it('runtimeMode=local passes --local flag to openclaw agent (OCRA-07)', async () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'local', workspaceDir: 'D:/work/.pd' });
    mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_OUTPUT) }));

    await adapter.startRun({
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      inputPayload: message,
      contextItems: [],
      timeoutMs: 60000,
    });

    const call = mockRunCliProcess.mock.calls[0]![0] as { command: string; args: string[]; cwd?: string };
    expect(call.args).toContain('--local');
    expect(call.args).toContain('--message');
    expect(call.cwd).toBe('D:/work/.pd');
  });

  // OCRA-07: runtimeMode='gateway' omits --local (HG-03: no silent fallback)
  it('runtimeMode=gateway omits --local flag (OCRA-07, HG-03)', async () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    const adapter = new OpenClawCliRuntimeAdapter({ runtimeMode: 'gateway', workspaceDir: 'D:/work/.pd' });
    mockRunCliProcess.mockResolvedValue(makeCliOutput({ stdout: JSON.stringify(VALID_OUTPUT) }));

    await adapter.startRun({
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      inputPayload: message,
      contextItems: [],
      timeoutMs: 60000,
    });

    const call = mockRunCliProcess.mock.calls[0]![0] as { command: string; args: string[]; cwd?: string };
    expect(call.args).not.toContain('--local');
    expect(call.cwd).toBe('D:/work/.pd'); // workspaceDir still passed as cwd
  });

  // DPB-02: message is ONLY JSON (no markdown, no tool calls)
  it('message is ONLY JSON — no markdown, no tool calls (DPB-02)', () => {
    const builder = new DiagnosticianPromptBuilder();
    const { message } = builder.buildPrompt(REALISTIC_PAYLOAD);

    // Should be parseable as JSON
    expect(() => JSON.parse(message)).not.toThrow();

    // Should NOT contain markdown indicators
    expect(message).not.toMatch(/```json|```/);
    expect(message).not.toMatch(/\*\*[^*]+\*\*/); // no bold markdown
    expect(message).not.toMatch(/^#+\s/m); // no headings
  });
});