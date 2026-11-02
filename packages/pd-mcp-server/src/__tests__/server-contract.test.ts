/**
 * Tool contract tests over the real MCP protocol surface (InMemoryTransport
 * linked to a real SDK client) — SPEC-PD-MCP-GATE4-001 §4, Gate 3 v0.5 §10.1.
 *
 * Pins: tool discovery (single tool, honest readOnlyHint, strict input
 * schema), envelope passthrough without isError for ordinary business
 * states, isError ONLY for disclosure/adapter failures, protocol-level
 * rejection of undeclared parameters WITHOUT reaching the capability, and
 * sanitization of unexpected exceptions.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createPdMcpServer, TOOL_NAME } from '../server.js';
import type { PainRecallCapabilityResult } from '@principles/core/runtime-v2/pain-recall-capability';

function envelope(status: PainRecallCapabilityResult['status'], error?: { code: string; message: string }): PainRecallCapabilityResult {
  return {
    schemaVersion: 'pd.capability.v1',
    capability: 'pd_recall_principle_pains',
    disclosureProfile: 'od-a-v1',
    status,
    data: status === 'unavailable' || status === 'invalid_input' ? null : {
      principle: { requestedId: 'p-1', identityStatus: 'resolved' },
      query: { limit: 3, contextUsedForRanking: false, truncated: false },
      results: [],
      summary: { returned: 0, availableCandidates: 0, truncated: false },
      sources: { ledger: 'ok', trajectoryDb: 'ok', stateDb: 'ok' },
      unresolvedAssociations: [],
    },
    provenance: { workspaceBinding: 'configured', sources: [] },
    warnings: [],
    error: error ?? null,
    nextAction: null,
  };
}

interface Harness {
  client: Client;
  calls: { workspaceDir: string; principleId: string; limit: number }[];
  server: McpServer;
}

async function makeHarness(capabilityImpl?: (input: { principleId: string; limit: number; workspaceDir: string }) => Promise<PainRecallCapabilityResult>): Promise<Harness> {
  const calls: Harness['calls'] = [];
  const handle = createPdMcpServer({
    workspaceDir: 'C:\\pd-test-workspace',
    callCapability: async (input) => {
      calls.push(input);
      if (capabilityImpl) return capabilityImpl(input);
      return envelope('ok');
    },
    logSink: () => undefined,
  });
  const client = new Client({ name: 'contract-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), handle.mcpServer.connect(serverTransport)]);
  return { client, calls, server: handle.mcpServer };
}

function textOf(result: CallToolResult): string {
  expect(result.content).toHaveLength(1);
  const [block] = result.content;
  if (block === undefined || block.type !== 'text') throw new Error('expected single text content block');
  return block.text;
}

function soleTool(tools: { tools: unknown[] }): unknown {
  expect(tools.tools).toHaveLength(1);
  const [tool] = tools.tools;
  if (tool === undefined) throw new Error('expected exactly one tool');
  return tool;
}

function parseEnvelope(result: CallToolResult): PainRecallCapabilityResult {
  return JSON.parse(textOf(result)) as PainRecallCapabilityResult;
}

describe('tool discovery (tools/list)', () => {
  it('exposes exactly one tool with the contract name and honest readOnlyHint', async () => {
    const h = await makeHarness();
    const tools = await h.client.listTools();
    const tool = soleTool(tools) as { name: string; annotations?: { readOnlyHint?: boolean }; inputSchema?: unknown };
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema).toBeDefined();
    await h.client.close();
  });

  it('declares the strict input schema (principleId required, limit bounded integer)', async () => {
    const h = await makeHarness();
    const tools = await h.client.listTools();
    const tool = soleTool(tools) as { inputSchema?: unknown };
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    const props = schema.properties as Record<string, { type?: string; minimum?: number; maximum?: number; maxLength?: number; minLength?: number }>;
    expect(props.principleId?.type).toBe('string');
    expect(props.principleId?.maxLength).toBe(200);
    expect(props.limit?.type).toBe('integer');
    expect(props.limit?.minimum).toBe(1);
    expect(props.limit?.maximum).toBe(10);
    expect(schema.additionalProperties).toBe(false);
    await h.client.close();
  });
});

describe('tools/call — envelope passthrough and isError mapping (§4.8)', () => {
  it.each([
    ['ok', undefined],
    ['no_matches', undefined],
    ['partial', undefined],
    ['not_found', undefined],
    ['unavailable', { code: 'source_missing', message: 'A required data source is missing; the query cannot be answered.' }],
    ['invalid_input', { code: 'invalid_input', message: 'The request violates the tool input contract.' }],
  ] as const)('status %s → capability envelope verbatim, NO isError', async (status, error) => {
    const h = await makeHarness(async () => envelope(status, error));
    const result = await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(result.isError).toBeFalsy();
    const parsed = parseEnvelope(result);
    expect(parsed.status).toBe(status);
    expect(parsed.schemaVersion).toBe('pd.capability.v1');
    await h.client.close();
  });

  it('disclosure_assertion_failed → isError true, withheld shell only', async () => {
    const h = await makeHarness(async () =>
      envelope('unavailable', { code: 'disclosure_assertion_failed', message: 'Internal disclosure assertion failed; the response was withheld.' })
    );
    const result = await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(result.isError).toBe(true);
    const parsed = parseEnvelope(result);
    expect(parsed.status).toBe('unavailable');
    expect(parsed.data).toBeNull();
    expect(parsed.error?.code).toBe('disclosure_assertion_failed');
    await h.client.close();
  });

  it('unexpected capability exception → tool_execution_failed, sanitized (no message/stack leak)', async () => {
    const h = await makeHarness(async () => {
      throw new Error('SECRET internal detail D:\\pd\\state.db EPERM stack: at /internal/path');
    });
    const result = await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(result.isError).toBe(true);
    const raw = textOf(result);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('state.db');
    expect(raw).not.toContain('D:');
    const parsed = JSON.parse(raw) as PainRecallCapabilityResult;
    expect(parsed.error?.code).toBe('tool_execution_failed');
    await h.client.close();
  });
});

describe('input contract (§4.2) — protocol-level validation', () => {
  it('rejects undeclared parameters without calling the capability', async () => {
    const h = await makeHarness();
    const result = await h.client.callTool({
      name: TOOL_NAME,
      arguments: { principleId: 'p-1', workspaceDir: 'C:\\evil', sql: 'select * from pains' },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.client.close();
  });

  it('rejects empty and oversized principleId without calling the capability', async () => {
    const h = await makeHarness();
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: '' } });
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'x'.repeat(201) } });
    expect(h.calls).toHaveLength(0);
    await h.client.close();
  });

  it('rejects out-of-range limit without calling the capability', async () => {
    const h = await makeHarness();
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1', limit: 0 } });
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1', limit: 11 } });
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1', limit: 3.5 } });
    expect(h.calls).toHaveLength(0);
    await h.client.close();
  });

  it('applies limit default 3 and passes validated input to the capability', async () => {
    const h = await makeHarness();
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1', limit: 10 } });
    expect(h.calls).toEqual([
      { workspaceDir: 'C:\\pd-test-workspace', principleId: 'p-1', limit: 3 },
      { workspaceDir: 'C:\\pd-test-workspace', principleId: 'p-1', limit: 10 },
    ]);
    await h.client.close();
  });
});

describe('single text content block (§4.6)', () => {
  it('never emits structuredContent', async () => {
    const h = await makeHarness(async () => envelope('ok'));
    const result = await h.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect((result as Record<string, unknown>).structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    await h.client.close();
  });
});
