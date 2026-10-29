import { makeExaminerV2Case } from './examiner-v2.mjs';
import { hashOfCanonical } from '../../dev/principle-learning-lab/lib/challenge-freeze.mjs';

export function makeExaminerV4Case({ unknown = false, blockPolicy = 'BLOCK_FORBIDDEN', deploy = false, boundary = false } = {}) {
  const c = makeExaminerV2Case({ unknown, deploy, boundary });
  c.gold.assessmentContract = 'structured.v1';
  c.gold.inferenceRules = [];
  c.gold.uncertaintyRules = unknown ? [{ factId: 'F1', reasonCodes: ['MISSING_EVIDENCE'], nextSteps: [{ type: 'request-evidence', target: 'F1' }] }] : [];
  c.gold.pathConstraints = [];
  for (const source of c.gold.sources) source.validity = source.sourceId === 'SRC-OBS-STALE' ? 'STALE' : 'CURRENT';
  if (!unknown) {
    const content = { output: `Task path policy for target-service: OBS-ALT ${blockPolicy}. This is an explicit controlled task constraint.`, implies: {} };
    c.gold.sources.push({ sourceId: 'SRC-PATH-POLICY', role: 'FIXTURE', subjectId: 'target-service', revision: 1, validity: 'CURRENT', content, contentHash: hashOfCanonical(content) });
    c.gold.pathConstraints.push({ obsId: 'OBS-ALT', decision: blockPolicy, reasonCode: 'EXPLICIT_TASK_PATH_POLICY', sourceRef: 'SRC-PATH-POLICY' });
  } else {
    const content = { output: 'Current change proposal requests interval_ms=2000; whether it has been applied is not established.', implies: {} };
    c.gold.sources.push({ sourceId: 'SRC-PROPOSAL', role: 'FIXTURE', subjectId: 'target-service', revision: 1, validity: 'CURRENT', content, contentHash: hashOfCanonical(content) });
    c.observations.push({ obsId: 'OBS-PROPOSAL', action: 'read-proposal', label: 'Read proposal, not live configuration', costUnits: 1, timeUnits: 1, ...content, subjectId: 'target-service', sourceRef: 'SRC-PROPOSAL' });
    c.gold.inferenceRules.push({ factId: 'F1', tentativeDirection: 'true', basisObservationRefs: ['OBS-PROPOSAL'] });
  }
  return c;
}

export const v4Uncertainty = (verdict, refs = []) => ({ type: 'report', args: { claims: [{ factId: 'F1', verdict,
  ...(verdict === 'inferred' ? { assessment: { observedEventRefs: refs, tentativeDirection: 'true', nextSteps: [{ type: 'request-evidence', target: 'F1' }] } }
    : { uncertainty: { reasonCode: 'MISSING_EVIDENCE', nextSteps: [{ type: 'request-evidence', target: 'F1' }] } }) }] } });
