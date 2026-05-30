import { Type, type Static } from '@sinclair/typebox';
import type { PDRuntimeAdapter } from '../runtime-protocol.js';

// ── Schemas ──────────────────────────────────────────────────────────────────

export const EmpathyObserverInputSchema = Type.Object({
  userMessage: Type.String({ minLength: 1 }),
});

export type EmpathyObserverInput = Static<typeof EmpathyObserverInputSchema>;

export const EmpathyObserverOutputV1Schema = Type.Object({
  damageDetected: Type.Boolean(),
  severity: Type.Union([
    Type.Literal('mild'),
    Type.Literal('moderate'),
    Type.Literal('severe'),
  ]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String(),
});

export type EmpathyObserverOutputV1 = Static<typeof EmpathyObserverOutputV1Schema>;

// ── EmpathyObserver ──────────────────────────────────────────────────────────

export interface EmpathyObserverDeps {
  readonly runtimeAdapter: PDRuntimeAdapter;
}

export interface EmpathyObserverOptions {
  readonly timeoutMs?: number;
  readonly agentId?: string;
}

export class EmpathyObserver {
  private readonly runtimeAdapter: PDRuntimeAdapter;
  private readonly timeoutMs: number;
  private readonly agentId: string;

  constructor(deps: EmpathyObserverDeps, options?: EmpathyObserverOptions) {
    this.runtimeAdapter = deps.runtimeAdapter;
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.agentId = options?.agentId ?? 'empathy-observer';
  }

  /**
   * Builds the prompt exactly replicating the legacy empathyObserverWorkflowSpec
   */
  static buildPrompt(userMessage: string): string {
    return [
      'You are an empathy observer.',
      'Analyze ONLY the user message and return strict JSON (no markdown):',
      '{"damageDetected": boolean, "severity": "mild|moderate|severe", "confidence": number, "reason": string}',
      `User message: ${JSON.stringify(userMessage.trim())}`,
    ].join('\n');
  }

  /**
   * Run the simplified one-shot Empathy Observer.
   */
  async run(input: EmpathyObserverInput): Promise<EmpathyObserverOutputV1> {
    const prompt = EmpathyObserver.buildPrompt(input.userMessage);

    // One-shot start run
    const runHandle = await this.runtimeAdapter.startRun({
      agentSpec: { agentId: this.agentId, schemaVersion: 'v1' },
      taskRef: { taskId: `emp_obs_${Date.now()}` },
      inputPayload: prompt,
      contextItems: [],
      outputSchemaRef: 'empathy-observer-output-v1',
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
        throw new Error(`EmpathyObserver run failed: ${status.status} | reason: ${status.reason ?? 'unknown'}`);
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
      throw new Error(`EmpathyObserver run timed out after ${this.timeoutMs}ms${cancelReason}`);
    }

    // Fetch and parse output
    const outputResult = await this.runtimeAdapter.fetchOutput(runHandle.runId);
    if (!outputResult?.payload) {
      throw new Error(`EmpathyObserver run yielded empty output`);
    }

    const payload = outputResult.payload as Record<string, unknown>;

    // Strict runtime schema verification
    if (
      typeof payload.damageDetected !== 'boolean' ||
      !['mild', 'moderate', 'severe'].includes(payload.severity as string) ||
      typeof payload.confidence !== 'number' ||
      payload.confidence < 0 ||
      payload.confidence > 1 ||
      typeof payload.reason !== 'string'
    ) {
      throw new Error(`EmpathyObserver output validation failed: ${JSON.stringify(payload).substring(0, 200)}`);
    }

    return {
      damageDetected: payload.damageDetected,
      severity: payload.severity as 'mild' | 'moderate' | 'severe',
      confidence: payload.confidence,
      reason: payload.reason,
    } satisfies EmpathyObserverOutputV1;
  }
}
