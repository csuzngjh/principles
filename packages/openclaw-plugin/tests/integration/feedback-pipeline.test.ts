/**
 * Task 15: End-to-end integration test for the feedback pipeline observability.
 *
 * Verifies the full chain that the spec calls out as the MVP observability
 * story for failed peer-runner tasks:
 *   1. peer runner permanent failure → pending_agent_drafts row written
 *      (here simulated by calling store.insertPendingDraft directly, which is
 *      exactly what BasePeerRunner.injectAgentDraftOnPermanentFailure does on
 *      the production permanent-failure path — see Task 12).
 *   2. createFeedbackReport(input with top-level taskId) → report.agentDraft
 *      merged from the store and non-empty.
 *   3. renderReportMarkdown → "Agent draft" + "Diagnostic summary" +
 *      "Context references" sections all present AND non-empty (not just
 *      heading lines).
 *
 * Uses a REAL SqliteConnection (temp-file SQLite, no mocks) so the schema
 * bootstrap, PendingAgentDraftStore I/O, and the report orchestrator are
 * exercised end-to-end across the core/plugin boundary.
 *
 * ERR checklist (per AGENTS.md Error Handbook Gate):
 * - EP-01 / ERR-001, ERR-005, ERR-013: store return values narrowed via the
 *   `unwrap` helper + typeof checks. No `as` casts on data read back from
 *   SQLite (rc-1, rc-2). Test-input object literals are trusted fixtures, not
 *   untrusted runtime data — `as const` is used only for literal narrowing,
 *   mirroring the existing create-report-agent-draft.test.ts pattern.
 * - EP-03 / ERR-002, rc-9: if createFeedbackReport fails, the structured
 *   `errors` array is surfaced in the assertion message rather than silently
 *   passing. No silent fallback in the test path.
 * - EP-03 / ERR-009, ERR-010, rc-3: context.source must be a valid
 *   FeedbackSource ('console' | 'cli' | 'agent'); the spec's
 *   'failed_tasks_page' would fail validation, so it is carried via
 *   context.page instead.
 *
 * @see packages/principles-core/src/runtime-v2/feedback/pending-agent-draft-store.ts
 * @see packages/principles-core/src/runtime-v2/feedback/create-report.ts
 * @see packages/principles-core/src/runtime-v2/feedback/render-markdown.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  PendingAgentDraftStore,
  createFeedbackReport,
  renderReportMarkdown,
  type AgentDraftPayload,
  type FeedbackReport,
} from '@principles/core/runtime-v2/feedback';
import { safeRmDir } from '../test-utils.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Narrow `T | null | undefined` to `T`. Replaces `x!.prop` (forbidden by
 * @typescript-eslint/no-non-null-assertion) with type-safe access. The throw
 * branch is unreachable after a preceding `expect(x).not.toBeNull()`, but
 * TypeScript needs it for control-flow narrowing. Mirrors the helper in
 * base-peer-runner-agent-draft.test.ts.
 */
function unwrap<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('unwrap: value is null/undefined');
  }
  return value;
}

/**
 * Extract the body of a `## <heading>` section from a markdown string.
 * Returns the lines between the heading and the next `## ` heading (or EOF),
 * trimmed. Returns '' if the heading is not found. Used to assert that a
 * section's content is non-empty (not just a bare heading line).
 */
function extractSectionBody(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const bodyLines: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === `## ${heading}`) {
      inSection = true;
      continue;
    }
    // The next `## ` heading (any level-2 heading) ends this section.
    // `###` sub-headings are part of the current section's body.
    if (inSection && line.startsWith('## ')) {
      break;
    }
    if (inSection) {
      bodyLines.push(line);
    }
  }
  return bodyLines.join('\n').trim();
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const TASK_ID = 'tsk-e2e-001';
const PAIN_ID = 'pain-e2e-001';

/**
 * The agent draft that BasePeerRunner would construct on a permanent
 * diagnostician failure. Strings are deliberately free of paths/tokens/env
 * values so redaction is a no-op and the assertions can use exact equality
 * (matches the pattern in create-report-agent-draft.test.ts).
 */
const agentDraftFixture: AgentDraftPayload = {
  summary: 'Diagnostician failed with category=runtime_unavailable at 2026-07-04T10:00:00.000Z',
  observedFailure: 'Error: LLM provider timeout\n    at DiagnosticianPeerRunner.run',
  commandSummary: 'last run: 3 tool calls, final error in diagnostician step',
};

