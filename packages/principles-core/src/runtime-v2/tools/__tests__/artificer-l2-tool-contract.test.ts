/**
 * PRI-439 Phase 4 — artificer-l2-tool-contract unit tests.
 *
 * Verifies the 4 Artificer L2 tool definitions, the whitelist, and the
 * submit_rulecode capture + validator behavior. Pure — uses in-memory fakes,
 * no I/O, no real LLM calls.
 *
 * ERR checklist:
 *   - EP-01 Trust Boundary: submit_rulecode validates params via the injected
 *     validator before storing (Runtime Contract Rule 1/2).
 *   - EP-03 Fail Loud: validate_rulecode and replay_rulecode surface specific
 *     violations, never silent empty results (Runtime Contract Rule 9).
 */
import { describe, it, expect } from 'vitest';
import {
  buildArtificerL2Tools,
  ARTIFICER_L2_TOOL_WHITELIST,
  RULECODE_SPEC_TEXT,
  type ArtificerL2ToolContext,
  type ArtificerL2OutputCapture,
} from '../artificer-l2-tool-contract.js';
import type { RefinerRuleHostGateDeps } from '../../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult } from '../../internalization/refiner-sandbox-wrapper.js';
import type { ArtificerRuleOutput } from '../../internalization/artificer-output.js';
import { DefaultArtificerValidator } from '../../internalization/artificer-output.js';

const TASK_ID = 'task-artificer-l2-001';

/** A valid ArtificerRuleOutput the model might submit. */
function makeRuleOutput(overrides: Partial<ArtificerRuleOutput> = {}): ArtificerRuleOutput {
  return {
    taskId: TASK_ID,
    sourceScribeArtifactId: 'pi-art-scribe-001',
    implementationCode: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
    goldenTraceCases: [
      { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
      { caseId: 'positive-1', kind: 'positive', toolName: 'read', params: { path: '/tmp/y' }, expectedDecision: 'allow' },
    ],
    affectedTools: ['edit'],
    implementationSummary: 'Block writes to system dirs',
    risks: [],
    sourceTrace: { scribeArtifactId: 'pi-art-scribe-001' },
    generatedAt: '2026-06-17T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a gateDeps whose sandbox always accepts (replay passes). */
function makeAlwaysPassGateDeps(): RefinerRuleHostGateDeps {
  const passingResult: RefinerSandboxResult = {
    success: true,
    failedCases: [],
    executionTimeMs: 1,
    forbiddenPatternViolations: [],
  };
  return {
    evaluateInSandbox: (_code, _trace, _opts) => passingResult,
  };
}

/** Build a gateDeps whose sandbox always fails with the given result. */
function makeFailingGateDeps(result: RefinerSandboxResult): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: (_code, _trace, _opts) => result,
  };
}

function makeContext(overrides: Partial<ArtificerL2ToolContext> = {}): ArtificerL2ToolContext {
  const outputCapture: ArtificerL2OutputCapture = { output: null };
  return {
    gateDeps: makeAlwaysPassGateDeps(),
    validator: new DefaultArtificerValidator(),
    taskId: TASK_ID,
    outputCapture,
    ...overrides,
  };
}

/** Type-safe text extraction from a tool result's content. */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  const textPart = result.content.find((c) => c.type === 'text');
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('expected a text content part in tool result');
  }
  return textPart.text;
}

/** Find a tool by name. */
function findTool(tools: ReturnType<typeof buildArtificerL2Tools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`tool '${name}' not found in built tool set`);
  }
  return tool;
}

describe('PRI-439 buildArtificerL2Tools — tool set shape', () => {
  it('builds exactly four tools', () => {
    const tools = buildArtificerL2Tools(makeContext());
    expect(tools).toHaveLength(4);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['read_rulecode_spec', 'replay_rulecode', 'submit_rulecode', 'validate_rulecode']);
  });

  it('every tool has a typebox parameter schema, non-empty description, and execute function', () => {
    const tools = buildArtificerL2Tools(makeContext());
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTypeOf('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('the whitelist contains exactly the four tool names', () => {
    expect(ARTIFICER_L2_TOOL_WHITELIST.size).toBe(4);
    expect(ARTIFICER_L2_TOOL_WHITELIST.has('read_rulecode_spec')).toBe(true);
    expect(ARTIFICER_L2_TOOL_WHITELIST.has('validate_rulecode')).toBe(true);
    expect(ARTIFICER_L2_TOOL_WHITELIST.has('replay_rulecode')).toBe(true);
    expect(ARTIFICER_L2_TOOL_WHITELIST.has('submit_rulecode')).toBe(true);
  });
});

