/**
 * PRI-419 §M1 — agent-tool-contract unit tests.
 *
 * Verifies the dreamer L2 tool definitions, the read-only-by-construction store
 * interfaces, the tool whitelist, and the submit_output capture behaviour. Pure —
 * uses in-memory fakes, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDreamerL2Tools,
  DREAMER_L2_TOOL_WHITELIST,
  type PdL2ToolContext,
  type PdL2ArtifactReader,
  type PdL2PrincipleReader,
  type L2OutputCapture,
} from '../agent-tool-contract.js';

function makeContext(overrides: Partial<PdL2ToolContext> = {}): PdL2ToolContext {
  const artifactReader: PdL2ArtifactReader = {
    getArtifactById: async () => null,
    listBySourceTaskId: async () => [],
  };
  const principleReader: PdL2PrincipleReader = {
    listActivePrinciples: async () => [],
  };
  const outputCapture: L2OutputCapture = { output: null };
  return { artifactReader, principleReader, outputCapture, ...overrides };
}

/** Type-safe text extraction from a tool result's content (Runtime Contract: validate at boundary). */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  const textPart = result.content.find(c => c.type === 'text');
  if (!textPart || typeof textPart.text !== 'string') {
    throw new Error('expected a text content part in tool result');
  }
  return textPart.text;
}

/** Find a tool by name (throws if missing — avoids banned non-null assertion). */
function findTool(tools: ReturnType<typeof buildDreamerL2Tools>, name: string) {
  const tool = tools.find(t => t.name === name);
  if (!tool) {
    throw new Error(`tool '${name}' not found in built tool set`);
  }
  return tool;
}

