/**
 * Evidence contract for E2E-06. Do not claim the Owner loop passed from
 * unrelated approval and activation rows returned by individually healthy APIs.
 */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

export function expectedChainFromResults(results) {
  if (!Array.isArray(results)) return null;
  const owner = results.find((row) => record(row) && row.step === 'owner-approval' && row.verdict === 'PASS');
  if (!owner) return null;
  if (!nonblank(owner.detail)) throw new Error('owner-approval PASS has no detail to establish expected chain');
  const artifactId = /(?:^|\s)artifact=([^\s)]+)/.exec(owner.detail)?.[1];
  const activationId = /(?:^|\s)activationId=([^\s]+)/.exec(owner.detail)?.[1];
  if (!nonblank(artifactId) || !nonblank(activationId)) {
    throw new Error('owner-approval PASS lacks artifact/activation identity; cannot bind Console E2E to this lab');
  }
  return { artifactId, activationId };
}

export function evaluateConsoleOwnerChain(approvalRows, activationRows, route, expected = {}) {
  const errors = [];
  const approvedPrompts = Array.isArray(approvalRows) ? approvalRows.filter((row) =>
    record(row) && row.status === 'approved' && row.channel === 'prompt' &&
    nonblank(row.approvalId) && nonblank(row.artifactId)) : [];
  const promptActivations = Array.isArray(activationRows) ? activationRows.filter((row) =>
    record(row) && row.channel === 'prompt' && row.action === 'prompt_activate' &&
    nonblank(row.activationId) && nonblank(row.artifactId)) : [];
  if (approvedPrompts.length === 0) errors.push('no approved prompt-channel approval with artifact identity');
  if (promptActivations.length === 0) errors.push('no prompt activation with artifact identity');
  if (!record(route) || route.hostKind !== 'workbuddy') {
    errors.push('response route has no explicit workbuddy host attribution');
  } else if (route.status !== 'confirmed') {
    errors.push('workbuddy delivery route is not confirmed (' + String(route.status) + ')');
  }
  const matches = [];
  for (const approval of approvedPrompts) {
    if (expected.artifactId !== undefined && approval.artifactId !== expected.artifactId) continue;
    for (const activation of promptActivations) {
      if (approval.artifactId !== activation.artifactId) continue;
      if (expected.activationId !== undefined && activation.activationId !== expected.activationId) continue;
      // A matched ID is not enough if activation predates the Owner decision.
      const approvedAt = Date.parse(approval.decidedAt);
      const activatedAt = Date.parse(activation.activatedAt);
      if (!Number.isFinite(approvedAt) || !Number.isFinite(activatedAt) || approvedAt > activatedAt) continue;
      matches.push({ approvalId: approval.approvalId, artifactId: approval.artifactId,
        activationId: activation.activationId, activationStatus: activation.status });
    }
  }
  if (matches.length === 0) errors.push('no same-artifact approved-prompt -> workbuddy-activation pair matches expected chain');
  return { ok: errors.length === 0, errors, matches, approvedPrompts: approvedPrompts.length,
    promptActivations: promptActivations.length, routeStatus: record(route) ? route.status : undefined };
}

