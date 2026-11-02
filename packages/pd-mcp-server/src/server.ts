/**
 * PD MCP Server assembly — SPEC-PD-MCP-GATE4-001 §3/§4/§5 (Gate 4-B).
 *
 * One server implementation shared by all three hosts (Codex / OpenClaw /
 * WorkBuddy each spawn their own process around this module). Business data
 * flows EXCLUSIVELY through the Gate 3 Capability public subpath
 * `@principles/core/runtime-v2/pain-recall-capability` — never the read
 * model, never a CLI subprocess, never a second query implementation
 * (§3.2). Core stays MCP-SDK-free (architecture guard test pins this).
 *
 * The single registered tool is the read-only `pd_recall_principle_pains`
 * with an honest `readOnlyHint: true` (a host hint, not an OS boundary).
 */
import { McpServer, fromJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  recallPrinciplePainsCapability,
  type PainRecallCapabilityResult,
} from '@principles/core/runtime-v2/pain-recall-capability';
import { runWithDeadline, OrphanLimiter, DEFAULT_DEADLINE_MS } from './deadline.js';
import { assembleResult, adapterFailureEnvelope, textResult, type ToolResult } from './envelope.js';
import { RESPONSE_BUDGET_BYTES, withinBudget } from './budget.js';
import { createLogger, sanitizeErrorKind, stderrSink } from './logging.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export const TOOL_NAME = 'pd_recall_principle_pains' as const;

export const TOOL_DESCRIPTION =
  'Recall a principle\'s verifiably-associated historical pain experience (availability-level disclosure only, OD-A v1). Read-only.';

/** §4.2 input contract: `principleId` (1..200, required) and `limit`
 * (1..10, default 3); every other property is rejected at the protocol
 * input-validation stage (`additionalProperties: false`) before the
 * capability is called. No path, SQL, host/session/turn/pain id, or
 * ordering parameters exist. The capability re-validates field-by-field
 * (defense in depth). */