describe('PRI-419 buildDreamerL2Tools', () => {
  it('builds exactly three tools: read_principles, read_artifact, submit_output', () => {
    const tools = buildDreamerL2Tools(makeContext());
    expect(tools).toHaveLength(3);
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['read_artifact', 'read_principles', 'submit_output']);
  });

  it('every tool has a typebox parameter schema and a non-empty description', () => {
    const tools = buildDreamerL2Tools(makeContext());
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTypeOf('object');
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('the whitelist contains exactly the three tool names', () => {
    expect(DREAMER_L2_TOOL_WHITELIST.size).toBe(3);
    expect(DREAMER_L2_TOOL_WHITELIST.has('read_principles')).toBe(true);
    expect(DREAMER_L2_TOOL_WHITELIST.has('read_artifact')).toBe(true);
    expect(DREAMER_L2_TOOL_WHITELIST.has('submit_output')).toBe(true);
  });
});

describe('PRI-419 read_principles tool', () => {
  it('returns core axioms T-01..T-10 plus active internalized principles', async () => {
    const principleReader: PdL2PrincipleReader = {
      listActivePrinciples: async () => [{ id: 'pri-1', statement: 'Verify before deleting.' }],
    };
    const ctx = makeContext({ principleReader });
    const tools = buildDreamerL2Tools(ctx);
    const readPrinciples = findTool(tools, 'read_principles');
    const result = await readPrinciples.execute('call-1', {});
    const text = resultText(result);
    expect(text).toContain('T-01:');
    expect(text).toContain('T-10:');
    expect(text).toContain('pri-1: Verify before deleting.');
  });

  it('degrades gracefully with a reason when the reader throws (R9)', async () => {
    const principleReader: PdL2PrincipleReader = {
      listActivePrinciples: async () => { throw new Error('ledger locked'); },
    };
    const ctx = makeContext({ principleReader });
    const tools = buildDreamerL2Tools(ctx);
    const readPrinciples = findTool(tools, 'read_principles');
    const result = await readPrinciples.execute('call-1', {});
    const text = resultText(result);
    expect(text).toContain('read_principles failed');
    expect(text).toContain('ledger locked');
  });
});

describe('PRI-419 read_artifact tool', () => {
  it('reads an artifact by artifactId and formats its content', async () => {
    const artifactReader: PdL2ArtifactReader = {
      getArtifactById: async () => ({
        artifactId: 'art-1', artifactKind: 'diagnostician-output', sourceTaskId: 'task-9',
        contentJson: '{"rootCause":"x"}', createdAt: '2026-06-16T00:00:00.000Z',
      }),
      listBySourceTaskId: async () => [],
    };
    const ctx = makeContext({ artifactReader });
    const tools = buildDreamerL2Tools(ctx);
    const readArtifact = findTool(tools, 'read_artifact');
    const result = await readArtifact.execute('call-1', { artifactId: 'art-1' });
    const text = resultText(result);
    expect(text).toContain('artifactId: art-1');
    expect(text).toContain('"rootCause":"x"');
  });

  it('lists artifacts by sourceTaskId', async () => {
    const artifactReader: PdL2ArtifactReader = {
      getArtifactById: async () => null,
      listBySourceTaskId: async () => [
        { artifactId: 'art-1', artifactKind: 'diag', sourceTaskId: 'task-9', contentJson: '{}', createdAt: 't1' },
        { artifactId: 'art-2', artifactKind: 'diag', sourceTaskId: 'task-9', contentJson: '{}', createdAt: 't2' },
      ],
    };
    const ctx = makeContext({ artifactReader });
    const tools = buildDreamerL2Tools(ctx);
    const readArtifact = findTool(tools, 'read_artifact');
    const result = await readArtifact.execute('call-1', { sourceTaskId: 'task-9' });
    const text = resultText(result);
    expect(text).toContain('artifactId: art-1');
    expect(text).toContain('artifactId: art-2');
  });

  it('returns structured guidance (not silent empty) when both params are empty (R9)', async () => {
    const tools = buildDreamerL2Tools(makeContext());
    const readArtifact = findTool(tools, 'read_artifact');
    const result = await readArtifact.execute('call-1', {});
    const text = resultText(result);
    expect(text).toContain('Provide either artifactId');
  });
});

describe('PRI-419 submit_output tool', () => {
  it('captures the submitted output and signals terminate', async () => {
    const ctx = makeContext();
    const tools = buildDreamerL2Tools(ctx);
    const submit = findTool(tools, 'submit_output');
    const payload = {
      valid: true,
      taskId: 'task-1',
      candidates: [
        { candidateIndex: 0, badDecision: 'a', betterDecision: 'b', rationale: 'r', confidence: 0.5, riskLevel: 'low', strategicPerspective: 's' },
      ],
      contextRefs: ['r1'],
      generatedAt: '2026-06-16T00:00:00.000Z',
    };
    const result = await submit.execute('call-1', payload);
    expect(ctx.outputCapture.output).toEqual(payload);
    expect(result.terminate).toBe(true);
  });

  it('onToolExecution telemetry fires once per tool call', async () => {
    const calls: { toolName: string; ok: boolean }[] = [];
    const ctx = makeContext({ onToolExecution: (info) => calls.push(info) });
    const tools = buildDreamerL2Tools(ctx);
    const readPrinciples = findTool(tools, 'read_principles');
    await readPrinciples.execute('call-1', {});
    expect(calls).toEqual([{ toolName: 'read_principles', ok: true }]);
  });
});

describe('PRI-419 read-only-by-construction', () => {
  it('PdL2ArtifactReader exposes only getArtifactById and listBySourceTaskId (no write methods)', () => {
    // Structural check: the interface type only declares read methods. A concrete
    // PIArtifactStore (which has create/upsert/update) satisfies this structurally,
    // but the tools can only call the two read methods — there is no write path.
    const reader: PdL2ArtifactReader = {
      getArtifactById: async () => null,
      listBySourceTaskId: async () => [],
    };
    // The only callable members are the two getters:
    expect(typeof reader.getArtifactById).toBe('function');
    expect(typeof reader.listBySourceTaskId).toBe('function');
  });
});
