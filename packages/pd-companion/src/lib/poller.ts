/**
 * Notification decision logic: approvals polling + update-available polling.
 * Pure functions over validated snapshots — HTTP and timers live in main.
 *
 * Contract (PRI-526):
 *   - First approvals snapshot after launch is a SILENT baseline (existing
 *     pending items do not fire notifications).
 *   - Afterwards, any pending approvalId not yet recorded fires one
 *     notification; a persisted store prevents re-notification across restarts.
 *   - Update-available notifies at most once per version.
 */

export interface ApprovalsSnapshot {
  pendingCount: number;
  approvalIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate a /api/v1/approvals?status=pending response body.
 * Returns undefined on malformed input — callers skip the tick and count a
 * consecutive failure instead of silently treating it as "no approvals".
 */
export function parseApprovalsResponse(body: unknown): ApprovalsSnapshot | undefined {
  if (!isRecord(body) || body.success !== true) return undefined;
  const {data} = body;
  if (!isRecord(data)) return undefined;
  const {items} = data;
  if (!Array.isArray(items)) return undefined;
  const approvalIds: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const {approvalId} = item;
    if (typeof approvalId === 'string' && approvalId.length > 0) {
      approvalIds.push(approvalId);
    }
  }
  const {stats} = data;
  let pendingCount = approvalIds.length;
  if (isRecord(stats) && typeof stats.pending === 'number' && Number.isInteger(stats.pending) && stats.pending >= 0) {
    pendingCount = stats.pending;
  }
  return { pendingCount, approvalIds };
}

export interface PendingDiffInput {
  /** Whether a baseline snapshot has already been recorded for this run. */
  hasBaseline: boolean;
  /** Ids already recorded (baseline + previously notified), persisted across restarts. */
  knownIds: ReadonlySet<string>;
  snapshotIds: string[];
}

export interface PendingDiffResult {
  /** Baseline to record when this is the first snapshot (already-known ids, silent). */
  baselineIds?: string[];
  /** Ids to notify NOW. */
  notifyIds: string[];
}

export function diffPendingApprovals(input: PendingDiffInput): PendingDiffResult {
  if (!input.hasBaseline) {
    return { baselineIds: [...input.snapshotIds], notifyIds: [] };
  }
  const notifyIds = input.snapshotIds.filter((id) => !input.knownIds.has(id));
  return { notifyIds };
}

export interface UpdateCheckInfo {
  hasUpdate: boolean;
  latestVersion?: string;
}

/** Validate a /api/update/check response body. */
export function parseUpdateCheckResponse(body: unknown): UpdateCheckInfo | undefined {
  if (!isRecord(body)) return undefined;
  const {data} = body;
  const source = isRecord(data) ? data : body;
  const {hasUpdate} = source;
  if (typeof hasUpdate !== 'boolean') return undefined;
  const {latestVersion} = source;
  if (latestVersion !== undefined && typeof latestVersion !== 'string') return undefined;
  return { hasUpdate, latestVersion };
}

/** Notify at most once per version (per persisted notifiedUpdateVersions). */
export function shouldNotifyUpdate(notifiedVersions: readonly string[], info: UpdateCheckInfo): boolean {
  if (!info.hasUpdate) return false;
  if (info.latestVersion === undefined) return false;
  return !notifiedVersions.includes(info.latestVersion);
}
