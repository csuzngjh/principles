import { Type, type Static } from '@sinclair/typebox';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const CorrectionObserverPayloadSchema = Type.Object({
  parentSessionId: Type.String(),
  workspaceDir: Type.String(),
  keywordStoreSummary: Type.Object({
    totalKeywords: Type.Number(),
    terms: Type.Array(Type.Object({
      term: Type.String(),
      weight: Type.Number(),
      hitCount: Type.Number(),
      truePositiveCount: Type.Number(),
      falsePositiveCount: Type.Number(),
    })),
  }),
  recentMessages: Type.Array(Type.String()),
  trajectoryHistory: Type.Array(Type.Object({
    sessionId: Type.String(),
    timestamp: Type.String(),
    term: Type.String(),
    userMessage: Type.String(),
  })),
});

export type CorrectionObserverPayload = Static<typeof CorrectionObserverPayloadSchema>;

export const CorrectionObserverOutputV1Schema = Type.Object({
  updated: Type.Boolean(),
  updates: Type.Optional(Type.Record(Type.String(), Type.Object({
    action: Type.Union([Type.Literal('add'), Type.Literal('update'), Type.Literal('remove')]),
    weight: Type.Optional(Type.Number()),
    falsePositiveRate: Type.Optional(Type.Number()),
    reasoning: Type.String(),
  }))),
  fpTerms: Type.Optional(Type.Array(Type.String())),
  fpAnalysisStatus: Type.Optional(Type.Union([Type.Literal('completed'), Type.Literal('skipped')])),
  summary: Type.String(),
});

export type CorrectionObserverOutputV1 = Static<typeof CorrectionObserverOutputV1Schema>;

// ── CorrectionObserver ─────────────────────────────────────────────────────────

export interface CorrectionObserverDeps {
  readonly runtimeAdapter: PDRuntimeAdapter;
}

export interface CorrectionObserverOptions {
  readonly timeoutMs?: number;
  readonly agentId?: string;
}

export class CorrectionObserver {
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly timeoutMs: number;
  private readonly agentId: string;

  constructor(deps: CorrectionObserverDeps, options?: CorrectionObserverOptions) {
    this.runtimeAdapter = deps.runtimeAdapter;
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.agentId = options?.agentId ?? 'correction-observer';
  }

  /**
   * Replicates prompt construction from correctionObserverWorkflowSpec
   */
  static buildPrompt(payload: CorrectionObserverPayload): string {
    const { keywordStoreSummary, recentMessages, trajectoryHistory } = payload;
    const MAX_TRAJECTORY_MESSAGE_LENGTH = 80;

    const termsList = keywordStoreSummary.terms
      .map(t => `  - term="${t.term}", weight=${t.weight}, hits=${t.hitCount}, TP=${t.truePositiveCount}, FP=${t.falsePositiveCount}`)
      .join('\n');

    const messages = recentMessages.length > 0
      ? recentMessages.map(m => `  - ${JSON.stringify(m)}`).join('\n')
      : '  (none)';

    const trajectory = trajectoryHistory.length > 0
      ? trajectoryHistory.map(t => `  - [${t.sessionId}] ${t.term} (${t.timestamp}): ${t.userMessage.substring(0, MAX_TRAJECTORY_MESSAGE_LENGTH)}`)
        .join('\n')
      : '  (none)';

    return [
      'You are a correction keyword optimizer.',
      '',
      '## TASK',
      'Analyze the current correction keyword store and recent user messages.',
      'Recommend ADD/UPDATE/REMOVE actions to improve correction cue accuracy.',
      'Also identify terms that triggered false positives (correctionDetected fired but user message doesn\'t indicate actual frustration).',
      '',
      '## Current Keyword Store (' + keywordStoreSummary.totalKeywords + ' terms):',
      termsList,
      '',
      '## Recent User Messages (' + recentMessages.length + ' messages):',
      messages,
      '',
      '## Correction Trajectory (recent confirmed corrections, D-40-08):',
      trajectory,
      '',
      '## Rules:',
      '- ADD: If a correction pattern is detected in messages but not in store',
      '- UPDATE: If a term\'s weight should change based on TP/FP ratio',
      '- REMOVE: If a term has 0 hits after many uses AND high false positive rate (>0.3)',
      '- FALSE POSITIVE: If a term appears in trajectory but the user message doesn\'t actually express frustration (e.g., user said "wrong" but in a factual context, not emotional)',
      '- fpAnalysisStatus: set to "completed" if you performed trajectory analysis (even if no FPs found), or "skipped" if trajectory was empty/unavailable',
      '- Keep reasoning concise (max 100 chars)',
      '- Weight range: 0.1-0.9',
      '',
      'Return strict JSON (no markdown):',
      '{"updated": boolean, "updates": {...}, "fpTerms": ["term1", ...], "fpAnalysisStatus": "completed" | "skipped", "summary": string}',
      'Note: fpTerms is optional — only include if you identified clear false positives.',
    ].join('\n');
  }

