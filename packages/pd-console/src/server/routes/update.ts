/** Console update presentation: ReleaseManager decides; Installer deploys. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sendSuccess, sendMethodNotAllowed, sendNotFound } from '../utils/response.js';
import { appendUpdateHistory } from './update-history.js';
import { readCurrentVersion, resolvePluginDir } from '../utils/installed-layout.js';
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
  // PRI-833: derive the active identity from the SAME installStatus snapshot
  // the readiness gate used — no second inspect, no second identity read.
  const { installStatus } = authority;
  const activeIdentity = installStatus !== null
    && typeof installStatus.productVersion === 'string' && installStatus.productVersion.length > 0
    && typeof installStatus.releaseId === 'string' && installStatus.releaseId.length > 0
    && typeof installStatus.generation === 'number' && Number.isSafeInteger(installStatus.generation)
    ? { productVersion: installStatus.productVersion, releaseId: installStatus.releaseId, generation: installStatus.generation }
    : undefined;
  // The plugin-directory copy is read-only (installed-layout P4 authority); a
  // divergence is surfaced, never silently resolved (PR-C contract).
  const pluginVersion = readCurrentVersion(resolvePluginDir(''));
  const identityDivergence = activeIdentity !== undefined && pluginVersion !== undefined && pluginVersion !== activeIdentity.productVersion
    ? { activeVersion: activeIdentity.productVersion, pluginVersion, releaseId: activeIdentity.releaseId, generation: activeIdentity.generation }
    : undefined;
  // PRI-848 (SPEC §12.1): one explicit state per check. A policy refusal is
  // `update_blocked` — the candidate EXISTS but a specific problem must be
  // resolved — never "up to date".
  const decision = check.decision;
  const state = !decision.allowed
    ? 'update_blocked' as const
    : decision.direction === 'reinstall' ? 'up_to_date' as const : 'update_available' as const;
  sendSuccess(res, {
    state,
    hasUpdate: decision.allowed && decision.direction !== 'reinstall',
    currentVersion: installStatus?.productVersion ?? 'unknown',
    latestVersion: check.candidate?.productVersion ?? '',
    ...(activeIdentity !== undefined ? { versionSource: 'active-release' as const } : {}),
    ...(identityDivergence !== undefined ? { identityDivergence } : {}),
    ...(!decision.allowed ? { reason: decision.reason, message: decision.message } : {}),
  });
}

/**
 * PRI-850 (SPEC v0.3 §6.1, ADR-0024 §6): apply is carried by the deployed
 * bootstrap EXECUTOR process, not by this Console process. The route spawns
 * the executor detached, hands it the caller-pinned transaction id, and
 * responds as soon as the transaction journal appears — the update then
 * survives Console death and the page tracks it via the transaction endpoint
 * (SPEC §12.1 continuation contract).
 */
