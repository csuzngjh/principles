/**
 * WorkBuddyHooksHostAdapter — implements HostAdapter for WorkBuddy
 * (ADR-0020 third host, SPEC workbuddy-host-adapter §4.2).
 *
 * WorkBuddy executes plugin hooks as command subprocesses through Git Bash
 * (probe P05), writing the event payload as JSON on stdin and consuming a
 * JSON hookSpecificOutput document on stdout. This adapter owns:
 *   1. Decoding the raw stdin JSON into a unified HostEvent (codec/input-decoder).
 *   2. Encoding a unified HostEventResult into the whitelisted stdout JSON —
 *      or into EMPTY stdout for neutral results, because the host injects any
 *      raw stdout text into model-visible context (codec/output-encoder).
 *
 * The adapter does NOT own hook business logic (injection, gate enforcement,
 * pain evidence). Those run in the shared host-runtime production path and
 * are invoked by pd-hook.ts between decodeEvent() and encodeOutput().
 *
 * MVP scope (SPEC §0 four-event baseline): PreToolUse, PostToolUse,
 * UserPromptSubmit, SessionStart. PostToolUseFailure decodes onto the same
 * after_tool_call path but is NOT registered in the shipped hooks.json
 * (OD-02/P03: ordinary tool failures already reach PostToolUse).
 *
 * Feature flag: when host.workbuddy is disabled (quiet, default OFF), the
 * process entry short-circuits to EMPTY stdout + exit 0 with an observable
 * skip record BEFORE this adapter dispatches anything (rc-9).
 */
import type {
  HostAdapter,
  HostEvent,
  HostEventKind,
  HostEventResult,
} from '@principles/core/host';
import { decodeWorkbuddyInput, encodeWorkbuddyOutput } from './codec/index.js';

const SUBSCRIBED_EVENTS: readonly HostEventKind[] = [
  'before_tool_call',
  'after_tool_call',
  'before_prompt_build',
  'session_start',
];

export class WorkBuddyHooksHostAdapter implements HostAdapter {
  readonly hostId = 'workbuddy';
  readonly hostKind = 'subprocess' as const;

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  subscribedEvents(): readonly HostEventKind[] {
    return SUBSCRIBED_EVENTS;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  decodeEvent(raw: unknown): HostEvent {
    return decodeWorkbuddyInput(raw);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  encodeOutput(result: HostEventResult, kind: HostEventKind): unknown {
    return encodeWorkbuddyOutput(result, kind);
  }
}
