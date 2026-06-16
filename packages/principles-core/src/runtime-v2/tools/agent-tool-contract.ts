/**
 * PRI-419 §M1 — L2 agent tool contract (core, pure logic).
 *
 * Defines the read-only tools the dreamer L2 agent loop can call, plus the context
 * interface that injects the in-process PD read-models. This file is PURE: it holds
 * tool definitions (name / description / typebox parameter schema) and a factory that
 * wires them to an injected context. No I/O, no `node:*` imports.
 *
 * Read-only-by-construction (ADR-0014 amendment §B.2): the injected store interface
 * (PdL2ArtifactReader) exposes ONLY getter/list methods — there is physically no write
 * capability to invoke. The beforeToolCall whitelist in the adapter is a second line
 * of defense, not the primary boundary.
 *
 * Tool set (dreamer, Phase 1):
 *   - read_principles : core axioms (T-01..T-10) + active internalized principles
 *   - read_artifact   : a predecessor pipeline artifact by id or source task id
 *   - submit_output   : the model's final DreamerOutputV1 submission (self-built;
 *                       pi-agent-core has no built-in submit_output). Its parameter
 *                       schema is the typebox DreamerOutputV1 redeclaration (§M6).
 *
 * The submit_output tool does NOT terminate the loop via `terminate` (that is
 * unreliable — agent-loop uses .every() over the whole tool batch). Loop termination
 * is driven by shouldStopAfterTurn detecting the captured output (see L2AgentLoopAdapter §M3).
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { CORE_PRINCIPLES } from '../core-principles/core-principle-registry.js';
import { DreamerOutputV1Typebox } from './dreamer-output-typebox.js';

// ── Read-only store sub-interfaces ──────────────────────────────────────────
// Intentionally narrow: only the methods the tools need, all read-only. A concrete
// PIArtifactStore satisfies this structurally; passing the full store is allowed but
// the tools can only call what this interface declares.

/** Shape returned by both reader methods (reused to avoid repeating the inline literal). */
interface ArtifactSummary {
  artifactId: string;
  artifactKind: string;
  sourceTaskId: string;
  contentJson: string;
  createdAt: string;
}

/** Read-only view of the artifact store used by read_artifact. */
export interface PdL2ArtifactReader {
  getArtifactById(artifactId: string): Promise<ArtifactSummary | null>;
  listBySourceTaskId(sourceTaskId: string): Promise<ArtifactSummary[]>;
}

/** Read-only view of the internalized-principle ledger used by read_principles. */
export interface PdL2PrincipleReader {
  /** Returns active internalized principles (id + statement). Empty if none/missing. */
  listActivePrinciples(): Promise<{ id: string; statement: string }[]>;
}

// ── Tool parameter schemas (typebox) ─────────────────────────────────────────

const readPrinciplesSchema = Type.Object({
  // No parameters needed — returns the full core + active set. Declared as an object
  // so the model sees an explicit (empty) contract rather than a parameterless stub.
});

const readArtifactSchema = Type.Object({
  artifactId: Type.Optional(Type.String({ description: 'Specific artifact id to read.' })),
  sourceTaskId: Type.Optional(Type.String({ description: 'Read artifacts produced by this task (e.g. the predecessor diagnostician task).' })),
});

// submit_output parameter schema = DreamerOutputV1Typebox (re-exported for clarity).
export { DreamerOutputV1Typebox as SubmitOutputSchema };

// ── Captured-output container ─────────────────────────────────────────────────
// The adapter reads this after the loop ends. submit_output stores its params here;
// shouldStopAfterTurn checks it to decide termination.

export interface L2OutputCapture {
  output: unknown | null;
}

// ── Tool factory ──────────────────────────────────────────────────────────────

export interface PdL2ToolContext {
  /** Read-only artifact store (predecessor pipeline artifacts). */
  artifactReader: PdL2ArtifactReader;
  /** Read-only internalized-principle ledger. */
  principleReader: PdL2PrincipleReader;
  /** The capture container the submit_output tool writes into. */
  outputCapture: L2OutputCapture;
  /** Telemetry sink: called once per tool execution (toolName + ok/error). */
  onToolExecution?: (info: { toolName: string; ok: boolean; error?: string }) => void;
}

function formatArtifact(a: ArtifactSummary): string {
  return [
    `artifactId: ${a.artifactId}`,
    `kind: ${a.artifactKind}`,
    `sourceTaskId: ${a.sourceTaskId}`,
    `createdAt: ${a.createdAt}`,
    `content: ${a.contentJson}`,
  ].join('\n');
}

/**
 * Resolve the text response for read_artifact. Extracted so the execute() body stays flat:
 * one success-path telemetry call + one catch-path telemetry call, no repetition.
 */
