// Offline, deterministic statistics over an explicitly scoped opportunity set.
// Re-run the existing verifier; never accept a caller-supplied D or verdict.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical } from './lib/challenge-freeze.mjs';
import { adaptiveConfigIdentity } from './lib/adaptive-config-identity.mjs';
import { verifyAdaptiveDelivery } from './verify-adaptive-delivery.mjs';
import { summarizeAdaptiveCoverage } from './lib/adaptive-activation-coverage.mjs';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function summarizeAdaptiveStudy(input, trust) {
  if (!input || input.schemaVersion !== 'aa-coverage-input.v1' || !nonEmpty(input.windowId)
    || !nonEmpty(input.workspaceId) || !Array.isArray(input.opportunities)
    || !['complete', 'sample', 'unknown'].includes(input.enumeration)) throw new Error('invalid_study');
  const identity = adaptiveConfigIdentity(input.config);
  if (!identity || !trust || !Array.isArray(trust.sources)) throw new Error('invalid_study_scope');
  const records = input.opportunities.map((opportunity) => {
    if (!opportunity || !Array.isArray(opportunity.checks)
      || (opportunity.opportunityId !== null && !nonEmpty(opportunity.sessionId))) throw new Error('invalid_opportunity');
    const checks = opportunity.checks.map((check) => {
      const expected = check?.expected;
      const checkIdentity = adaptiveConfigIdentity(expected?.config);
      if (!expected || expected.workspaceId !== input.workspaceId || expected.sessionId !== opportunity.sessionId
        || !checkIdentity || checkIdentity.digest !== identity.digest) throw new Error('check_scope_mismatch');
      return {
        hookInvocationId: expected.hookInvocationId,
        inputDigest: hashOfCanonical(check),
        result: verifyAdaptiveDelivery(check, trust),
      };
    });
    // Opportunity keys are scoped to workspace and session, independent of
    // callback count. Missing identity stays missing; do not mint one from text.
    const opportunityId = opportunity.opportunityId === null ? null
      : JSON.stringify([input.workspaceId, opportunity.sessionId, opportunity.opportunityId]);
    if (opportunity.opportunityId !== null && !nonEmpty(opportunity.opportunityId)) throw new Error('invalid_opportunity_id');
    return { opportunityId, classification: opportunity.classification,
      classificationReferences: opportunity.classificationReferences, sameText: opportunity.sameText, checks };
  });
  const summary = summarizeAdaptiveCoverage(records, { enumeration: input.enumeration });
  return {
    windowId: input.windowId,
    configIdentity: identity.digest,
    configurationCoverage: identity.coverage,
    ...summary,
    behavioralImprovement: 'not_evaluated',
    conclusionScope: input.enumeration === 'sample' ? 'sample_only' : 'declared_window_only',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!['--input', '--trust'].includes(key) || !process.argv[i + 1] || Object.hasOwn(args, key)) {
        throw new Error('invalid_arguments');
      }
      args[key] = process.argv[i + 1];
    }
    if (!args['--input'] || !args['--trust']
      || fs.realpathSync(args['--input']) === fs.realpathSync(args['--trust'])) throw new Error('separate_trust_required');
    const input = JSON.parse(fs.readFileSync(args['--input'], 'utf8'));
    const trust = JSON.parse(fs.readFileSync(args['--trust'], 'utf8'));
    console.log(JSON.stringify({ ok: true, ...summarizeAdaptiveStudy(input, trust) }));
  } catch {
    console.log(JSON.stringify({ ok: false, reason: 'coverage_input_invalid',
      nextAction: '核对窗口、配置、机会身份、分类引用和独立证据清单。' }));
    process.exitCode = 1;
  }
}
