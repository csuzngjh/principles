/**
 * SPEC-PD-PI12-COMPAT-001 Phase 3 — AC-6 B2: Artificer L2 real-provider E2E.
 *
 * Drives the production ArtificerL2Adapter (real Pi 1.2 runAgentLoop) against
 * a REAL provider HTTP endpoint (opt-in via LLM_E2E_ENABLED — skipped, at zero
 * cost, whenever the Owner authorization switch is absent). The治理 chain is
 * the REAL production chain, not test doubles:
 *
 *   - read_rulecode_spec / validate_rulecode come from the adapter's own
 *     tool contract (spec text + static validation);
 *   - replay_rulecode runs through createProductionGateDeps() — the canonical
 *     production vm-sandbox gate (forbidden patterns → return-shape check →
 *     hardened vm evaluation against the golden trace);
 *   - submit_rulecode validates through the real DefaultArtificerValidator
 *     before the capture, so a bypassing submission fails loud (C4).
 *
 * The adapter holds all run state in memory and writes no store, RuleCode, or
 * activation record — the scenario cannot reach production state by
 * construction.
 *
 * Budget contract: ONE full scenario, hard request cap 6, budget timer =
 * 2× provider timeout. Artificer has no L1 fallback by design (PRI-439); a run
 * that cannot submit fails loud instead of spending more.
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

import { ArtificerL2Adapter } from '../artificer-l2-adapter.js';
import type { StartRunInput } from '../../runtime-protocol.js';
import { ArtificerRuleOutputSchema, DefaultArtificerValidator } from '../../internalization/artificer-output.js';
import { createProductionGateDeps } from '../../activation/production-gate-deps.js';
import type { TelemetryEvent } from '../../../telemetry-event.js';
import { StoreEventEmitter } from '../../store/event-emitter.js';
import { getLlmE2eConfig } from '../../__tests__/fixtures/llm-e2e-config.js';
import { startRecorder } from './pi12-ac6-harness.js';

const config = getLlmE2eConfig();

const TASK_ID = 'ac6-artificer-real-1';

const TASK_INSTRUCTION =
  `taskId: ${TASK_ID}. sourceScribeArtifactId: "pi-art-ac6-scribe-001". ` +
  'Write a RuleCode that BLOCKS every write-tool call (tool "edit") targeting a system path ' +
  '(path starting with "/etc/") and ALLOWS everything else. ' +
  'Golden trace to satisfy: ' +
  '[{"caseId":"ac6-neg-1","kind":"negative","toolName":"edit","params":{"path":"/etc/passwd"},"expectedDecision":"block"},' +
  '{"caseId":"ac6-pos-1","kind":"positive","toolName":"read","params":{"path":"/tmp/notes.txt"},"expectedDecision":"allow"}]. ' +
  'affectedTools: ["edit"]. implementationSummary: a one-line summary. risks: []. ' +
  'Process requirement: call read_rulecode_spec FIRST, then validate_rulecode on your draft, ' +
  'then replay_rulecode with the golden trace above, and only then submit_rulecode with the complete ArtificerRuleOutput.';

describe.skipIf(!config)('SPEC-PD-PI12-COMPAT-001 AC-6 B2 — Artificer L2 on real provider', () => {
  it('read spec → validate → replay → submit full chain through the REAL validator/production sandbox; no bypass, no L1 fallback', async () => {
    const cfg = config;
    if (!cfg) throw new Error('unreachable: describe.skipIf guards config');
    const recorder = startRecorder(6);
    const events: TelemetryEvent[] = [];
    const emitter = new StoreEventEmitter();
    emitter.onTelemetry((event) => {
      events.push(event);
    });

    const adapter = new ArtificerL2Adapter({
      provider: cfg.provider,
      model: cfg.model,
      apiKeyEnv: cfg.apiKeyEnv,
      baseUrl: cfg.baseUrl,
      gateDeps: createProductionGateDeps(),
      validator: new DefaultArtificerValidator(),
      maxTurns: 8,
      totalBudgetMs: 2 * cfg.timeoutMs,
      reasoning: cfg.reasoning,
      eventEmitter: emitter,
    });

    const input: StartRunInput = {
      agentSpec: { agentId: 'artificer', schemaVersion: 'v1' },
      taskRef: { taskId: TASK_ID },
      inputPayload: TASK_INSTRUCTION,
      contextItems: [],
      outputSchemaRef: 'artificer-rule-output-v2',
      timeoutMs: cfg.timeoutMs,
    };

    const startedAtMs = Date.now();
    try {
      const handle = await adapter.startRun(input);
      const output = await adapter.fetchOutput(handle.runId);
      const durationMs = Date.now() - startedAtMs;

      if (!output) throw new Error('ac6-b2: fetchOutput returned null');
      const { payload } = output;
      expect(Value.Check(ArtificerRuleOutputSchema, payload)).toBe(true);

      // Full tool journey on the wire — the model ran the real治理 chain, and
      // submit_rulecode could only capture after DefaultArtificerValidator passed.
      const toolEvents = events
        .filter((event) => event.eventType === 'artificer_l2_turn')
        .map((event) => (event.payload as { toolName?: string }).toolName)
        .filter((toolName): toolName is string => toolName !== undefined);
      expect(toolEvents).toEqual(expect.arrayContaining([
        'read_rulecode_spec',
        'validate_rulecode',
        'replay_rulecode',
        'submit_rulecode',
      ]));

      // Complete telemetry with the PRI-795 evidence block: real elapsed time,
      // budget, and token usage surfaced by the production adapter.
      const complete = events.find((event) => event.eventType === 'artificer_l2_complete');
      expect(complete).toBeDefined();
      const { evidence } = complete?.payload as { evidence?: Record<string, unknown> };
      expect(evidence).toBeDefined();
      expect(typeof evidence?.elapsedMs).toBe('number');

      // Wire transcript (real HTTP): system-first, exactly one user message,
      // every request inside the hard cap.
      const { requests } = recorder;
      expect(requests.length).toBeGreaterThanOrEqual(1);
      for (const request of requests) {
        expect(request.hasAuthorizationHeader).toBe(true);
        expect(request.messageRoles[0]).toBe('system');
        expect(request.messageRoles.filter((role) => role === 'user')).toHaveLength(1);
      }

      console.log(
        '[ac6-b2-summary]',
        JSON.stringify({
          scenario: 'artificer_l2_validate_replay_submit',
          provider: cfg.provider,
          model: cfg.model,
          requests: requests.length,
          hardCap: recorder.maxRequests,
          durationMs,
          tokenUsage: evidence?.tokenUsage,
          toolsInvoked: toolEvents,
        }),
      );
    } finally {
      recorder.stop();
    }
  }, 300_000);
});
