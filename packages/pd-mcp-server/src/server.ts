/**
 * PD MCP Server assembly — SPEC-PD-MCP-GATE4-001 §3/§4/§5 (Gate 4-B).
 *
 * One server implementation shared by all three hosts (Codex / OpenClaw /
 * WorkBuddy each spawn their own process around this module). Business data
 * flows EXCLUSIVELY through the Gate 3 Capability public subpath
 * `@principles/core/runtime/pain-recall-capability` — never the read
 * model, never a CLI subprocess, never a second query implementation
 * (§3.2). Core stays MCP-SDK-free (architecture guard test pins this).
 *
 * The single read tool is `pd_recall_principle_pains` (`readOnlyHint: true`).
 * The write tool `pd_submit_pain` exists only when the caller explicitly sets
 * `enableSubmitTool: true` — the OG-4 production governance gate
 * (SPEC-PD-AGENT-PAIN-INGRESS-001 §5.1.1). No env var or feature flag can turn
 * it on: a deployment must opt in in code and carry the OG-4 record. The Owner
 * authorized OG-4 for the WorkBuddy host on 2026-11-13; `submit-assembly.ts`
 * and `index.ts` hold the sole production opt-in. Codex / OpenClaw and every
 * default construction stay recall-only.
 */
import { randomBytes } from 'node:crypto';
import { McpServer, fromJsonSchema, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  recallPrinciplePainsCapability,
  type PainRecallCapabilityResult,
} from '@principles/core/runtime/pain-recall-capability';
import {
  buildRefusedSubmitReceipt,
  buildUnconfirmedSubmitReceipt,
  buildReconciledSubmitReceipt,
  deriveSubmitTaskId,
  recheckSubmittedTask,
  type PainSubmitReceipt,
  type SubmittedTaskRecheck,
} from '@principles/core/runtime/pain-submit-capability';
import { runWithDeadline, OrphanLimiter, AdmissionLimiter, DEFAULT_DEADLINE_MS } from './deadline.js';
import {
  assembleResult,
  assembleSubmitResult,
  adapterFailureEnvelope,
  textResult,
  type ToolResult,
} from './envelope.js';
import { withinBudget } from './budget.js';
import { createLogger, sanitizeErrorKind, stderrSink } from './logging.js';
import type { PdMcpHost } from './workspace.js';
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

// ── pd_submit_pain — OG-4 gated write tool ─────────────────────────────────

export const SUBMIT_TOOL_NAME = 'pd_submit_pain' as const;

/** §5.2 — the description is a behavioural instruction to the Agent, not
 * marketing copy. It carries the anchor-first / Owner-consent-first flow and
 * deliberately promises registration only, never that diagnosis will run. */
export const SUBMIT_TOOL_DESCRIPTION = `记录一条"相对锚点的显著行为背离"（Pain）。

调用前必须完成三件事：
1) 先确定锚点：Owner 的明确期望、已建立的原则、或 Agent Instructions/Skill 的明确要求。
   原则必须给出 id 与 version；Instructions 必须给出路径与章节；Owner 期望必须给出处。
2) 先向 Owner 说明：①锚点及出处 ②你实际观察到的具体行为 ③行为与锚点之间的背离 ④必要时补充为什么值得关注或可能的影响。
3) 取得 Owner 在本次对话中的明确同意。未回复、回答不明确、或只说了"随便"都不算授权。
   授权只对本次提交有效；Owner 修改了内容时，提交前必须再次确认最终版本。
   后台/无人值守 Agent 不得自行提交。

第 2 步的 ④ 是辅助说明，不是提交条件：不要求证明未来任务一定会改变判断、
不要求证明会重复发生、不要求已产生实际损失、不要求证明长期复用价值。
无法证明上述任何一项，都不得成为拒绝记录这条 Pain 的理由——它们只帮助 Owner
判断注意力优先级，不属于 Pain 是否成立的条件，也不属于提交门槛。

Pain 是否成立只看三项：明确锚点 + 具体行为 + 相对锚点的显著背离。

不要提交：分数、严重度、优先级、会话 ID、审批令牌、推测的 painType、
或任何你无法给出出处的"锚点"。

如果无法确定锚点或无法说明具体行为，不要调用本工具；先向 Owner 澄清。`;