export const toolInputJsonSchema = {
  type: 'object',
  properties: {
    principleId: { type: 'string', minLength: 1, maxLength: 200, description: 'Principle identifier to recall pains for.' },
    limit: { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Maximum number of pain entries to return (1..10, default 3).' },
  },
  required: ['principleId'],
  additionalProperties: false,
} as const;

/** Protocol-level schema handed to the SDK (JSON-Schema-first: strict
 * rejection of undeclared parameters at the input-validation stage). */
export const toolProtocolSchema = fromJsonSchema(toolInputJsonSchema);

/** In-handler typed re-validation (idempotent post-SDK parse; applies the
 * `limit` default and yields the typed value). Mirrors the JSON schema
 * above — kept in lockstep by the contract tests. */
export const toolInputSchema = z.strictObject({
  principleId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(10).optional().default(3),
});

export type ToolInput = z.infer<typeof toolInputSchema>;

/** The capability entry the server calls — injectable for adapter-contract
 * tests; production always uses the real Gate 3 Facade. */
export type CapabilityCall = (input: {
  readonly workspaceDir: string;
  readonly principleId: string;
  readonly limit: number;
}) => Promise<PainRecallCapabilityResult>;

export interface PdMcpServerOptions {
  readonly workspaceDir: string;
  readonly host?: string | null;
  readonly deadlineMs?: number;
  readonly callCapability?: CapabilityCall;
  readonly logSink?: (line: string) => void;
}

export interface PdMcpServerHandle {
  readonly mcpServer: McpServer;
  readonly orphans: OrphanLimiter;
  /** Lifecycle flag: once closing, in-flight work drains and new calls get
   * the shutting-down failure (§5.5). */
  beginShutdown(): void;
  isShuttingDown(): boolean;
}

/** §4.8 Adapter 执行失败 row (timeout / exception / saturated / shutting
 * down) — one sanitized `tool_execution_failed` envelope, isError: true. */
function executionFailedResult(message: string): ToolResult {
  const envelope = adapterFailureEnvelope('tool_execution_failed', message);
  return textResult(JSON.stringify(envelope), true);
}

/** §4.8 "Server 正在关闭" row: refused without touching the capability. */
function shuttingDownResult(): ToolResult {
  return executionFailedResult('The server is shutting down; the call was not completed.');
}

/**
 * Build the PD MCP server (not yet connected to any transport).
 *
 * Handler flow per §4.7/§4.8: shutdown/saturation gates → deadline-wrapped
 * capability call → envelope assembly (serialize → 32 KiB budget → emit) →
 * explicit isError mapping. Nothing here writes to stdout.
 */
export function createPdMcpServer(options: PdMcpServerOptions): PdMcpServerHandle {
  const {
    workspaceDir,
    host = null,
    deadlineMs = DEFAULT_DEADLINE_MS,
    callCapability = recallPrinciplePainsCapability,
    logSink = stderrSink,
  } = options;

  const orphans = new OrphanLimiter();
  let shuttingDown = false;

  const mcpServer = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const log = createLogger(logSink, { host: host ?? 'unspecified' });

  mcpServer.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON | undefined>(
    TOOL_NAME,
    {
      description: TOOL_DESCRIPTION,
      // Static type-interop shim ONLY: our zod 4.6.7 type instantiation does
      // not match the SDK's bundled zod-4.2-based generic constraint, so the
      // overloads fall through to the raw-shape one. Runtime validation is
      // unaffected — the SDK still validates every call against exactly this
      // (fromJsonSchema-built) schema. NOT a validation bypass (rc-2 scope:
      // untrusted-data validation stays fully runtime-checked).
      inputSchema: toolProtocolSchema,
      annotations: { readOnlyHint: true },
    },
    async (rawInput: unknown): Promise<ToolResult> => {
      const startedAt = Date.now();
      // §4.7: the window covers validation → capability → projection →
      // serialization; validation of the parsed input is part of the race.
      const outcome = await runWithDeadline(
        async () => {
          if (shuttingDown) {
            return { kind: 'shuttingDown' as const };
          }
          if (orphans.saturated) {
            return { kind: 'saturated' as const };
          }
          try {
            // The SDK already validated against the zod schema; parse again
            // for the typed value (idempotent) and count it inside the window.
            const parsed = toolInputSchema.parse(rawInput);
            const envelope = await callCapability({
              workspaceDir,
              principleId: parsed.principleId,
              limit: parsed.limit,
            });
            const assembled = assembleResult(envelope);
            if (assembled.ok) return { kind: 'envelope' as const, result: assembled.result };
            return { kind: 'overBudget' as const, bytes: assembled.overBudgetBytes };
          } catch (err) {
            // §4.8 非预期异常: map to a sanitized Adapter failure here — the
            // raw exception (message/stack may carry paths or internals)
            // must NEVER reach the SDK's default handler-error path.
            return { kind: 'exception' as const, errorKind: sanitizeErrorKind(err) };
          }
        },
        deadlineMs,
        (orphaned) => orphans.register(orphaned)
      );

      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        switch (outcome.value.kind) {
          case 'envelope': {
            log('info', 'tool_call_completed', { durationMs, resultKind: 'envelope' });
            return outcome.value.result;
          }
          case 'overBudget': {
            log('warn', 'tool_call_over_budget', { durationMs, bytes: outcome.value.bytes, budget: RESPONSE_BUDGET_BYTES });
            const failure = adapterFailureEnvelope(
              'response_budget_exceeded',
              'The response exceeded the 32 KiB MCP budget and was withheld without truncation.'
            );
            const failureJson = JSON.stringify(failure);
            if (!withinBudget(failureJson)) {
              // Cannot happen (static shell), but fail loud over silent breakage.
              log('error', 'failure_envelope_over_budget', {});
            }
            return textResult(failureJson, true);
          }
          case 'shuttingDown': {
            log('warn', 'tool_call_refused_shutting_down', { durationMs });
            return shuttingDownResult();
          }
          case 'saturated': {
            log('warn', 'tool_call_refused_saturated', { durationMs, orphans: orphans.size });
            return executionFailedResult(
              'The server is still draining earlier timed-out calls; retry shortly.'
            );
          }
          case 'exception': {
            // Sanitized category only — no message, no stack, no paths.
            log('error', 'tool_call_unexpected_exception', { durationMs, errorKind: outcome.value.errorKind });
            return executionFailedResult(
              'The call failed unexpectedly; the error was logged server-side with a sanitized category only.'
            );
          }
        }
      }
      // Deadline exceeded (§4.7): stop waiting, suppress the late result,
      // report an Adapter execution failure. Not underlying cancellation.
      log('warn', 'tool_call_deadline_exceeded', { durationMs, deadlineMs, orphans: orphans.size });
      return executionFailedResult(
        `The call exceeded the ${deadlineMs} ms deadline; the late result is suppressed and will not be delivered.`
      );
    }
  );

  return {
    mcpServer,
    orphans,
    beginShutdown() {
      shuttingDown = true;
      log('info', 'shutdown_begun', { orphans: orphans.size });
    },
    isShuttingDown() {
      return shuttingDown;
    },
  };
}
