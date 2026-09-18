/**
 * Owner Decision Experience v1 — canonical Owner-facing read endpoints
 * (SPEC §15). Read-only: the Owner decision projection never mutates; the
 * approval/activation mutation services remain the final write authority.
 *
 *   GET /api/v1/principles/owner-decision-inbox      (static; dispatch before /:id)
 *   GET /api/v1/principles/:id/owner-decision-view
 *
 * Both ride the existing `principle_governance_projection_v2` flag (no new
 * runtime flag, SPEC §16) and reuse the route family's auth/workspace
 * isolation. Security (SPEC §15/§31): fixed error messages never echo the
 * requested id or target back to the caller.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { OwnerDecisionViewModel } from '../models/OwnerDecisionViewModel.js';
import { GovernanceProjectionCollectionError } from '../models/GovernanceProjectionCollector.js';
import { sendSuccess, sendError } from '../utils/response.js';

export interface OwnerDecisionRouteParams {
  req: IncomingMessage;
  res: ServerResponse;
  workspaceDir: string;
  featureFlags?: Record<string, { enabled: boolean }>;
  now: () => string;
}

function featureDisabled(res: ServerResponse): void {
  sendError(res, 403, 'feature_disabled',
    'Owner decision projection is disabled.',
    { reason: 'feature_disabled', nextAction: 'Enable features.principle_governance_projection_v2 in .pd/config.yaml.' });
}

/** GET /api/v1/principles/owner-decision-inbox */
export async function handleOwnerDecisionInboxRoute(params: OwnerDecisionRouteParams): Promise<void> {
  const { res, workspaceDir, featureFlags, now } = params;
  if (featureFlags?.principle_governance_projection_v2?.enabled !== true) {
    featureDisabled(res);
    return;
  }
  try {
    const inbox = await new OwnerDecisionViewModel(workspaceDir).getInbox(now());
    sendSuccess(res, inbox);
  } catch (error: unknown) {
    sendError(res, 500, 'owner_decision_inbox_error', error instanceof Error ? error.message : String(error), { nextAction: 'inspect_runtime_state' });
  }
}

/**
 * Parses `/:id/owner-decision-view` sub paths. Returns the decoded principle
 * id, or null when the sub path is not this route (caller continues routing),
 * or 'invalid' when the id cannot be URL-decoded.
 */
export function parseOwnerDecisionViewSubPath(subPath: string): string | null | 'invalid' {
  const segments = subPath.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2 || segments[1] !== 'owner-decision-view') return null;
  const raw = segments[0] ?? '';
  try {
    const decoded = decodeURIComponent(raw);
    return decoded.length === 0 ? 'invalid' : decoded;
  } catch {
    return 'invalid';
  }
}

/**
 * GET /api/v1/principles/:id/owner-decision-view.
 * Returns false when the sub path does not match (caller continues routing).
 */
export async function handleOwnerDecisionViewRoute(params: OwnerDecisionRouteParams & { subPath: string }): Promise<boolean> {
  const { res, workspaceDir, featureFlags, now, subPath } = params;
  const principleId = parseOwnerDecisionViewSubPath(subPath);
  if (principleId === null) return false;
  if (featureFlags?.principle_governance_projection_v2?.enabled !== true) {
    featureDisabled(res);
    return true;
  }
  if (principleId === 'invalid') {
    sendError(res, 400, 'invalid_principle_id', 'Principle ID is missing or has invalid URL encoding', { nextAction: 'Provide a non-empty, correctly encoded principle ID.' });
    return true;
  }
  try {
    const view = await new OwnerDecisionViewModel(workspaceDir).getView(principleId, now());
    sendSuccess(res, view);
  } catch (error: unknown) {
    if (error instanceof GovernanceProjectionCollectionError && error.reasonCode === 'principle_not_found') {
      sendError(res, 404, 'principle_not_found', 'Principle not found', { nextAction: 'Check the principle ID.' });
      return true;
    }
    if (error instanceof Error && error.message === 'principle_not_found') {
      sendError(res, 404, 'principle_not_found', 'Principle not found', { nextAction: 'Check the principle ID.' });
      return true;
    }
    sendError(res, 500, 'owner_decision_view_error', error instanceof Error ? error.message : String(error), { nextAction: 'inspect_runtime_state' });
  }
  return true;
}
