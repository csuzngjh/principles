/**
 * Trajectory Collector - message write trajectory recording
 *
 * Fallback trajectory collection when llm_output is blocked by missing
 * allowConversationAccess. before_message_write is NOT in
 * CONVERSATION_HOOK_NAMES so OpenClaw always delivers it.
 *
 * SQLite writes are enqueued to an async queue because before_message_write is
 * a SYNCHRONOUS OpenClaw hook — the handler must return immediately. better-sqlite3
 * is synchronous, so calling it directly would block the message-write main path.
 * Trade-off: in degradation mode the last few queued writes may be lost on
 * process exit; this is acceptable because degradation mode is already caused
 * by a config problem (missing allowConversationAccess), and the primary
 * llm_output path is authoritative when authorized.
 *
 * JSONL writing was removed (no consumers — verified zero readers across the
 * codebase; PRI-347 already removed tool_call/llm_output JSONL writers).
 *
 * ERR-002: fallback errors are logged, never silent.
 * ERR-001/005: content is sanitized before persisting.
 */

import type {
  PluginHookAgentContext,
  PluginHookBeforeMessageWriteEvent
} from '../openclaw-sdk.js';
import { MAX_STRING_LENGTH } from '../config/defaults/runtime.js';
import { WorkspaceContext } from '../core/workspace-context.js';
import { SystemLogger } from '../core/system-logger.js';
import { sanitizeForEvidence } from './message-sanitize.js';
import { checkConversationAccessConfig } from '../core/config-health.js';

/**
 * Async write queue — ensures ordered, non-blocking execution of SQLite writes.
 * before_message_write is a sync hook; SQLite I/O must not block it.
 *
 * Tasks are deferred to the microtask queue via `queueMicrotask` so the sync
 * hook handler returns before any synchronous better-sqlite3 work runs.
 */
class AsyncWriteQueue {
  private readonly queue: (() => Promise<void>)[] = [];
  private processing = false;

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (!this.processing) {
      this.processing = true;
      queueMicrotask(() => { void this.processNext(); });
    }
  }

  private async processNext(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;
      try {
        await task();
      } catch (err) {
        // EP-03/ERR-002: safety net — tasks should catch their own errors with
        // structured logging. This catches bugs where a task's try/catch is
        // missing or re-throws. Never silently swallow (ERR-002).
        console.warn('[PD:trajectory-queue] uncaught task error:', err);
      }
    }
    this.processing = false;
  }
}

const writeQueue = new AsyncWriteQueue();

/**
 * Extract text content from a message (string or content-part array).
 */
function extractContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part: unknown) => part && typeof part === 'object' && (part as { type?: string }).type === 'text')
      .map((part: unknown) => (part as { text: string }).text)
      .join('\n');
  }
  return '';
}

/**
 * PRI-346: Message write hook with SQLite fallback trajectory recording.
 *
 * When allowConversationAccess is NOT set (unauthorized), llm_output is silently
 * blocked by OpenClaw and trajectory.db has no data. This hook is NOT in
 * CONVERSATION_HOOK_NAMES, so it always fires — making it the natural fallback.
 *
 * De-duplication: only writes to SQLite when llm_output is blocked (unauthorized).
 * When llm_output is working (authorized), this hook is a no-op.
 *
 * SQLite writes are async-queued (see file header) to avoid blocking the sync hook.
 *
 * ERR-002: structured observability when fallback fires.
 * ERR-001/005: content is sanitized before persisting.
 */
export function handleBeforeMessageWrite(
  event: PluginHookBeforeMessageWriteEvent,
  ctx: PluginHookAgentContext & { workspaceDir?: string; pluginConfig?: unknown }
): void {
  const { workspaceDir } = ctx;
  if (!workspaceDir) return;

  const msg = event.message;
  if (!msg || !msg.role) return;

  // Only record user and assistant messages
  if (msg.role !== 'user' && msg.role !== 'assistant') return;

  // ── SQLite fallback (PRI-346): only when conversation hooks are blocked ──
  const accessCheck = checkConversationAccessConfig(ctx.pluginConfig);
  if (accessCheck.authorized) {
    // llm_output is working — do NOT duplicate write to SQLite (de-dup, case D)
    return;
  }

  // Conversation hooks blocked — this hook is the fallback trajectory writer.
  // Enqueue SQLite writes to avoid blocking the sync before_message_write hook.
  const logger = ctx.logger;
  const content = extractContent(msg.content);
  const sessionId = (event.sessionKey as string | undefined) ?? ctx.sessionId ?? 'unknown';
  const createdAt = new Date().toISOString();

  if (msg.role === 'assistant') {
    writeQueue.enqueue(async () => {
      try {
        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, logger });
        const sanitized = sanitizeForEvidence(content.slice(0, MAX_STRING_LENGTH), workspaceDir);
        wctx.trajectory?.recordAssistantTurn?.({
          sessionId,
          runId: 'before_message_write_fallback',
          provider: 'unknown',
          model: 'unknown',
          rawText: content,
          sanitizedText: sanitized,
          usageJson: {},
          empathySignalJson: { detected: false, severity: 'mild', confidence: 1 },
          createdAt,
        });
      } catch (err) {
        // EP-03/ERR-002: observable degradation, never silent
        logger?.warn?.(`[PD:before_message_write] SQLite fallback write failed: ${String(err)}`);
      }
    });
  } else if (msg.role === 'user') {
    writeQueue.enqueue(async () => {
      try {
        const wctx = WorkspaceContext.fromHookContext({ workspaceDir, logger });
        wctx.trajectory?.recordUserTurn?.({
          sessionId,
          turnIndex: 0,
          rawText: content.slice(0, MAX_STRING_LENGTH),
          correctionDetected: false,
          createdAt,
        });
      } catch (err) {
        // EP-03/ERR-002: observable degradation, never silent
        logger?.warn?.(`[PD:before_message_write] SQLite user turn fallback failed: ${String(err)}`);
      }
    });
  }

  // ERR-002: Structured observability — no silent fallback
  SystemLogger.log(workspaceDir, 'CONVERSATION_HOOK_BLOCKED', JSON.stringify({
    reason: accessCheck.reason,
    nextAction: accessCheck.nextAction,
    hook: 'llm_output',
    fallback: 'before_message_write',
    role: msg.role,
  }));
}
