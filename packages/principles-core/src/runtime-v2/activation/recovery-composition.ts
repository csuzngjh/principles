import { compileHardenedRuleEvaluator } from './production-gate-deps.js';
import { createSyntheticRuleHostInput } from '../golden-trace.js';
import { mergeDecisions } from '../internalization/rule-host-evaluator.js';
import { validateRuleHostResult } from '../internalization/rule-host-validator.js';
import { createRuleHostHelpers } from '../internalization/rule-host-helpers.js';
import type { LoadedImplementation, RuleHostInput, RuleHostResult } from '../internalization/rule-host-contracts.js';
import type { ToolSemanticRegistry } from '../internalization/tool-semantic-registry.js';

/**
 * SPEC-RULECODE-HOST-PROMOTION-001 review round 3 (P1): "composition
 * verification" must execute through the PRODUCTION composition boundary —
 * every rule of the composed set (candidate + existing live) compiled by the
 * same hardened evaluator production replay uses, evaluated against the same
 * synthetic-input builder, and merged by the same `mergeDecisions` the
 * shared gate uses at runtime (any block / requireApproval / auto_correct
 * from ANY rule wins over allow). The previous approximation appended probe
 * cases to each artifact's own golden trace and validated artifacts one by
 * one — decision-equivalent for blockers, but it never exercised a merged
 * multi-rule execution; this module does.
 *
 * Evidence-layer boundary (do not blur): this is RULE-side verification for
 * the rule-interceptable (CLI/shell-channel) recovery probes ONLY. Console-
 * channel recovery controls never pass through the RuleHost gate — their
 * independence is structural and their real-world reachability is supplied
 * separately as target-environment evidence by the readiness caller.
 */
export interface RecoveryCompositionArtifact {
  artifactId: string;
  /** Direct source when the caller already parsed the artifact content. */
  implementationCode?: string;
  /** Raw artifact content; parsed here when implementationCode is absent. */
  contentJson?: string;
}

export interface RecoveryCompositionProbe {
  probeId: string;
  toolName: string;
  params: Readonly<Record<string, unknown>>;
}

export interface RecoveryCompositionInput {
  /** Candidate first, then existing live artifacts, in activation order. */
  artifacts: readonly RecoveryCompositionArtifact[];
  probes: readonly RecoveryCompositionProbe[];
  projectDir: string;
  toolSemantics?: ToolSemanticRegistry;
}

export type RecoveryCompositionResult =
  | { ok: true }
  | { ok: false; probeId: string; blockerArtifactId?: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseImplementationCode(artifact: RecoveryCompositionArtifact): string | null {
  if (typeof artifact.implementationCode === 'string' && artifact.implementationCode.trim().length > 0) return artifact.implementationCode;
  if (typeof artifact.contentJson === 'string') {
    try {
      const parsed: unknown = JSON.parse(artifact.contentJson);
      if (isRecord(parsed) && typeof parsed.implementationCode === 'string') {
        return parsed.implementationCode;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Verify that the COMPOSED rule set (candidate + existing live) allows every
 * rule-interceptable recovery probe. Any rule that blocks (or escalates) a
 * probe fails the check with the blocking artifact identified — a rule
 * combination that blocks an official recovery entry can never be promoted.
 */
export function verifyRecoveryProbeComposition(input: RecoveryCompositionInput): RecoveryCompositionResult {
  const compiled: { artifactId: string; implId: string; evaluate: (probeInput: RuleHostInput) => RuleHostResult }[] = [];
  for (const artifact of input.artifacts) {
    const code = parseImplementationCode(artifact);
    if (code === null || code.trim().length === 0) {
      return { ok: false, probeId: '__compile__', blockerArtifactId: artifact.artifactId, reason: `artifact ${artifact.artifactId} carries no implementationCode` };
    }
    try {
      const evaluator = compileHardenedRuleEvaluator(code, `recovery-composition:${artifact.artifactId}`);
      compiled.push({ artifactId: artifact.artifactId, implId: artifact.artifactId, evaluate: probeInput => evaluator(probeInput, createRuleHostHelpers(probeInput)) });
    } catch (error: unknown) {
      return { ok: false, probeId: '__compile__', blockerArtifactId: artifact.artifactId, reason: `artifact ${artifact.artifactId} failed to compile: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (compiled.length === 0) return { ok: true };

  for (const probe of input.probes) {
    const probeInput = createSyntheticRuleHostInput(
      { toolName: probe.toolName, params: { ...probe.params } },
      {},
      { projectDir: input.projectDir, ...(input.toolSemantics !== undefined ? { toolSemantics: input.toolSemantics } : {}) },
    );
    const results: { artifactId: string; result: RuleHostResult }[] = [];
    for (const entry of compiled) {
      let result: RuleHostResult;
      try {
        result = entry.evaluate(probeInput);
      } catch (error: unknown) {
        return { ok: false, probeId: probe.probeId, blockerArtifactId: entry.artifactId, reason: `rule threw during recovery probe ${probe.probeId}: ${error instanceof Error ? error.message : String(error)}` };
      }
      const validation = validateRuleHostResult(result);
      if (!validation.valid) {
        return { ok: false, probeId: probe.probeId, blockerArtifactId: entry.artifactId, reason: `rule returned an invalid result on recovery probe ${probe.probeId}: ${validation.errors.join('; ')}` };
      }
      results.push({ artifactId: entry.artifactId, result });
    }
    const implementations: LoadedImplementation[] = results.map((entry) => ({
      implId: entry.artifactId,
      ruleId: entry.artifactId,
      meta: { name: entry.artifactId, version: '1', ruleId: entry.artifactId, coversCondition: 'all' },
      evaluate: () => entry.result,
    }));
    const merged = mergeDecisions(implementations, probeInput);
    if (merged !== undefined && merged.decision !== 'allow') {
      // Attribute the winning decision back to its artifact by reference
      // identity (the merge returns the winning rule's own result object).
      const winner = results.find(entry => entry.result === merged);
      return {
        ok: false,
        probeId: probe.probeId,
        ...(winner !== undefined ? { blockerArtifactId: winner.artifactId } : {}),
        reason: `recovery probe ${probe.probeId} would be ${merged.decision === 'block' ? 'blocked' : merged.decision} under the composed rule set`,
      };
    }
  }
  return { ok: true };
}