async function applyFullUpdate(authority: Authority, res: ServerResponse, workspaceDir: string): Promise<void> {
  const layout = await import('create-principles-disciple/dist/update/install-layout.js');
  const pdHomePaths = layout.resolvePdHomePaths(path.join(os.homedir(), '.pd'));
  const entryPath = path.join(pdHomePaths.bootstrapExecutorDir, 'dist', 'bootstrap-entry.js');

  // Readiness already re-verified the registration digest, but the route owns
  // the spawn-level guard: no executor file → repair next action (this is the
  // pre-PRI-850 install shape).
  if (!fs.existsSync(entryPath)) {
    appendGovernedUpdateHistory(workspaceDir, {
      fromVersion: authority.installStatus?.productVersion ?? 'unknown',
      toVersion: authority.installStatus?.productVersion ?? 'unknown',
      success: false, kind: 'refusal', authority: 'release-manager',
      reason: 'bootstrap_not_registered',
      nextAction: 'Run the official installer (npx create-principles-disciple repair-update-chain) to deploy the update executor, then retry.',
    });
    sendSuccess(res, {
      success: false,
      refusal: true,
      state: 'update_blocked',
      reason: 'bootstrap_not_registered',
      message: 'The update executor is not deployed on this installation.',
      requiresRestart: false,
      nextAction: 'Run the official installer (npx create-principles-disciple repair-update-chain) to deploy the update executor, then retry.',
    });
    return;
  }

  const fromVersion = authority.installStatus?.productVersion ?? 'unknown';
  const transactionId = `update-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-apply-'));
  const requestFile = path.join(probeDir, 'request.json');
  const resultFile = path.join(probeDir, 'result.json');
  fs.writeFileSync(requestFile, `${JSON.stringify({ op: 'apply', workspaceDir, transactionId })}\n`, 'utf8');

  const journalPath = path.join(pdHomePaths.transactionsDir, `${transactionId}.jsonl`);
  let childError: Error | undefined;
  // Literal executable + argv array, no shell (PRI-569 hardening style). The
  // executor entry is a locally resolved file under ~/.pd/bootstrap.
  const child = spawn('node', [entryPath, '--request-file', requestFile, '--result-file', resultFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (error) => { childError = error; });
  child.unref();

  // The journal is the continuation record: as soon as `planned` lands, the
  // update is officially in flight and this response can return. The window
  // is env-tunable so tests (and slow disks) can adjust it.
  const acceptanceWindowRaw = Number.parseInt(process.env.PD_UPDATE_ACCEPTANCE_WINDOW_MS ?? '', 10);
  const acceptanceWindowMs = Number.isSafeInteger(acceptanceWindowRaw) && acceptanceWindowRaw > 0 ? acceptanceWindowRaw : 20_000;
  const journalDeadline = Date.now() + acceptanceWindowMs;
  while (Date.now() < journalDeadline) {
    if (childError !== undefined) break;
    if (fs.existsSync(journalPath)) {
      sendSuccess(res, {
        success: true,
        state: 'update_in_progress',
        transactionId,
        message: `Update transaction ${transactionId} accepted; the update keeps running even if this console stops.`,
        requiresRestart: false,
        nextAction: 'This page tracks the running update. Do not start another update until it finishes.',
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // No journal: either the spawn failed, or the executor refused pre-journal
  // (e.g. a policy refusal) and wrote its structured result.
  if (fs.existsSync(resultFile)) {
    let parsed: { ok?: boolean; reason?: string; message?: string; nextAction?: string } = {};
    try {
      parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as typeof parsed;
    } catch {
      // keep the empty shape; the message below stays generic
    }
    if (parsed.ok === false) {
      appendGovernedUpdateHistory(workspaceDir, {
        fromVersion, toVersion: fromVersion, success: false, kind: 'refusal',
        reason: parsed.reason ?? 'bootstrap_executor_refused', authority: 'release-manager',
        nextAction: parsed.nextAction ?? 'No runtime change was made. Resolve the reported cause, then retry.',
      });
      sendSuccess(res, {
        success: false,
        refusal: true,
        state: 'update_blocked',
        reason: parsed.reason ?? 'bootstrap_executor_refused',
        message: parsed.message ?? 'The bootstrap executor refused the update.',
        requiresRestart: false,
        nextAction: parsed.nextAction ?? 'No runtime change was made. Resolve the reported cause, then retry.',
      });
      return;
    }
  }
  const reason = childError !== undefined ? 'bootstrap_executor_spawn_failed' : 'bootstrap_executor_unresponsive';
  const detail = childError !== undefined ? childError.message : 'The executor opened no transaction within the acceptance window.';
  appendGovernedUpdateHistory(workspaceDir, {
    fromVersion, toVersion: fromVersion, success: false, kind: 'failure', authority: 'release-manager',
    reason, nextAction: 'No transaction was opened. Inspect ~/.pd/logs and retry.',
  });
  sendSuccess(res, {
    success: false,
    state: 'check_failed',
    reason,
    message: detail,
    requiresRestart: false,
    nextAction: 'No transaction was opened. Inspect ~/.pd/logs and retry.',
  });
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
    // SPEC §12.1: a check that cannot complete is check_failed — it must never
    // masquerade as "no new version" (hasUpdate:false alone would do that).
    sendSuccess(res, {
      state: 'check_failed',
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