const diagnostics = {
  versions: { pd: '1.0.0', node: '20.10.0' },
  platform: { os: 'darwin', arch: 'arm64' },
  featureFlags: { failed_tasks_observability: { enabled: true } },
  canary: { status: 'available', summary: 'all systems go' },
  recentEvents: [
    {
      type: 'task_failed',
      at: '2026-07-04T10:00:00.000Z',
      severity: 'error',
      summary: 'Diagnostician task tsk-e2e-001 failed',
    },
  ],
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Task 15: feedback pipeline E2E', () => {
  let tmpDir: string;
  let connection: SqliteConnection;
  let store: PendingAgentDraftStore;

  beforeEach(() => {
    tmpDir = createTempDir('pd-e2e-feedback-');
    connection = new SqliteConnection(tmpDir);
    // Touch getDb() so initSchema() runs (creates pending_agent_drafts table).
    connection.getDb();
    store = new PendingAgentDraftStore(connection);
  });

  afterEach(() => {
    try {
      connection?.close();
    } catch {
      // best-effort close
    }
    safeRmDir(tmpDir);
  });

  it('peer runner permanent failure → pending_agent_drafts → createFeedbackReport → report.agentDraft non-empty', () => {
    // Step 1–4: simulate peer runner permanent failure by inserting the
    // agentDraft into the store (production path:
    // BasePeerRunner.injectAgentDraftOnPermanentFailure → store.insertPendingDraft).
    const insertResult = store.insertPendingDraft({
      taskId: TASK_ID,
      painId: PAIN_ID,
      agentDraft: agentDraftFixture,
    });
    expect(insertResult.ok).toBe(true);

    // Step 5: verify the store holds exactly one unconsumed draft for this task.
    const beforeRow = store.getUnconsumedByTaskId(TASK_ID);
    expect(beforeRow).not.toBeNull();
    // rc-1: defensively narrow the store return before asserting on its fields.
    const beforeDraft = unwrap(beforeRow).agentDraft;
    expect(typeof beforeDraft.summary).toBe('string');
    expect(beforeDraft.summary).toBe(agentDraftFixture.summary);
    expect(beforeDraft.observedFailure).toBe(agentDraftFixture.observedFailure);
    expect(beforeDraft.commandSummary).toBe(agentDraftFixture.commandSummary);

    // Step 6: build the feedback input. Top-level taskId triggers agentDraft merge.
    // NOTE: context.source must be a valid FeedbackSource ('console' | 'cli' | 'agent');
    // 'failed_tasks_page' is carried via context.page instead (rc-3 fail-loud on
    // invalid input — an invalid source would make createFeedbackReport return errors).
    const input = {
      type: 'bug' as const,
      title: 'Diagnostician task failed with runtime_unavailable',
      description: 'The diagnostician peer runner failed after 3 attempts. See agent draft for details.',
      stepsToReproduce: '1. Trigger a pain signal\n2. Wait for diagnostician to run\n3. Observe failure',
      expectedBehavior: 'Diagnostician should complete successfully',
      actualBehavior: 'Diagnostician fails with runtime_unavailable',
      userSeverity: 'high' as const,
      context: {
        source: 'console' as const,
        page: 'failed_tasks_page',
        painId: PAIN_ID,
        taskId: TASK_ID,
      },
      taskId: TASK_ID, // top-level taskId triggers agentDraft merge
    };

    // Step 8: create the report (maintainer email optional but exercised here).
    const result = createFeedbackReport(input, diagnostics, 'csuzngjh@hotmail.com', store);

    // Step 9: rc-9 — if creation failed, surface the structured errors instead
    // of silently passing. Fail loud with the validation reasons.
    if (!result.ok) {
      const reasons = result.errors.map((e) => `${e.field}: ${e.reason}`).join('; ');
      throw new Error(`createFeedbackReport failed unexpectedly: ${reasons}`);
    }
    expect(result.ok).toBe(true);

    // Step 10: report.agentDraft must be non-empty and match the store draft.
    const report: FeedbackReport = result.report;
    expect(report.agentDraft).toBeDefined();
    const ad = unwrap(report.agentDraft);
    expect(ad.summary).toBe(agentDraftFixture.summary);
    expect(ad.observedFailure).toBe(agentDraftFixture.observedFailure);
    expect(ad.commandSummary).toBe(agentDraftFixture.commandSummary);

    // Step 11: store draft must be consumed (markConsumed called by
    // createFeedbackReport on the success path).
    expect(store.getUnconsumedByTaskId(TASK_ID)).toBeNull();

    // Step 12: render the report to markdown.
    const markdown = renderReportMarkdown(report);

    // Step 13–16: assert the three key sections are present AND non-empty
    // (content beyond the heading line).
    const agentDraftBody = extractSectionBody(markdown, 'Agent draft');
    expect(agentDraftBody.length).toBeGreaterThan(0);
    expect(agentDraftBody).toContain(agentDraftFixture.summary);
    expect(agentDraftBody).toContain('Observed failure:');
    expect(agentDraftBody).toContain('Command:');

    const diagBody = extractSectionBody(markdown, 'Diagnostic summary');
    expect(diagBody.length).toBeGreaterThan(0);
    expect(diagBody).toContain('### Versions');
    expect(diagBody).toContain('### Platform');
    expect(diagBody).toContain('### Feature flags');
    expect(diagBody).toContain('### Canary');
    // recentEvents entry survives into markdown
    expect(diagBody).toContain('task_failed');
    expect(diagBody).toContain('Diagnostician task tsk-e2e-001 failed');

    const ctxBody = extractSectionBody(markdown, 'Context references');
    expect(ctxBody.length).toBeGreaterThan(0);
    // Context refs include source, page, painId, taskId, and the agentDraft marker.
    expect(ctxBody).toContain(TASK_ID);
    expect(ctxBody).toContain(PAIN_ID);
    expect(ctxBody).toContain('failed_tasks_page');
    expect(ctxBody).toContain('agentDraft');
  });

  it('user-provided agentDraft takes priority over store draft (store draft still consumed)', () => {
    // Insert a store draft — its summary should NOT be used because the user
    // attached their own agentDraft.
    const insertResult = store.insertPendingDraft({
      taskId: TASK_ID,
      painId: PAIN_ID,
      agentDraft: agentDraftFixture,
    });
    expect(insertResult.ok).toBe(true);

    const userDraft = {
      summary: 'User-provided diagnostic summary (overrides agent draft)',
      observedFailure: 'User-provided observed failure description',
    };

    const input = {
      type: 'bug' as const,
      title: 'Diagnostician task failed — user-reported',
      description: 'User attached their own agent draft; store draft should be superseded but still consumed.',
      context: {
        source: 'console' as const,
        page: 'failed_tasks_page',
        painId: PAIN_ID,
        taskId: TASK_ID,
      },
      taskId: TASK_ID,
      agentDraft: userDraft,
    };

    const result = createFeedbackReport(input, diagnostics, undefined, store);

    // rc-9: surface validation errors instead of silently passing.
    if (!result.ok) {
      const reasons = result.errors.map((e) => `${e.field}: ${e.reason}`).join('; ');
      throw new Error(`createFeedbackReport failed unexpectedly: ${reasons}`);
    }
    expect(result.ok).toBe(true);

    const report = result.report;
    expect(report.agentDraft).toBeDefined();
    const ad = unwrap(report.agentDraft);
    // User-provided summary wins over the store draft.
    expect(ad.summary).toBe(userDraft.summary);
    expect(ad.observedFailure).toBe(userDraft.observedFailure);
    // commandSummary was NOT in the user draft; the store draft's commandSummary
    // must NOT leak through (user draft fully replaces, not merges, the store draft).
    expect(ad.commandSummary).toBeUndefined();

    // rc-9 / spec: the store draft is still markConsumed even when superseded
    // by a user-provided draft — the pending row must not linger.
    expect(store.getUnconsumedByTaskId(TASK_ID)).toBeNull();

    // Sanity: the markdown Agent draft section reflects the USER's draft, not the store's.
    const markdown = renderReportMarkdown(report);
    const agentDraftBody = extractSectionBody(markdown, 'Agent draft');
    expect(agentDraftBody.length).toBeGreaterThan(0);
    expect(agentDraftBody).toContain(userDraft.summary);
    expect(agentDraftBody).not.toContain(agentDraftFixture.summary);
  });
});