/** §5.3 — JSON Schema first; every undeclared property (score, severity,
 * approved, sessionId, paths, metadata) is rejected at the protocol stage. */
export const submitToolInputJsonSchema = {
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 2000,
      description: '按六项顺序组织：锚点、锚点来源与引用等级、观察到的行为、背离、为什么值得记录、上下文。',
    },
    anchorType: {
      type: 'string',
      enum: ['owner_expectation', 'established_principle', 'agent_instruction'],
      description: '锚点类型。无法归类时不要提交。',
    },
    anchorRef: {
      type: 'string',
      minLength: 1,
      maxLength: 300,
      description: '原则：<id>@<version>；Instructions：<path>#<section>；Owner 期望：本次对话中的出处。',
    },
    painType: {
      type: 'string',
      enum: ['principle_deviation', 'tool_failure', 'subagent_error', 'user_frustration'],
      description: '可选。锚点式 Pain 默认是 principle_deviation；只有你能明确归类时才填写其他值，不要猜测。',
    },
  },
  required: ['reason', 'anchorType', 'anchorRef'],
  additionalProperties: false,
} as const;

export const submitToolProtocolSchema = fromJsonSchema(submitToolInputJsonSchema);

/** §5.3.2 — zod re-validation, kept in lockstep with the JSON Schema above. */
export const submitToolInputSchema = z.strictObject({
  reason: z.string().min(1).max(2000),
  anchorType: z.enum(['owner_expectation', 'established_principle', 'agent_instruction']),
  anchorRef: z.string().min(1).max(300),
  painType: z.enum(['principle_deviation', 'tool_failure', 'subagent_error', 'user_frustration']).optional(),
});

export type SubmitToolInput = z.infer<typeof submitToolInputSchema>;

/** §5.7 — the bounded read-back after a write timeout (upper bound 1s). */
export const SUBMIT_RECHECK_DEADLINE_MS = 1000 as const;

/** Handler-generated identity, known BEFORE any write: `mcp_<epoch_ms>_<8-hex>`
 * (§5.4.1). Never derived from a session, host or model input. */
function defaultRandomHex(): string {
  return randomBytes(4).toString('hex');
}

export function createMcpPainId(nowMs: number = Date.now(), randomHex: () => string = defaultRandomHex): string {
  return `mcp_${nowMs}_${randomHex()}`;
}

/** The submit capability entry — injectable for adapter-contract tests;
 * production always uses the real Core capability. */
export type SubmitCapabilityCall = (input: {
  readonly workspaceDir: string;
  readonly painId: string;
  readonly taskId: string;
  readonly submission: SubmitToolInput;
}) => Promise<PainSubmitReceipt>;

/** Bounded read-back entry — injectable for timeout tests. */
export type SubmitRecheckCall = (input: {
  readonly workspaceDir: string;
  readonly painId: string;
  readonly taskId: string;
}) => Promise<SubmittedTaskRecheck>;

/** The capability entry the server calls — injectable for adapter-contract
 * tests; production always uses the real Gate 3 Facade. */
export type CapabilityCall = (input: {
  readonly workspaceDir: string;
  readonly principleId: string;
  readonly limit: number;
}) => Promise<PainRecallCapabilityResult>;

export interface PdMcpServerOptions {
  readonly workspaceDir: string;
  readonly host?: PdMcpHost | null;
  readonly deadlineMs?: number;
  readonly callCapability?: CapabilityCall;
  readonly logSink?: (line: string) => void;
  /** OG-4 gate (§5.1.1): registers the write tool ONLY when this is
   * explicitly `true`. Default `false`; no env var or feature flag can change
   * it. WorkBuddy's production entry opts in under the Owner's 2026-11-13
   * authorization; other hosts and all default constructions stay
   * recall-only. */
  readonly enableSubmitTool?: boolean;
  /** Submit capability entry. There is NO default: `main()` binds the real
   * Core capability to `<workspaceDir>/.state` AND an effective
   * `.pd/config.yaml` (see `submit-assembly.ts`). Opting in without this
   * injection fails closed at construction time. */
  readonly callSubmitCapability?: SubmitCapabilityCall;
  /** Bounded read-back entry used after a write timeout (§5.7). */
  readonly recheckSubmitTask?: SubmitRecheckCall;
}

