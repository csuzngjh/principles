/**
 * CodexHooksHostAdapter — implements HostAdapter for OpenAI Codex CLI (ADR-0020 §2.5)
 *
 * Codex CLI spawns `pd-hook.js` as a subprocess for each hook event, writes
 * the event payload as JSON on stdin, and reads the output as JSON on stdout.
 * This adapter owns:
 *   1. Decoding the raw stdin JSON into a unified HostEvent (via codec/input-decoder).
 *   2. Encoding a unified HostEventResult into Codex's camelCase stdout JSON
 *      (via codec/output-encoder).
 *
 * The adapter does NOT own hook business logic (pain detection, principle
 * injection, gate enforcement). Those run in the openclaw-plugin/core code and
 * are invoked by `pd-hook.js` after decodeEvent() and before encodeOutput().
 *
 * MVP scope (ADR-0014 / ADR-0020):
 * - Subscribes to 4 events: before_tool_call, after_tool_call, before_prompt_build, session_start.
 * - session_end is deferred (observe-only, no MVP-Core activation path uses it).
 * - hostKind = 'subprocess' (Codex spawns pd-hook.js; OpenClaw is 'inprocess').
 *
 * Feature flag: when `host.codex.enabled = false` (default), `pd-hook.js`
 * short-circuits to `{} + exit 0` before invoking this adapter (rc-9).
 */
import type {
  HostAdapter,
  HostEvent,
  HostEventKind,
  HostEventResult,
} from '@principles/core/host';
import { decodeCodexInput, encodeCodexOutput } from './codec/index.js';

const SUBSCRIBED_EVENTS: readonly HostEventKind[] = [
  'before_tool_call',
  'after_tool_call',
  'before_prompt_build',
  'session_start',
  // Stop = turn_complete is the G1-verified turn-complete event (probe
  // report §2); it drives bounded governance-observation ingestion, not a
  // dispatch route. session_end stays deferred (SPEC §8: never register both
  // Stop and SessionEnd for turn completion).
  'turn_complete',
];

export class CodexHooksHostAdapter implements HostAdapter {
  readonly hostId = 'codex';
  readonly hostKind = 'subprocess' as const;

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  subscribedEvents(): readonly HostEventKind[] {
    return SUBSCRIBED_EVENTS;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  decodeEvent(raw: unknown): HostEvent {
    return decodeCodexInput(raw);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  encodeOutput(result: HostEventResult, kind: HostEventKind): unknown {
    return encodeCodexOutput(result, kind);
  }
}
