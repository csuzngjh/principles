/**
 * SPEC-PD-PI12-COMPAT-001 Phase 3 — AC-6 B1: Dreamer L2 real-provider E2E.
 *
 * Drives the production L2AgentLoopAdapter (real Pi 1.2 runAgentLoop) against
 * a REAL provider HTTP endpoint (opt-in via LLM_E2E_ENABLED — skipped, at zero
 * cost, whenever the Owner authorization switch is absent). Covers the faux
 * blind spots: system message delivery, single user message, tool declarations
 * and submit_output termination on the actual wire.
 *
 * Budget contract (SPEC §5 AC-6 / Phase 3 task brief §五): ONE full scenario,
 * hard request cap 3, no L2 empty retries, no L1 fallback — a misbehaving run
 * fails loud instead of spending more.
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

import { L2AgentLoopAdapter } from '../l2-agent-loop-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import type { PdL2ArtifactReader, PdL2PrincipleReader } from '../../tools/agent-tool-contract.js';
import { DreamerOutputV1Schema } from '../../internalization/dreamer-output.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { getLlmE2eConfig } from '../../__tests__/fixtures/llm-e2e-config.js';
import { startRecorder } from './pi12-ac6-harness.js';

const config = getLlmE2eConfig();

/** Read-only deps: the scenario must not touch any store or production state. */
const artifactReader: PdL2ArtifactReader = {
  getArtifactById: async () => null,
  listBySourceTaskId: async () => [],
};
const principleReader: PdL2PrincipleReader = {
  listActivePrinciples: async () => [],
};

const SYSTEM_MARKER = 'AC6-B1 DREAMER BASE ROLE LAYER — real provider E2E';
const TASK_ID = 'ac6-dreamer-real-1';

describe.skipIf(!config)('SPEC-PD-PI12-COMPAT-001 AC-6 B1 — Dreamer L2 on real provider', () => {
  it('submit_output full chain: system prompt delivered once, exactly one user message, submit terminates the loop with no extra model calls', async () => {
    const cfg = config;
    if (!cfg) throw new Error('unreachable: describe.skipIf guards config');
    const recorder = startRecorder(3);
    const events: TelemetryEvent[] = [];
    const emitter = new StoreEventEmitter();
    emitter.onTelemetry((event) => {
      events.push(event);
    });

    const adapter = new L2AgentLoopAdapter(
      {
        provider: cfg.provider,
        model: cfg.model,
        apiKeyEnv: cfg.apiKeyEnv,
        baseUrl: cfg.baseUrl,
        maxTurns: 5,
        maxEmptyRetries: 0,
        l2FallbackToL1: false,
        totalBudgetMs: cfg.timeoutMs,
        eventEmitter: emitter,
      },
      { artifactReader, principleReader },
    );

    const input: StartRunInput = {
      agentSpec: { agentId: 'dreamer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      systemPrompt: SYSTEM_MARKER,
      inputPayload:
        `taskId: ${TASK_ID}. Propose exactly ONE principle candidate from this bad decision: ` +
        '"an agent silently skipped a failing verification step to save time". ' +
        'The candidate object MUST carry: candidateIndex 0, badDecision, betterDecision, rationale, ' +
        'confidence (number 0..1), riskLevel ("low"|"medium"|"high"), strategicPerspective. ' +
        'Top level: valid true, the taskId above, candidates with that one entry, ' +
        'contextRefs ["ac6-ref-1"], generatedAt as an ISO timestamp. ' +
        'Call submit_output exactly once with the complete DreamerOutputV1 object.',
      contextItems: [],
      outputSchemaRef: 'dreamer-output-v1',
      timeoutMs: cfg.timeoutMs,
    };

    const startedAtMs = Date.now();
    try {
      const handle = await adapter.startRun(input);
      const output = await adapter.fetchOutput(handle.runId);
      const durationMs = Date.now() - startedAtMs;

      if (!output) throw new Error('ac6-b1: fetchOutput returned null');
      const { payload } = output;
      expect(Value.Check(DreamerOutputV1Schema, payload)).toBe(true);

      // Telemetry: submit-capture termination — no text fallback, no timeout, no L1 fallback.
      const complete = events.find((event) => event.eventType === 'dreamer_l2_complete');
      expect(complete).toBeDefined();
      expect(complete?.payload.usedFallback).toBe(false);
      expect(complete?.payload.timedOut).toBe(false);
      // Turn count tracks finished model turns; HTTP requests may exceed it
      // only if the SDK-level retry path fired (PD keeps maxRetries 0, so this
      // is an invariant check, not an equality pin).
      expect(Number(complete?.payload.turnCount)).toBeLessThanOrEqual(recorder.requests.length);

      // Wire transcript (real HTTP): every request leads with the layered system
      // message; the user task data appears exactly once across the whole run.
      const { requests } = recorder;
      expect(requests.length).toBeGreaterThanOrEqual(1);
      for (const request of requests) {
        expect(request.hasAuthorizationHeader).toBe(true);
        expect(request.messageRoles[0]).toBe('system');
        expect(request.messageRoles.filter((role) => role === 'user')).toHaveLength(1);
      }
      const [first] = requests;
      if (first === undefined) throw new Error('unreachable: requests.length >= 1 asserted');
      expect(first.systemTextPreview).toContain(SYSTEM_MARKER);
      expect(first.systemTextPreview).toContain('--- Tool protocol (L2 mode) ---');
      expect(first.declaredToolNames).toEqual(expect.arrayContaining(['read_principles', 'read_artifact', 'submit_output']));

      console.log(
        '[ac6-b1-summary]',
        JSON.stringify({
          scenario: 'dreamer_l2_submit_output',
          provider: cfg.provider,
          model: cfg.model,
          requests: requests.length,
          hardCap: recorder.maxRequests,
          durationMs,
          tokens: 'not_surfaced_by_dreamer_l2_telemetry',
        }),
      );
    } finally {
      recorder.stop();
    }
  }, 150_000);
});
