/**
 * Consent-ledger-backed source-material authorization — PRI-1283 R2.
 *
 * THE implementation of `@principles/core`'s `SourceMaterialAuthorizationPort`
 * for the real product. It answers ONE question, per call, against the
 * conversation-ingestion consent ledger v3 (the single authority,
 * conversation-ingestion/consent.ts):
 *
 *   "is host H's conversation material readable RIGHT NOW?"
 *
 * Decision table (uniform, fail-closed):
 *
 *   ledger read       | decision     | authorization
 *   ------------------|--------------|------------------------------------
 *   granted           | —            | authorized
 *   revoked           | —            | blocked (consent_revoked)
 *   pending / failed  | —            | blocked (consent_not_granted)
 *   no record         | —            | blocked (consent_missing) — no
 *                     |              | authority says this material may be
 *                     |              | read; legitimate ingestion never ran
 *                     |              | without a granted record (SPEC §8.2)
 *   unreadable file   | —            | blocked (consent_unreadable) — a
 *                     |              | malformed ledger fails loud, never
 *                     |              | "never asked" (consent.ts posture)
 *
 * Every call re-reads the ledger — there is deliberately NO cache: a
 * revocation recorded between two reads must take effect on the next read
 * (R2: "缓存命中时撤回 → 不得返回旧缓存内容"). Reading one small JSON file
 * per check is the price of correctness; consumers gate once per assembly /
 * model call, not per row.
 */

import { readConversationIngestionConsent } from './conversation-ingestion/consent.js';
import type {
  SourceAuthorizationState,
  SourceMaterialAuthorizationPort,
  SourceMaterialHostKind,
  SourceMaterialDenialReason,
} from '@principles/core/runtime';

export type { SourceAuthorizationState, SourceMaterialAuthorizationPort, SourceMaterialHostKind };

export interface ReadSourceMaterialAuthorizationInput {
  readonly workspaceDir: string;
  readonly hostKind: SourceMaterialHostKind;
}

export type SourceMaterialAuthorizationResult =
  | { readonly status: 'authorized' }
  | { readonly status: 'blocked'; readonly reason: SourceMaterialDenialReason; readonly detail?: string };

/** Full-result read for health surfaces, tests and the sweep. */
export function readSourceMaterialAuthorization(input: ReadSourceMaterialAuthorizationInput): SourceMaterialAuthorizationResult {
  const { workspaceDir, hostKind } = input;
  const read = readConversationIngestionConsent(workspaceDir, hostKind);
  if (!read.ok) {
    return { status: 'blocked', reason: 'consent_unreadable', detail: `${read.reason}; ${read.nextAction}` };
  }
  const { record } = read;
  if (record === null) {
    return { status: 'blocked', reason: 'consent_missing', detail: `no conversation-ingestion consent record for host '${hostKind}' in this workspace` };
  }
  if (record.decision === 'granted') {
    return { status: 'authorized' };
  }
  if (record.decision === 'revoked') {
    return { status: 'blocked', reason: 'consent_revoked', detail: `consent revoked at ${record.decidedAt}` };
  }
  return { status: 'blocked', reason: 'consent_not_granted', detail: `consent decision '${record.decision}' (decidedAt ${record.decidedAt})` };
}

/**
 * Build the port bound to one workspace. Cheap to construct; every call
 * performs a live ledger read. Inject at composition roots (CLI commands,
 * workers, console models, MCP assembly) wherever governance-sourced material
 * is consumed.
 */
export function createConsentLedgerSourceMaterialAuthorization(workspaceDir: string): SourceMaterialAuthorizationPort {
  return {
    isHostSourceMaterialAuthorized(hostKind: SourceMaterialHostKind): SourceAuthorizationState {
      const result = readSourceMaterialAuthorization({ workspaceDir, hostKind });
      if (result.status === 'authorized') return { authorized: true };
      return { authorized: false, reason: result.reason, ...(result.detail !== undefined ? { detail: result.detail } : {}) };
    },
  };
}