describe('PRI-439 read_rulecode_spec tool', () => {
  it('returns the RuleCode dialect spec text', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'read_rulecode_spec');
    const result = await tool.execute('call-1', {});
    const text = resultText(result);
    // Spec must mention the canonical form, forbidden patterns, and matched=false rule.
    expect(text).toContain('function evaluate(input, helpers)');
    expect(text).toContain('FORBIDDEN PATTERNS');
    expect(text).toContain('require');
    expect(text).toContain('export');
    expect(text).toContain('MATCHED=FALSE RULE');
    expect(text).toContain('GOLDEN TRACE CASES');
  });

  it('emits telemetry on success', async () => {
    const calls: { toolName: string; ok: boolean }[] = [];
    const ctx = makeContext({
      onToolExecution: (info) => calls.push({ toolName: info.toolName, ok: info.ok }),
    });
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'read_rulecode_spec');
    await tool.execute('call-1', {});
    expect(calls).toEqual([{ toolName: 'read_rulecode_spec', ok: true }]);
  });
});

describe('PRI-439 validate_rulecode tool', () => {
  it('returns VALID for clean code', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'validate_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', { code });
    const text = resultText(result);
    expect(text).toContain('VALID');
  });

  it('returns INVALID for code with forbidden pattern (require)', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'validate_rulecode');
    const code = 'function evaluate(input, helpers) { require("fs"); return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', { code });
    const text = resultText(result);
    expect(text).toContain('INVALID');
    expect(text).toContain('require');
  });

  it('returns INVALID for code with export keyword', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'validate_rulecode');
    const code = 'export function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', { code });
    const text = resultText(result);
    expect(text).toContain('INVALID');
    expect(text).toContain('export');
  });

  it('returns INVALID for return statement missing required fields', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'validate_rulecode');
    const code = 'function evaluate(input, helpers) { return { matched: false }; }';
    const result = await tool.execute('call-1', { code });
    const text = resultText(result);
    expect(text).toContain('INVALID');
    expect(text).toContain('decision');
  });

  it('returns INVALID for matched=false with decision=block', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'validate_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "block", matched: false, reason: "x" }; }';
    const result = await tool.execute('call-1', { code });
    const text = resultText(result);
    expect(text).toContain('INVALID');
    expect(text).toContain('matched=false');
  });
});

describe('PRI-439 replay_rulecode tool', () => {
  it('returns PASSED when sandbox accepts', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'replay_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', {
      code,
      goldenTraceCases: makeRuleOutput().goldenTraceCases,
    });
    const text = resultText(result);
    expect(text).toContain('PASSED');
  });

  it('returns FAILED when sandbox rejects with runtime_error', async () => {
    const failingResult: RefinerSandboxResult = {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'runtime_error', message: 'TypeError: x is undefined' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const ctx = makeContext({ gateDeps: makeFailingGateDeps(failingResult) });
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'replay_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', {
      code,
      goldenTraceCases: makeRuleOutput().goldenTraceCases,
    });
    const text = resultText(result);
    expect(text).toContain('FAILED');
    expect(text).toContain('TypeError: x is undefined');
  });

  it('returns FAILED when sandbox detects forbidden pattern', async () => {
    const failingResult: RefinerSandboxResult = {
      success: false,
      failedCases: [{ caseId: '__sandbox__', errorType: 'forbidden_pattern', message: 'require() detected' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: ['require'],
    };
    const ctx = makeContext({ gateDeps: makeFailingGateDeps(failingResult) });
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'replay_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', {
      code,
      goldenTraceCases: makeRuleOutput().goldenTraceCases,
    });
    const text = resultText(result);
    expect(text).toContain('FAILED');
    expect(text).toContain('require');
  });

  it('returns FAILED when golden trace build fails (only 1 case)', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'replay_rulecode');
    const code = 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }';
    const result = await tool.execute('call-1', {
      code,
      goldenTraceCases: [
        { caseId: 'negative-1', kind: 'negative', toolName: 'edit', params: { path: '/etc/x' }, expectedDecision: 'block' },
      ],
    });
    const text = resultText(result);
    expect(text).toContain('FAILED');
    expect(text).toContain('golden trace build failed');
  });

  it('emits telemetry with ok=true on pass and ok=false on fail', async () => {
    const calls: { toolName: string; ok: boolean }[] = [];
    const failingResult: RefinerSandboxResult = {
      success: false,
      failedCases: [{ caseId: 'negative-1', errorType: 'runtime_error', message: 'err' }],
      executionTimeMs: 1,
      forbiddenPatternViolations: [],
    };
    const ctx = makeContext({
      gateDeps: makeFailingGateDeps(failingResult),
      onToolExecution: (info) => calls.push({ toolName: info.toolName, ok: info.ok }),
    });
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'replay_rulecode');
    await tool.execute('call-1', {
      code: 'function evaluate(input, helpers) { return { decision: "allow", matched: false, reason: "ok" }; }',
      goldenTraceCases: makeRuleOutput().goldenTraceCases,
    });
    expect(calls).toEqual([{ toolName: 'replay_rulecode', ok: false }]);
  });
});

