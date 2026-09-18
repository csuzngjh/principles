/** Console update presentation: ReleaseManager decides; Installer deploys. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import { sendSuccess, sendMethodNotAllowed, sendNotFound } from '../utils/response.js';
import { appendUpdateHistory } from './update-history.js';
import type * as authorityModule from 'create-principles-disciple/dist/update/release-manager-authority.js';

type AuthorityModule = typeof authorityModule;
type Authority = ReturnType<AuthorityModule['createReleaseManagerAuthority']>;
const REPAIR_ACTION = 'Resolve the reported cause, or run the official installer (npx create-principles-disciple) to repair the installation, then retry.';

function appendGovernedUpdateHistory(workspaceDir: string, entry: Parameters<typeof appendUpdateHistory>[1]): void {
  try {
    appendUpdateHistory(workspaceDir, entry);
  } catch (error) {
    console.error(`[update] ReleaseManager attempt completed WITHOUT an update-history record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkUpdate(authority: Authority, res: ServerResponse): Promise<void> {
  const check = await authority.manager.check(authority.installStatus?.channel ?? 'stable');
  sendSuccess(res, {
    hasUpdate: check.decision.allowed && check.decision.direction !== 'reinstall',
    currentVersion: authority.installStatus?.productVersion ?? 'unknown',
    latestVersion: check.candidate?.productVersion ?? '',
    ...(!check.decision.allowed ? { reason: check.decision.reason, message: check.decision.message } : {}),
  });
}

async function applyFullUpdate(authority: Authority, res: ServerResponse, workspaceDir: string): Promise<void> {
  const fromVersion = authority.installStatus?.productVersion ?? 'unknown';
  const outcome = await authority.manager.apply({ workspaceDir });
  if (outcome.kind === 'applied') {
    appendGovernedUpdateHistory(workspaceDir, {
      fromVersion, toVersion: outcome.productVersion, success: true,
      kind: 'update', authority: 'release-manager', transactionId: outcome.transactionId,
    });
    sendSuccess(res, {
      success: true,
      message: `Updated to ${outcome.productVersion}. Transaction ${outcome.transactionId} confirmed in the journal.`,
      newVersion: outcome.productVersion,
      requiresRestart: true,
      nextAction: 'Restart PD Console to run the updated build.',
      ...(outcome.gatewayNotice ? { gatewayNotice: outcome.gatewayNotice } : {}),
    });
    return;
  }
  appendGovernedUpdateHistory(workspaceDir, {
    fromVersion, toVersion: fromVersion, success: false, kind: 'refusal',
    reason: outcome.note, authority: 'release-manager',
    nextAction: 'No runtime change was made. Retry when a newer signed release is published.',
  });
  sendSuccess(res, { success: true, message: `No update applied: ${outcome.note}`, requiresRestart: false });
}

// eslint-disable-next-line @typescript-eslint/max-params -- Node request/response plus route context
export async function handleUpdateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  if (subPath !== '/check' && subPath !== '/apply-full') {
    sendNotFound(res, `Update route not found: ${subPath}`);
    return;
  }
  if (req.method !== (subPath === '/check' ? 'GET' : 'POST')) {
    sendMethodNotAllowed(res);
    return;
  }
  res.setHeader('X-PD-Mutation-Authority', 'release-manager');
  let mod: AuthorityModule | undefined;
  let authority: Authority | undefined;
  let failure = { reason: 'installer_missing', message: 'ReleaseManager is unavailable.', nextAction: REPAIR_ACTION, transactionOpened: false };
  try {
    mod = await import('create-principles-disciple/dist/update/release-manager-authority.js');
    authority = mod.createReleaseManagerAuthority({
      pdHome: path.join(os.homedir(), '.pd'),
      metadataBaseUrl: process.env.PD_RELEASE_METADATA_URL,
    });
    const readiness = authority.kinds[subPath === '/check' ? 'check' : 'apply-full'];
    if (!readiness.ready || authority.installStatus === null) {
      failure = { ...failure, reason: readiness.reasons.join(',') || 'install_state_corrupt', message: 'The installation is not ready for a signed release update.' };
    } else {
      if (subPath === '/check') await checkUpdate(authority, res);
      else await applyFullUpdate(authority, res, workspaceDir);
      return;
    }
  } catch (error) {
    failure = mod
      ? mod.mapReleaseManagerError(error)
      : { ...failure, message: error instanceof Error ? error.message : String(error) };
  }
  console.error(`[update] ${subPath} refused (${failure.reason}): ${failure.message}`);
  if (subPath === '/check') {
    sendSuccess(res, {
      hasUpdate: false, currentVersion: authority?.installStatus?.productVersion ?? 'unknown', latestVersion: '',
      error: failure.message, reason: failure.reason, nextAction: failure.nextAction,
    });
    return;
  }
  if (failure.transactionOpened) {
    appendGovernedUpdateHistory(workspaceDir, {
      fromVersion: authority?.installStatus?.productVersion ?? 'unknown', toVersion: 'failed',
      success: false, kind: 'failure', authority: 'release-manager',
      reason: failure.reason, nextAction: failure.nextAction,
    });
  }
  sendSuccess(res, { success: false, message: failure.message, reason: failure.reason, nextAction: failure.nextAction, requiresRestart: false });
}
