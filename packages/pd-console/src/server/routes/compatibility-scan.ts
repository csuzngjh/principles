/**
 * 5B-F — GET /api/runtime/compatibility-scan (read-only).
 *
 * Surfaces the SAME scan the installer preflight and `pd runtime
 * compatibility-scan` use, reduced to reason-granular counts + samples (see
 * `shared/compatibility-scan-contract.ts`). The scanner already holds the
 * workspace DB connection semantics (`readonly`), so this route adds no
 * runtime dependency — it reuses @principles/core/runtime in process.
 *
 * No mutation: the handler only constructs the read model and maps its result.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ActivationCompatibilityReadModel } from '@principles/core/runtime';
import type { ActivationCompatibilityScanResult } from '@principles/core/runtime';
import type { CompatibilityScanViewData } from '../../shared/compatibility-scan-contract.js';
import { sendSuccess, sendError, sendMethodNotAllowed, errorMessage } from '../utils/response.js';

/** Injectable seam so the route mapping is testable without seeding SQLite. */
export type CompatibilityScanner = (workspaceDir: string) => ActivationCompatibilityScanResult;

const defaultScanner: CompatibilityScanner = workspaceDir =>
  new ActivationCompatibilityReadModel({ workspaceDir }).scan();

export function toCompatibilityScanView(result: ActivationCompatibilityScanResult): CompatibilityScanViewData {
  return {
    status: result.status,
    scannedActivations: result.scannedActivations,
    unscannable: result.skipped.map(({ reason, count, sampleActivationIds }) => ({
      reason,
      count,
      sampleActivationIds: [...sampleActivationIds],
    })),
    findingsTotal: result.findings.length,
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.nextAction !== undefined ? { nextAction: result.nextAction } : {}),
  };
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleCompatibilityScanRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  scan: CompatibilityScanner = defaultScanner,
): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }
  try {
    sendSuccess(res, toCompatibilityScanView(scan(workspaceDir)));
  } catch (error) {
    // rc-9: a scan that throws is observable, not an empty list.
    sendError(res, 500, 'compatibility_scan_failed', errorMessage(error), {
      reason: 'compatibility_scan_failed',
    });
  }
}