export interface PdMcpServerHandle {
  readonly mcpServer: McpServer;
  /** Timeout stragglers tracked until their underlying work settles. */
  readonly orphans: OrphanLimiter;
  /** Executing-call capacity; admission is reserved before the capability is
   * invoked and released only on real settlement (§4.7). */
  readonly admissions: AdmissionLimiter;
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

/** Byte size of the text this call actually returned (never the input). */
function resultTextBytes(result: ToolResult): number {
  try {
    const [first] = result.content;
    return first === undefined ? 0 : Buffer.byteLength(first.text, 'utf8');
  } catch {
    return 0;
  }
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
    enableSubmitTool = false,
    callSubmitCapability,
    recheckSubmitTask = recheckSubmittedTask,
  } = options;

  const submitCall: SubmitCapabilityCall | undefined = callSubmitCapability;
  if (enableSubmitTool === true && submitCall === undefined) {
    // Fail closed instead of silently falling back to resolveRuntimeConfig(),
    // the deprecated .state/workflows.yaml resolver (PRI-393 forbids it on
    // production execution paths). The host wrapper that opts in must bind the
    // real Core capability to an effective `.pd/config.yaml` config.
    throw new Error(
      'pd_submit_pain requires an injected callSubmitCapability bound to an effective PD config; ' +
        'the MCP server must not resolve runtime config through the deprecated workflows.yaml path.'
    );
  }

  const orphans = new OrphanLimiter();
  const admissions = new AdmissionLimiter();
  let shuttingDown = false;

  const mcpServer = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const log = createLogger(logSink, { host: host ?? 'unspecified' });

