/**
 * Self-check for the Phase 0 Spike fixtures (task 1.1).
 *
 * Three things are proven here, because a fixture that is merely "type-correct"
 * is not enough to base a go/no-go gate on:
 *
 *   1. Lineage consistency (rc-6 / ERR-004 / ERR-008) — every hop's lineage
 *      field points at the previous hop's actual artifact id, and the checker
 *      itself is shown to catch a deliberately corrupted chain (otherwise the
 *      green assertion would be vacuous — ERR-088).
 *   2. Shape authenticity — every hop's `contentJson` passes the stage's REAL
 *      production validator, so the fixtures cannot drift into invented fields.
 *   3. Defect authenticity — chain A drops only `riskLevel`, chain B drops only
 *      the concrete actions, the control chain keeps both, and all three share
 *      byte-identical upstream content. A detector that answers "missing" for
 *      every input fails on the control chain.
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §12 Phase 0
 * @see Requirement 12.2
 */

import { describe, it, expect } from 'vitest';

import { DefaultDiagRootCauseValidator } from '../../diagnostician/diag-rootcause-output.js';
import { DefaultDiagDistillerValidator } from '../../diagnostician/diag-distiller-output.js';
import { DefaultDiagnosticianValidator } from '../../runner/default-validator.js';
import { DefaultDreamerValidator } from '../dreamer-output.js';
import { DefaultPhilosopherValidator } from '../philosopher-output.js';
import { DefaultScribeValidator } from '../scribe-output.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import { DefaultEvaluatorValidator, isEvaluatorOutputV2 } from '../evaluator-output.js';

import {
  ABSTRACTED_PHRASE,
  CONCRETE_ACTIONS,
  DREAMER_RISK_LEVEL,
  SPIKE_CHAINS,
  SPIKE_CHAIN_CONTROL,
  SPIKE_CHAIN_DEFECT_A,
  SPIKE_CHAIN_DEFECT_B,
  SPIKE_STAGE_ORDER,
  findSpikeLineageViolations,
  spikeChainHops,
  type SpikeChain,
} from './progressive-disclosure-spike-fixtures.js';

/** Every text surface of the scribe principle draft, joined. */
function scribePrincipleText(chain: SpikeChain): string {
  const draft = chain.scribe.contentJson.principleDraft;
  return [draft.title, draft.statement, draft.rationale, ...draft.applicability, ...draft.antiPatterns].join('\n');
}

/** Does the principle text carry any risk-level signal at all? */
function mentionsRiskLevel(text: string): boolean {
  return text.includes(DREAMER_RISK_LEVEL) || text.includes('风险');
}

/** How many of dreamer's three concrete actions survive in the text? */
function survivingConcreteActions(text: string): readonly string[] {
  return CONCRETE_ACTIONS.filter((action) => text.includes(action));
}

