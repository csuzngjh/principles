/**
 * Bootstrap process protocol (SPEC §6.1) — strict single-JSON-object in,
 * strict single-JSON-object out.
 *
 * Companion, Console, and the installer speak to the bootstrap through this
 * one protocol. The transport layer (stdin/stdout around this pure handler)
 * stays thin so the contract itself is testable: exactly one parseable JSON
 * object per direction, stable reason codes, and a next action on every
 * failure (rc-9, cli-1 semantics applied to the protocol boundary).
 */

import type { ReleaseChannelName } from './product-identity.js';
import { isReleaseChannelName } from './product-identity.js';
import type { ReleaseManager} from './release-manager.js';
import { ReleaseManagerError } from './release-manager.js';

export type BootstrapRequestOp = 'inspect' | 'check' | 'apply' | 'rollback';

export type BootstrapRequest =
  | { readonly op: 'inspect' }
  | { readonly op: 'check'; readonly channel: ReleaseChannelName }
  | { readonly op: 'apply'; readonly releaseId: string }
  | { readonly op: 'rollback' };

export interface BootstrapOkResponse {
  readonly ok: true;
  readonly result: unknown;
}

export interface BootstrapFailureResponse {
  readonly ok: false;
  readonly reason: string;
  readonly message: string;
  readonly nextAction: string;
}

export type BootstrapResponse = BootstrapOkResponse | BootstrapFailureResponse;

export class BootstrapProtocolError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'BootstrapProtocolError';
    this.reason = reason;
  }
}

/**
 * Parses exactly ONE JSON object from the raw request text. Trailing data,
 * non-objects, arrays, and unknown/missing fields are hard errors — a
 * protocol peer that emits garbage gets a structured refusal, never a
 * best-effort guess.
 */
export function parseBootstrapRequest(raw: string): BootstrapRequest {
  const text = raw.trim();
  if (text.length === 0) {
    throw new BootstrapProtocolError('protocol_empty_request', 'The bootstrap request body is empty.');
  }
  if (!text.startsWith('{') || !text.endsWith('}')) {
    throw new BootstrapProtocolError('protocol_not_single_object', 'The bootstrap request must be exactly one JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BootstrapProtocolError('protocol_invalid_json', `The bootstrap request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BootstrapProtocolError('protocol_not_single_object', 'The bootstrap request must be exactly one JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (!Object.hasOwn(record, 'op')) {
    throw new BootstrapProtocolError('protocol_missing_op', 'The bootstrap request is missing the required "op" field.');
  }
  const {op} = record;
  const knownOps: readonly BootstrapRequestOp[] = ['inspect', 'check', 'apply', 'rollback'];
  if (typeof op !== 'string' || !knownOps.includes(op as BootstrapRequestOp)) {
    throw new BootstrapProtocolError('protocol_unknown_op', `Unknown bootstrap op: ${JSON.stringify(op)}. Supported: ${knownOps.join(', ')}.`);
  }
  const allowedFields = op === 'check'
    ? new Set(['op', 'channel'])
    : op === 'apply'
      ? new Set(['op', 'releaseId'])
      : new Set(['op']);
  const extraFields = Object.keys(record).filter((key) => !allowedFields.has(key));
  if (extraFields.length > 0) {
    throw new BootstrapProtocolError('protocol_unknown_field', `Unknown bootstrap request fields: ${extraFields.join(', ')}`);
  }
  if (op === 'check') {
    if (!Object.hasOwn(record, 'channel')) {
      throw new BootstrapProtocolError('protocol_missing_channel', 'A check request requires the "channel" field.');
    }
    if (!isReleaseChannelName(record.channel)) {
      throw new BootstrapProtocolError('protocol_invalid_channel', `channel must be "stable" or "candidate", got: ${JSON.stringify(record.channel)}`);
    }
    return { op, channel: record.channel };
  }
  if (op === 'apply') {
    if (!Object.hasOwn(record, 'releaseId')) {
      throw new BootstrapProtocolError('protocol_missing_release_id', 'An apply request requires the "releaseId" field.');
    }
    if (typeof record.releaseId !== 'string' || record.releaseId.length === 0) {
      throw new BootstrapProtocolError('protocol_invalid_release_id', `releaseId must be a non-empty string, got: ${JSON.stringify(record.releaseId)}`);
    }
    return { op, releaseId: record.releaseId };
  }
  return op === 'rollback' ? { op: 'rollback' } : { op: 'inspect' };
}

/** Serializes exactly one JSON object for stdout (no banners, no extra text). */
export function serializeBootstrapResponse(response: BootstrapResponse): string {
  return `${JSON.stringify(response)}\n`;
}

/**
 * Dispatches a parsed request against a ReleaseManager and produces the
 * protocol response. Manager failures become structured refusals — the
 * protocol never leaks stack traces into the response object.
 */
export async function handleBootstrapRequest(
  request: BootstrapRequest,
  manager: ReleaseManager,
): Promise<BootstrapResponse> {
  try {
    switch (request.op) {
      case 'inspect':
        return { ok: true, result: await Promise.resolve(manager.inspect()) };
      case 'check':
        return { ok: true, result: await manager.check(request.channel) };
      case 'apply':
        // PRI-698 Phase 1: apply() is the real write orchestrator now and
        // requires a caller deployment context (workspaceDir) the bootstrap
        // wire contract does not carry. This protocol surface has no
        // production transport and never served apply (it previously refused
        // with `shadow_mode_read_only`); returning a structured refusal keeps
        // that parity without inventing protocol fields for a consumer that
        // does not exist yet (P7). Extend the wire contract with the real
        // first consumer.
        return {
          ok: false,
          reason: 'apply_not_supported_over_bootstrap_protocol',
          message: 'The bootstrap protocol does not carry the deployment context ReleaseManager.apply() requires.',
          nextAction: 'Trigger updates through the Console update surface, which supplies the deployment context.',
        };
      case 'rollback':
        await manager.rollback();
        return { ok: true, result: { rolledBack: true } };
    }
  } catch (error) {
    if (error instanceof ReleaseManagerError) {
      return {
        ok: false,
        reason: error.reason,
        message: error.message,
        nextAction: error.nextAction,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: 'internal_error',
      message,
      nextAction: 'Retry the operation; if it fails again, collect the bootstrap log from ~/.pd/logs and report it.',
    };
  }
  // Exhaustive switch guard — reaching here is a programming error.
  return {
    ok: false,
    reason: 'internal_error',
    message: 'unhandled bootstrap request',
    nextAction: 'Report this protocol violation.',
  };
}
