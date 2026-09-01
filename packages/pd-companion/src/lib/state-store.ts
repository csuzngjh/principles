/**
 * Companion persistent state (userData/companion-state.json).
 * Pure logic; fs persistence lives in the main layer.
 *
 * notifiedApprovalIds acts as both baseline and dedup store: ids present at
 * companion startup are recorded silently (no notification flood), and every
 * notified id is capped at NOTIFIED_IDS_CAP (FIFO) to bound file growth.
 */

export const NOTIFIED_IDS_CAP = 500;

export interface CompanionState {
  notifiedApprovalIds: string[];
  notifiedUpdateVersions: string[];
  firstRunNoticeShown: boolean;
  workspaceOverride?: string;
  /** OS-encrypted Console token ciphertext; plaintext never enters this file. */
  encryptedConsoleToken?: string;
}

export function defaultCompanionState(): CompanionState {
  return { notifiedApprovalIds: [], notifiedUpdateVersions: [], firstRunNoticeShown: false };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // rc-4: validate array ELEMENTS — keep valid strings, drop the rest
  return value.filter((item): item is string => typeof item === 'string');
}

/** Parse untrusted JSON file content (rc-1/rc-4): drop invalid fields, keep valid ones. */
export function parseCompanionState(raw: unknown): CompanionState {
  const state = defaultCompanionState();
  if (typeof raw !== 'object' || raw === null) return state;
  const record = raw as Record<string, unknown>;
  state.notifiedApprovalIds = toStringArray(record.notifiedApprovalIds).slice(-NOTIFIED_IDS_CAP);
  state.notifiedUpdateVersions = toStringArray(record.notifiedUpdateVersions);
  if (record.firstRunNoticeShown === true) {
    state.firstRunNoticeShown = true;
  }
  const workspace = record.workspaceOverride;
  if (typeof workspace === 'string' && workspace.length > 0) {
    state.workspaceOverride = workspace;
  }
  const { encryptedConsoleToken } = record;
  if (typeof encryptedConsoleToken === 'string' && encryptedConsoleToken.length > 0) {
    state.encryptedConsoleToken = encryptedConsoleToken;
  }
  return state;
}

/** Record approval ids as notified; dedupes and enforces the FIFO cap. */
export function markApprovalsNotified(state: CompanionState, ids: string[]): CompanionState {
  if (ids.length === 0) return state;
  const seen = new Set(state.notifiedApprovalIds);
  const merged = [...state.notifiedApprovalIds];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return { ...state, notifiedApprovalIds: merged.slice(-NOTIFIED_IDS_CAP) };
}

/** Record an update version as notified (idempotent). */
export function markUpdateNotified(state: CompanionState, version: string): CompanionState {
  if (state.notifiedUpdateVersions.includes(version)) return state;
  return { ...state, notifiedUpdateVersions: [...state.notifiedUpdateVersions, version] };
}