describe('PRI-439 submit_rulecode tool', () => {
  it('stores the output in outputCapture when validation passes', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'submit_rulecode');
    const output = makeRuleOutput();
    const result = await tool.execute('call-1', output);
    const text = resultText(result);
    expect(text).toContain('submitted');
    expect(ctx.outputCapture.output).toEqual(output);
  });

  it('returns terminate=true hint on successful submit', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'submit_rulecode');
    const result = await tool.execute('call-1', makeRuleOutput());
    expect(result.terminate).toBe(true);
  });

  it('REJECTS and does NOT store when validator fails (missing affectedTools)', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'submit_rulecode');
    const bad = makeRuleOutput() as unknown as Record<string, unknown>;
    delete bad.affectedTools;
    const result = await tool.execute('call-1', bad);
    const text = resultText(result);
    expect(text).toContain('REJECTED');
    expect(ctx.outputCapture.output).toBeNull();
  });

  it('REJECTS and does NOT store when taskId mismatches', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'submit_rulecode');
    const bad = makeRuleOutput({ taskId: 'wrong-task-id' });
    const result = await tool.execute('call-1', bad);
    const text = resultText(result);
    expect(text).toContain('REJECTED');
    expect(ctx.outputCapture.output).toBeNull();
  });

  it('emits telemetry with ok=false on validator rejection', async () => {
    const calls: { toolName: string; ok: boolean }[] = [];
    const ctx = makeContext({
      onToolExecution: (info) => calls.push({ toolName: info.toolName, ok: info.ok }),
    });
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'submit_rulecode');
    const bad = makeRuleOutput() as unknown as Record<string, unknown>;
    delete bad.affectedTools;
    await tool.execute('call-1', bad);
    expect(calls).toEqual([{ toolName: 'submit_rulecode', ok: false }]);
  });
});

// ── PRI-484 Phase 5: RULECODE_SPEC_TEXT v2 context section ─────────────────

describe('PRI-484 RULECODE_SPEC_TEXT — v2 context section', () => {
  it('contains input.context field description', () => {
    expect(RULECODE_SPEC_TEXT).toContain('input.context');
  });

  it('contains context.version field', () => {
    expect(RULECODE_SPEC_TEXT).toContain('context.version');
  });

  it('contains context.history.status field', () => {
    expect(RULECODE_SPEC_TEXT).toContain('context.history.status');
  });

  it('contains context.facts field', () => {
    expect(RULECODE_SPEC_TEXT).toContain('context.facts');
  });

  it('documents the unavailable must-allow rule', () => {
    expect(RULECODE_SPEC_TEXT).toContain('unavailable');
    expect(RULECODE_SPEC_TEXT).toMatch(/must.*allow/i);
  });

  it('documents requiresContextVersion', () => {
    expect(RULECODE_SPEC_TEXT).toContain('requiresContextVersion');
  });

  it('documents that empty calls array must not be inferred as "not done"', () => {
    expect(RULECODE_SPEC_TEXT).toMatch(/empty.*array|not.*done|not.*infer/i);
  });

  it('documents preference for canonicalKind and facts over raw calls', () => {
    expect(RULECODE_SPEC_TEXT).toContain('canonicalKind');
    expect(RULECODE_SPEC_TEXT).toContain('facts');
  });

  it('read_rulecode_spec tool returns text containing v2 context section', async () => {
    const ctx = makeContext();
    const tools = buildArtificerL2Tools(ctx);
    const tool = findTool(tools, 'read_rulecode_spec');
    const result = await tool.execute('call-1', {});
    const text = resultText(result);
    expect(text).toContain('input.context');
    expect(text).toContain('unavailable');
    expect(text).toContain('requiresContextVersion');
  });
});