  /**
   * Run the simplified one-shot Correction Observer.
   */
  async run(input: CorrectionObserverPayload): Promise<CorrectionObserverOutputV1> {
    const prompt = CorrectionObserver.buildPrompt(input);

    // One-shot start run
    const runHandle = await this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: `corr_obs_${Date.now()}` },
      inputPayload: prompt,
      contextItems: [],
      outputSchemaRef: 'correction-observer-output-v1',
      timeoutMs: this.timeoutMs,
    });

    // Poll until terminal
    const deadline = Date.now() + this.timeoutMs;
    const pollIntervalMs = 500;
    let terminal = false;

    while (Date.now() < deadline) {
      const status = await this.runtimeAdapter.pollRun(runHandle.runId);
      if (status.status === 'succeeded') {
        terminal = true;
        break;
      }
      if (status.status === 'failed' || status.status === 'timed_out' || status.status === 'cancelled') {
        throw new Error(`CorrectionObserver run failed: ${status.status} | reason: ${status.reason ?? 'unknown'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    if (!terminal) {
      let cancelReason = '';
      try {
        await this.runtimeAdapter.cancelRun(runHandle.runId);
      } catch (cancelErr) {
        cancelReason = ` | cancelFailed: ${String(cancelErr)}`;
      }
      throw new Error(`CorrectionObserver run timed out after ${this.timeoutMs}ms${cancelReason}`);
    }

    // Fetch and parse output
    const outputResult = await this.runtimeAdapter.fetchOutput(runHandle.runId);
    if (!outputResult?.payload) {
      throw new Error(`CorrectionObserver run yielded empty output`);
    }

    const payload = outputResult.payload as Record<string, unknown>;

    // Strict runtime schema verification
    const VALID_ACTIONS = new Set(['add', 'update', 'remove']);

    if (
      typeof payload.updated !== 'boolean' ||
      typeof payload.summary !== 'string'
    ) {
      throw new Error(`CorrectionObserver output validation failed: ${JSON.stringify(payload).substring(0, 200)}`);
    }

    if (payload.updates !== undefined && payload.updates !== null) {
      if (typeof payload.updates !== 'object' || Array.isArray(payload.updates)) {
        throw new Error(`CorrectionObserver output validation failed: updates must be a record, got ${typeof payload.updates}`);
      }
      for (const [key, val] of Object.entries(payload.updates as Record<string, unknown>)) {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          throw new Error(`CorrectionObserver output validation failed: updates["${key}"] must be an object, got ${typeof val}`);
        }
        const entry = val as Record<string, unknown>;
        if (!VALID_ACTIONS.has(entry.action as string)) {
          throw new Error(`CorrectionObserver output validation failed: updates["${key}"].action must be add|update|remove, got "${String(entry.action)}"`);
        }
        if (typeof entry.reasoning !== 'string') {
          throw new Error(`CorrectionObserver output validation failed: updates["${key}"].reasoning must be a string, got ${typeof entry.reasoning}`);
        }
      }
    }

    if (payload.fpTerms !== undefined && payload.fpTerms !== null) {
      if (!Array.isArray(payload.fpTerms)) {
        throw new Error(`CorrectionObserver output validation failed: fpTerms must be an array, got ${typeof payload.fpTerms}`);
      }
      for (let i = 0; i < payload.fpTerms.length; i++) {
        if (typeof payload.fpTerms[i] !== 'string') {
          throw new Error(`CorrectionObserver output validation failed: fpTerms[${i}] must be a string, got ${typeof payload.fpTerms[i]}`);
        }
      }
    }

    if (payload.fpAnalysisStatus !== undefined && payload.fpAnalysisStatus !== null) {
      if (payload.fpAnalysisStatus !== 'completed' && payload.fpAnalysisStatus !== 'skipped') {
        throw new Error(`CorrectionObserver output validation failed: fpAnalysisStatus must be completed|skipped, got "${String(payload.fpAnalysisStatus)}"`);
      }
    }

    return payload as CorrectionObserverOutputV1;
  }
}
