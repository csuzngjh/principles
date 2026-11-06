/**
 * SPEC-PD-PI12-COMPAT-001 Phase 3 — AC-6 B3: One-shot json_schema real-provider E2E.
 *
 * Drives the production PiAiRuntimeAdapter (real compat completeSimple) against
 * a REAL provider HTTP endpoint (opt-in via LLM_E2E_ENABLED — skipped, at zero
 * cost, whenever the Owner authorization switch is absent).
 *
 * `outputPathStrategy: 'json_mode_first'` (an existing production strategy —
 * workflow-funnel-loader) deterministically selects the PRI-559 json_schema
 * path: onPayload rewrites the wire payload to
 * `response_format: { type: 'json_schema', … }` inside the provider's HTTP
 * adapter — exactly the surface the faux provider cannot exercise (audit R1).
 * The wire recorder proves the rewrite actually reached the request.
 *
 * Budget contract: ONE full scenario, hard request cap 3 (json path + bounded
 * free-form repair), in-library maxRetries 0 (PD owns retries and we disable
 * even the self-managed extra attempt here).
 */
import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { FetchFunction } from '@earendil-works/pi-ai';

vi.mock('../pi-ai-http-transport.js', async (importActual) => {
  const actual: Record<string, unknown> = await importActual();
  const harness = await import('./pi12-ac6-harness.js');
  return {
    ...actual,
    getPiAiFetchForApi: harness.wrapGetPiAiFetchForApi(actual.getPiAiFetchForApi as (api: string | undefined) => FetchFunction),
  };
});

import { PiAiRuntimeAdapter } from '../pi-ai-runtime-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import { DiagnosticianOutputV1Schema } from '../../diagnostician-output.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { getLlmE2eConfig } from '../../__tests__/fixtures/llm-e2e-config.js';
import { startRecorder } from './pi12-ac6-harness.js';

const config = getLlmE2eConfig();

const TASK_ID = 'ac6-oneshot-real-1';

describe.skipIf(!config)('SPEC-PD-PI12-COMPAT-001 AC-6 B3 — One-shot json_schema on real provider', () => {
  it('onPayload json_schema rewrite reaches the real wire; output validates; success telemetry fires', async () => {
    const cfg = config;
    if (!cfg) throw new Error('unreachable: describe.skipIf guards config');
    const recorder = startRecorder(3);
    const events: TelemetryEvent[] = [];
    const emitter = new StoreEventEmitter();
    emitter.onTelemetry((event) => {
      events.push(event);
    });

    const adapter = new PiAiRuntimeAdapter({
      provider: cfg.provider,
      model: cfg.model,
      apiKeyEnv: cfg.apiKeyEnv,
      baseUrl: cfg.baseUrl,
      maxRetries: 0,
      maxTokens: 1024,
      maxRepairAttempts: 0,
      timeoutMs: cfg.timeoutMs,
      outputPathStrategy: 'json_mode_first',
      reasoning: cfg.reasoning,
      eventEmitter: emitter,
    });

    const input: StartRunInput = {
      agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload:
        'Diagnose this pain signal: "an AI agent repeatedly skipped its verification step when running low on time, ' +
        'causing three escaped defects in one week". ' +
        'Use diagnosisId "ac6-diag-1", rootCause prefixed with "Assumption: ", ' +
        'and exactly one recommendation { kind: "defer", description: "..." }. ' +
        'violatedPrinciples and evidence may be empty arrays. confidence between 0 and 1.',
      contextItems: [],
      outputSchemaRef: 'diagnostician-output-v1',
      timeoutMs: cfg.timeoutMs,
    };

    const startedAtMs = Date.now();
    try {
      const handle = await adapter.startRun(input);
      const output = await adapter.fetchOutput(handle.runId);
      const durationMs = Date.now() - startedAtMs;

      if (!output) throw new Error('ac6-b3: fetchOutput returned null');
      const { payload } = output;
      expect(Value.Check(DiagnosticianOutputV1Schema, payload)).toBe(true);

      // The json_schema rewrite actually reached the real HTTP request.
      const { requests } = recorder;
      expect(requests.length).toBeGreaterThanOrEqual(1);
      const jsonRequest = requests.find((request) => request.responseFormat !== undefined);
      expect(jsonRequest).toBeDefined();
      if (jsonRequest === undefined) throw new Error('unreachable: jsonRequest asserted defined');
      const { responseFormat } = jsonRequest as { responseFormat: { type?: unknown; json_schema?: unknown } };
      expect(responseFormat.type).toBe('json_schema');
      expect(responseFormat.json_schema).toBeTypeOf('object');
      expect(jsonRequest.hasAuthorizationHeader).toBe(true);
      expect(jsonRequest.messageRoles[0]).toBe('system');
      expect(jsonRequest.messageRoles.filter((role) => role === 'user')).toHaveLength(1);
      expect(jsonRequest.declaredToolNames).toHaveLength(0);

      // Success telemetry on the real path.
      const eventTypes = events.map((event) => event.eventType);
      expect(eventTypes).toContain('runtime_invocation_succeeded');

      console.log(
        '[ac6-b3-summary]',
        JSON.stringify({
          scenario: 'oneshot_json_schema',
          provider: cfg.provider,
          model: cfg.model,
          requests: requests.length,
          hardCap: recorder.maxRequests,
          durationMs,
          tokens: 'not_surfaced_by_pi_ai_adapter_telemetry',
        }),
      );
    } finally {
      recorder.stop();
    }
  }, 150_000);
});