async function readArtifactText(ctx: PdL2ToolContext, params: { artifactId?: string; sourceTaskId?: string }): Promise<string> {
  if (typeof params.artifactId === 'string' && params.artifactId.length > 0) {
    const artifact = await ctx.artifactReader.getArtifactById(params.artifactId);
    return artifact
      ? formatArtifact(artifact)
      : `No artifact found with id '${params.artifactId}'.`;
  }
  if (typeof params.sourceTaskId === 'string' && params.sourceTaskId.length > 0) {
    const artifacts = await ctx.artifactReader.listBySourceTaskId(params.sourceTaskId);
    if (artifacts.length === 0) {
      return `No artifacts found for sourceTaskId '${params.sourceTaskId}'.`;
    }
    return artifacts.map(formatArtifact).join('\n\n');
  }
  // Missing both params — structured guidance, not a silent empty result (R9).
  return 'Provide either artifactId (a specific artifact) or sourceTaskId (the predecessor task). Both were empty.';
}

/**
 * Build the dreamer L2 tool set bound to an injected context.
 *
 * Returns AgentTool[] suitable for assignment to AgentContext.tools. Tools are
 * read-only by construction: they only call getter/list methods on the injected readers and
 * write the final answer into the outputCapture (which the adapter owns).
 */
export function buildDreamerL2Tools(ctx: PdL2ToolContext): AgentTool[] {
  const readPrinciplesTool: AgentTool<typeof readPrinciplesSchema, undefined> = {
    label: 'Read principles',
    name: 'read_principles',
    description:
      'Read the core axioms (T-01..T-10) plus already-internalized active principles. Call this BEFORE proposing candidates so your output is grounded in the existing principle hierarchy and does not duplicate or contradict it. Returns a list of {id, statement}.',
    parameters: readPrinciplesSchema,
    execute: async (): Promise<AgentToolResult<undefined>> => {
      try {
        const active = await ctx.principleReader.listActivePrinciples();
        const core = CORE_PRINCIPLES.map(p => ({ id: p.id, statement: p.statement }));
        const text = [
          'Core axioms (T-01..T-10):',
          ...core.map(p => `  ${p.id}: ${p.statement}`),
          '',
          active.length > 0
            ? `Already-internalized active principles (${active.length}):`
            : 'No internalized active principles yet.',
          ...active.map(p => `  ${p.id}: ${p.statement}`),
        ].join('\n');
        ctx.onToolExecution?.({ toolName: 'read_principles', ok: true });
        return {
          content: [{ type: 'text', text }],
          details: undefined,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'read_principles', ok: false, error });
        return {
          // Graceful degradation WITH a reason (Runtime Contract R9): surface the error
          // to the model rather than silently returning empty data.
          content: [{ type: 'text', text: `read_principles failed: ${error}. Proceed using only the core axioms you already know.` }],
          details: undefined,
        };
      }
    },
  };

  const readArtifactTool: AgentTool<typeof readArtifactSchema, undefined> = {
    label: 'Read artifact',
    name: 'read_artifact',
    description:
      'Read a pipeline artifact (e.g. the predecessor diagnostician output) by artifactId, or list artifacts produced by a sourceTaskId. Call this to verify the evidence chain before generating candidates. Returns artifact contentJson (a JSON string).',
    parameters: readArtifactSchema,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      try {
        const text = await readArtifactText(ctx, params);
        ctx.onToolExecution?.({ toolName: 'read_artifact', ok: true });
        return { content: [{ type: 'text', text }], details: undefined };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        ctx.onToolExecution?.({ toolName: 'read_artifact', ok: false, error });
        return {
          content: [{ type: 'text', text: `read_artifact failed: ${error}.` }],
          details: undefined,
        };
      }
    },
  };

  const submitOutputTool: AgentTool<typeof DreamerOutputV1Typebox, undefined> = {
    label: 'Submit output',
    name: 'submit_output',
    description:
      'Submit your final dreamer output. You MUST call this exactly once with a complete DreamerOutputV1 object (valid=true, taskId, 1-5 candidates, contextRefs, generatedAt). The loop stops after you call this. Do not emit the answer as free text — call this tool.',
    parameters: DreamerOutputV1Typebox,
    execute: async (_id, params): Promise<AgentToolResult<undefined>> => {
      // Store the captured output. The adapter's shouldStopAfterTurn detects this and
      // terminates the loop; terminate:true is a secondary hint only (unreliable across
      // a multi-tool batch — see ADR-0014 amendment §B.3 / review P0-2).
      ctx.outputCapture.output = params;
      ctx.onToolExecution?.({ toolName: 'submit_output', ok: true });
      return {
        content: [{ type: 'text', text: 'Output submitted.' }],
        details: undefined,
        terminate: true,
      };
    },
  };

  return [readPrinciplesTool, readArtifactTool, submitOutputTool];
}

/** Allow-list of tool names the dreamer L2 loop may execute (defense-in-depth for beforeToolCall). */
export const DREAMER_L2_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'read_principles',
  'read_artifact',
  'submit_output',
]);