describe('progressive-disclosure Spike fixtures', () => {
  describe('chain topology', () => {
    it('every chain starts at diag_rootcause and runs through all 8 stages', () => {
      for (const chain of SPIKE_CHAINS) {
        const stages = spikeChainHops(chain).map((hop) => hop.stage);
        expect(stages, chain.chainId).toEqual(SPIKE_STAGE_ORDER);
        expect(chain.diagRootCause.edgePredecessorArtifactId, chain.chainId).toBeNull();
      }
    });

    it('exposes exactly the two defect chains plus one control chain', () => {
      expect(SPIKE_CHAINS.map((c) => c.chainId)).toEqual([
        'defect_a_risk_level_dropped',
        'defect_b_action_abstracted',
        'control_no_defect',
      ]);
      expect(SPIKE_CHAIN_CONTROL.expectedDefect).toEqual({ kind: 'none' });
    });
  });

  describe('lineage consistency (rc-6)', () => {
    it('reports zero violations for all three chains', () => {
      for (const chain of SPIKE_CHAINS) {
        expect(findSpikeLineageViolations(chain), chain.chainId).toEqual([]);
      }
    });

    it('catches a lineage field pointing at the wrong artifact', () => {
      const broken: SpikeChain = {
        ...SPIKE_CHAIN_CONTROL,
        philosopher: {
          ...SPIKE_CHAIN_CONTROL.philosopher,
          contentJson: {
            ...SPIKE_CHAIN_CONTROL.philosopher.contentJson,
            sourceDreamerArtifactId: 'pi-art-some-other-dreamer',
          },
        },
      };

      const violations = findSpikeLineageViolations(broken);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        chainId: 'control_no_defect',
        stage: 'philosopher',
        field: 'sourceDreamerArtifactId',
        expected: SPIKE_CHAIN_CONTROL.dreamer.artifactId,
        actual: 'pi-art-some-other-dreamer',
      });
    });

    it('catches diag_router naming rootcause instead of distiller as its edge predecessor (F17)', () => {
      const broken: SpikeChain = {
        ...SPIKE_CHAIN_CONTROL,
        diagRouter: {
          ...SPIKE_CHAIN_CONTROL.diagRouter,
          // rootcause IS loaded by diag_router, but the task-graph edge is
          // distiller → router. Naming the other loaded artifact is the exact
          // mistake CP-35 guards against.
          edgePredecessorArtifactId: SPIKE_CHAIN_CONTROL.diagRootCause.artifactId,
        },
      };

      const violations = findSpikeLineageViolations(broken);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.stage).toBe('diag_router');
      expect(violations[0]?.field).toBe('edgePredecessorArtifactId');
      expect(violations[0]?.expected).toBe(SPIKE_CHAIN_CONTROL.diagDistiller.artifactId);
    });

    it('catches a diag_router that rewrote Stage A rootCause', () => {
      const broken: SpikeChain = {
        ...SPIKE_CHAIN_CONTROL,
        diagRouter: {
          ...SPIKE_CHAIN_CONTROL.diagRouter,
          contentJson: {
            ...SPIKE_CHAIN_CONTROL.diagRouter.contentJson,
            rootCause: 'Design: 换了个说法的根因',
          },
        },
      };

      const violations = findSpikeLineageViolations(broken);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.field).toBe('rootCause');
    });
  });

  describe('shape authenticity — real production validators accept every hop', () => {
    it.each(SPIKE_CHAINS.map((chain) => [chain.chainId, chain] as const))(
      '%s passes every stage validator',
      async (_chainId, chain) => {
        const rootCause = await new DefaultDiagRootCauseValidator().validate(
          chain.diagRootCause.contentJson,
          chain.diagRootCause.taskId,
        );
        expect(rootCause.errors).toEqual([]);
        expect(rootCause.valid).toBe(true);

        const distiller = await new DefaultDiagDistillerValidator().validate(
          chain.diagDistiller.contentJson,
          chain.diagDistiller.taskId,
        );
        expect(distiller.errors).toEqual([]);
        expect(distiller.valid).toBe(true);

        const router = await new DefaultDiagnosticianValidator().validate(
          chain.diagRouter.contentJson,
          chain.diagRouter.taskId,
          { verbose: true },
        );
        expect(router.errors).toEqual([]);
        expect(router.valid).toBe(true);

        const dreamer = await new DefaultDreamerValidator().validate(
          chain.dreamer.contentJson,
          chain.dreamer.taskId,
        );
        expect(dreamer.errors).toEqual([]);
        expect(dreamer.valid).toBe(true);

        const philosopher = await new DefaultPhilosopherValidator().validate(
          chain.philosopher.contentJson,
          chain.philosopher.taskId,
        );
        expect(philosopher.errors).toEqual([]);
        expect(philosopher.valid).toBe(true);

        const scribe = await new DefaultScribeValidator().validate(
          chain.scribe.contentJson,
          chain.scribe.taskId,
          chain.philosopher.artifactId,
        );
        expect(scribe.errors).toEqual([]);
        expect(scribe.valid).toBe(true);

        const artificer = await new DefaultArtificerValidator().validate(
          chain.artificer.contentJson,
          chain.artificer.taskId,
          chain.scribe.artifactId,
        );
        expect(artificer.errors).toEqual([]);
        expect(artificer.valid).toBe(true);

        const evaluator = await new DefaultEvaluatorValidator().validate(
          chain.evaluator.contentJson,
          chain.evaluator.taskId,
          chain.artificer.artifactId,
        );
        expect(evaluator.errors).toEqual([]);
        expect(evaluator.valid).toBe(true);

        // The evaluator hop uses only fields that exist today: V1 + codeReview.
        expect(isEvaluatorOutputV2(chain.evaluator.contentJson)).toBe(true);
        expect(Object.hasOwn(chain.evaluator.contentJson, 'painCoverage')).toBe(false);
        expect(Object.hasOwn(chain.evaluator.contentJson, 'compressionFidelity')).toBe(false);
      },
    );
  });

  describe('defect authenticity', () => {
    it('all three chains carry byte-identical dreamer dimensions', () => {
      const dimensionSets = SPIKE_CHAINS.map((chain) => {
        const candidate = chain.dreamer.contentJson.candidates[0];
        expect(candidate, chain.chainId).toBeDefined();
        return {
          badDecision: candidate?.badDecision,
          betterDecision: candidate?.betterDecision,
          rationale: candidate?.rationale,
          riskLevel: candidate?.riskLevel,
          strategicPerspective: candidate?.strategicPerspective,
        };
      });
      const [first] = dimensionSets;
      expect(first).toBeDefined();
      for (const set of dimensionSets) {
        expect(set).toEqual(first);
      }
      // The upstream content the defects are measured against is real, not empty.
      expect(first?.riskLevel).toBe(DREAMER_RISK_LEVEL);
      for (const action of CONCRETE_ACTIONS) {
        expect(first?.betterDecision).toContain(action);
      }
    });

    it('all three chains carry identical philosopher content, so only scribe diverges', () => {
      const philosopherTexts = SPIKE_CHAINS.map((chain) => ({
        thesis: chain.philosopher.contentJson.thesis,
        title: chain.philosopher.contentJson.principleCandidate.title,
        rationale: chain.philosopher.contentJson.principleCandidate.rationale,
        scope: chain.philosopher.contentJson.principleCandidate.scope,
      }));
      const [first] = philosopherTexts;
      for (const text of philosopherTexts) {
        expect(text).toEqual(first);
      }
      // philosopher still carries both dimensions — the loss happens at scribe.
      expect(mentionsRiskLevel(first?.rationale ?? '')).toBe(true);
      for (const action of CONCRETE_ACTIONS) {
        expect(first?.rationale).toContain(action);
      }
    });

    it('缺陷链 A drops riskLevel and nothing else', () => {
      const text = scribePrincipleText(SPIKE_CHAIN_DEFECT_A);
      expect(mentionsRiskLevel(text)).toBe(false);
      expect(survivingConcreteActions(text)).toEqual(CONCRETE_ACTIONS);
      expect(SPIKE_CHAIN_DEFECT_A.expectedDefect).toEqual({
        kind: 'missing_dimension',
        segment: 'dreamer_to_scribe',
        dimension: 'riskLevel',
      });
    });

    it('缺陷链 B abstracts the concrete actions and keeps riskLevel', () => {
      const text = scribePrincipleText(SPIKE_CHAIN_DEFECT_B);
      expect(survivingConcreteActions(text)).toEqual([]);
      expect(text).toContain(ABSTRACTED_PHRASE);
      expect(mentionsRiskLevel(text)).toBe(true);
      expect(SPIKE_CHAIN_DEFECT_B.expectedDefect).toEqual({
        kind: 'action_abstracted',
        segment: 'dreamer_to_scribe',
        concreteActions: CONCRETE_ACTIONS,
        abstractedAs: ABSTRACTED_PHRASE,
      });
    });

    it('对照链 keeps both dimensions, so a always-missing detector fails on it', () => {
      const text = scribePrincipleText(SPIKE_CHAIN_CONTROL);
      expect(mentionsRiskLevel(text)).toBe(true);
      expect(survivingConcreteActions(text)).toEqual(CONCRETE_ACTIONS);
      expect(text).not.toContain(ABSTRACTED_PHRASE);
    });

    it('artificer implementations differ per chain, mirroring their scribe text', () => {
      const summaries = SPIKE_CHAINS.map((chain) => chain.artificer.contentJson.implementationSummary);
      expect(new Set(summaries).size).toBe(SPIKE_CHAINS.length);
    });
  });
});