  /** One structured `tool_call` line for the submit path (§5.5 step 11). Only
   * scalars: status, error code, byte size, degradation — never Pain text. */
  function logSubmitCall(input: {
    startedAt: number;
    result: ToolResult;
    status: string;
    errorCode: string;
    degraded?: 'none' | 'minimal' | 'untransportable';
    level?: 'info' | 'warn' | 'error';
  }): void {
    log(input.level ?? 'info', 'tool_call', {
      toolName: SUBMIT_TOOL_NAME,
      durationMs: Date.now() - input.startedAt,
      status: input.status,
      errorCode: input.errorCode,
      responseBytes: resultTextBytes(input.result),
      truncated: false,
      ...(input.degraded === undefined ? {} : { degraded: input.degraded }),
    });
  }

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
      // §4.7 admission: reserve execution capacity SYNCHRONOUSLY at handler
      // entry, before any await and before the capability is called. Without
      // this, N concurrent requests all pass an orphan-count check while none
      // has timed out yet and N > limit capability calls start.
      if (shuttingDown) {
        const refused = shuttingDownResult();
        log('warn', 'tool_call', {
          toolName: TOOL_NAME,
          durationMs: Date.now() - startedAt,
          status: 'unavailable',
          errorCode: 'shutting_down',
          responseBytes: resultTextBytes(refused),
          truncated: false,
        });
        return refused;
      }
      if (!admissions.tryAcquire()) {
        const saturated = executionFailedResult(
          'The server is already executing the maximum number of concurrent calls; retry shortly.'
        );
        log('warn', 'tool_call', {
          toolName: TOOL_NAME,
          durationMs: Date.now() - startedAt,
          status: 'unavailable',
          errorCode: 'saturated',
          responseBytes: resultTextBytes(saturated),
          truncated: false,
        });
        return saturated;
      }
      // The window covers validation → capability → projection →
      // serialization; validation of the parsed input is part of the race.
      // The `finally` releases capacity when the UNDERLYING work actually
      // settles — a deadline stops the wait, not the reservation. An orphan
      // therefore keeps its slot until its promise resolves/rejects.
      const outcome = await runWithDeadline(
        async () => {
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
            if (assembled.ok) {
              return {
                kind: 'envelope' as const,
                result: assembled.result,
                status: envelope.status,
                errorCode: envelope.error?.code ?? 'none',
              };
            }
            return { kind: 'overBudget' as const, bytes: assembled.overBudgetBytes };
          } catch (err) {
            // §4.8 非预期异常: map to a sanitized Adapter failure here — the
            // raw exception (message/stack may carry paths or internals)
            // must NEVER reach the SDK's default handler-error path.
            return { kind: 'exception' as const, errorKind: sanitizeErrorKind(err) };
          } finally {
            admissions.release();
          }
        },
        deadlineMs,
        (orphaned) => orphans.register(orphaned)
      );

      const durationMs = Date.now() - startedAt;

      if (outcome.ok) {
        switch (outcome.value.kind) {
          case 'envelope': {
            log('info', 'tool_call', {
              toolName: TOOL_NAME,
              durationMs,
              status: outcome.value.status,
              errorCode: outcome.value.errorCode,
              responseBytes: resultTextBytes(outcome.value.result),
              truncated: false,
            });
            return outcome.value.result;
          }
          case 'overBudget': {
            const failure = adapterFailureEnvelope(
              'response_budget_exceeded',
              'The response exceeded the 32 KiB MCP budget and was withheld without truncation.'
            );
            const failureJson = JSON.stringify(failure);
            // A static shell that cannot fit is a hard defect; surface it in the
            // same tool_call record instead of emitting a second event.
            const failureCode = withinBudget(failureJson)
              ? 'response_budget_exceeded'
              : 'failure_envelope_over_budget';
            const withheld = textResult(failureJson, true);
            log('warn', 'tool_call', {
              toolName: TOOL_NAME,
              durationMs,
              status: 'unavailable',
              errorCode: failureCode,
              responseBytes: resultTextBytes(withheld),
              truncated: false,
            });
            return withheld;
          }
          case 'exception': {
            // Sanitized category only — no message, no stack, no paths.
            const failed = executionFailedResult(
              'The call failed unexpectedly; the error was logged server-side with a sanitized category only.'
            );
            log('error', 'tool_call', {
              toolName: TOOL_NAME,
              durationMs,
              status: 'unavailable',
              errorCode: 'tool_execution_failed',
              responseBytes: resultTextBytes(failed),
              truncated: false,
            });
            return failed;
          }
        }
      }
      // Deadline exceeded (§4.7): stop waiting, suppress the late result,
      // report an Adapter execution failure. Not underlying cancellation:
      // the capacity slot stays reserved until the orphan settles.
      const timedOut = executionFailedResult(
        `The call exceeded the ${deadlineMs} ms deadline; the late result is suppressed and will not be delivered.`
      );
      log('warn', 'tool_call', {
        toolName: TOOL_NAME,
        durationMs,
        status: 'unavailable',
        errorCode: 'deadline_exceeded',
        responseBytes: resultTextBytes(timedOut),
        truncated: false,
      });
      return timedOut;
    }
  );

  // ── pd_submit_pain — registered ONLY behind the explicit OG-4 gate ────────
  if (enableSubmitTool === true && submitCall !== undefined) {
    mcpServer.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON | undefined>(
      SUBMIT_TOOL_NAME,
      {
        description: SUBMIT_TOOL_DESCRIPTION,
        // Same static interop shim as the recall tool; runtime validation is
        // the SDK's JSON-Schema pass plus the zod parse inside the handler.
        inputSchema: submitToolProtocolSchema,
        // §5.1 — the write capability must not inherit the read tool's hint.
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async (rawInput: unknown): Promise<ToolResult> => {
        const startedAt = Date.now();

        if (shuttingDown) {
          const refusedResult = shuttingDownResult();
          logSubmitCall({
            startedAt,
            result: refusedResult,
            status: 'unavailable',
            errorCode: 'shutting_down',
            level: 'warn',
          });
          return refusedResult;
        }
        if (!admissions.tryAcquire()) {
          // Not attempted: no write was started, so the generic failure text is
          // faithful here (unlike a timeout after the write began).
          const saturated = executionFailedResult(
            'The server is already executing the maximum number of concurrent calls; retry shortly.'
          );
          logSubmitCall({
            startedAt,
            result: saturated,
            status: 'unavailable',
            errorCode: 'saturated',
            level: 'warn',
          });
          return saturated;
        }

        // §5.5 step 3 — zod re-validation. Synchronous and before any write.
        let submission: SubmitToolInput;
        try {
          submission = submitToolInputSchema.parse(rawInput);
        } catch {
          admissions.release();
          const receipt = buildRefusedSubmitReceipt({
            painId: null,
            taskId: null,
            workspaceDir,
            code: 'invalid_input',
            message:
              'The request violates the pd_submit_pain input contract (reason 1..2000, anchorType in enum, anchorRef 1..300, no extra fields). Nothing was written.',
            nextAction:
              'Fix the arguments and retry. If no anchor is available, do not submit — clarify with the Owner first.',
          });
          const assembled = assembleSubmitResult(receipt);
          logSubmitCall({
            startedAt,
            result: assembled.result,
            status: receipt.status,
            errorCode: 'invalid_input',
            degraded: assembled.degraded,
            level: 'warn',
          });
          return assembled.result;
        }

        // §5.5 step 5 — identity exists BEFORE the write, so a timeout can be
        // reconciled by id instead of guessing (§5.7).
        const painId = createMcpPainId();
        const taskId = deriveSubmitTaskId(painId);

        const outcome = await runWithDeadline(
          async () => {
            try {
              const receipt = await submitCall({ workspaceDir, painId, taskId, submission });
              return { kind: 'receipt' as const, receipt };
            } catch (err) {
              // The capability promises not to throw; if it does, the outcome
              // after identity assignment is unknown, never "failed".
              return { kind: 'exception' as const, errorKind: sanitizeErrorKind(err) };
            } finally {
              admissions.release();
            }
          },
          deadlineMs,
          (orphaned) => orphans.register(orphaned)
        );

        if (outcome.ok) {
          if (outcome.value.kind === 'receipt') {
            const assembled = assembleSubmitResult(outcome.value.receipt);
            logSubmitCall({
              startedAt,
              result: assembled.result,
              status: outcome.value.receipt.status,
              errorCode: outcome.value.receipt.error?.code ?? 'none',
              degraded: assembled.degraded,
              level: outcome.value.receipt.status === 'failed' ? 'error' : 'info',
            });
            return assembled.result;
          }
          const unconfirmed = buildUnconfirmedSubmitReceipt({
            painId,
            taskId,
            workspaceDir,
            message:
              'The submission threw unexpectedly after the identity was assigned; the write outcome is unknown (it may already have been written).',
          });
          const assembled = assembleSubmitResult(unconfirmed);
          logSubmitCall({
            startedAt,
            result: assembled.result,
            status: unconfirmed.status,
            errorCode: `unexpected_${outcome.value.errorKind}`,
            degraded: assembled.degraded,
            level: 'error',
          });
          return assembled.result;
        }

        // §5.7 — write deadline exceeded. One bounded read-back, then report.
        // Never a plain failure, never an automatic resubmission.
        const recheck = await runWithDeadline(
          () => recheckSubmitTask({ workspaceDir, painId, taskId }),
          SUBMIT_RECHECK_DEADLINE_MS
        );

        if (recheck.ok && recheck.value === 'found') {
          const reconciled = buildReconciledSubmitReceipt({ painId, taskId, workspaceDir });
          const assembled = assembleSubmitResult(reconciled);
          logSubmitCall({
            startedAt,
            result: assembled.result,
            status: reconciled.status,
            errorCode: 'deadline_exceeded_reconciled',
            degraded: assembled.degraded,
            level: 'warn',
          });
          return assembled.result;
        }

        const unconfirmed = buildUnconfirmedSubmitReceipt({
          painId,
          taskId,
          workspaceDir,
          message:
            recheck.ok && recheck.value === 'not_found'
              ? `The submission exceeded the ${deadlineMs} ms deadline and the bounded read-back did not find task '${taskId}'. It may still be written; do not resubmit blindly.`
              : `The submission exceeded the ${deadlineMs} ms deadline and the bounded read-back could not determine whether task '${taskId}' was written.`,
        });
        const assembled = assembleSubmitResult(unconfirmed);
        logSubmitCall({
          startedAt,
          result: assembled.result,
          status: unconfirmed.status,
          errorCode: 'deadline_exceeded_unconfirmed',
          degraded: assembled.degraded,
          level: 'warn',
        });
        return assembled.result;
      }
    );
  }

  return {
    mcpServer,
    orphans,
    admissions,
    beginShutdown() {
      shuttingDown = true;
    },
    isShuttingDown() {
      return shuttingDown;
    },
  };
}
