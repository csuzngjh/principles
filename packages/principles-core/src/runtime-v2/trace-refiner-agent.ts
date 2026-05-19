/**
 * TraceRefinerAgent shadow contract (PRI-192).
 *
 * Defines the input/output contract for a built-in trace-processing agent
 * that operates in shadow mode only. The agent consolidates and purifies
 * traces before Diagnostician / L2 use, but does NOT replace the
 * deterministic TraceRefiner in production.
 *
 * Key invariants:
 *   - Default mode is 'shadow' — agent output is recorded, never selected
 *   - selectedTrace always equals deterministicRefinedTrace
 *   - Every evidence claim must have non-empty sourceRefs
 *   - All sourceRefs must exist in the allowed set from input
 *   - status='blocked' requires non-empty blockedReason
 *   - confidence must be finite and in [0, 1]
 *   - No filesystem/network/LLM/plugin dependencies — pure logic only
 *   - Agent contract only consumes provided trace payloads
 */
import type { FullTracePayloadV2 } from './full-trace-contract.js';
import type { RefinedTracePayload } from './trace-refiner.js';

// ── Objective ──

export type TraceRefinerAgentObjective =
  | 'diagnosis_input'
  | 'golden_trace_candidate'
  | 'l2_replay_case';

// ── Mode ──

export type TraceRefinerAgentMode = 'shadow';

// ── Input ──

export interface TraceRefinerAgentInput {
  fullTrace: FullTracePayloadV2;
  deterministicRefinedTrace: RefinedTracePayload;
  objective: TraceRefinerAgentObjective;
  mode: TraceRefinerAgentMode;
  constraints: {
    preserveSourceRefs: true;
    doNotInventEvidence: true;
    redactSecrets: true;
  };
}

// ── Evidence ──

export interface TraceRefinerEvidenceClaim {
  claim: string;
  sourceRefs: string[];
}

export interface TraceRefinerRejectedEvidence {
  reason: string;
  sourceRefs: string[];
}

// ── Status ──

export type TraceRefinerAgentStatus = 'refined' | 'blocked';

// ── Output ──

export interface TraceRefinerAgentOutput {
  status: TraceRefinerAgentStatus;
  refinedTrace: RefinedTracePayload;
  evidenceMap: TraceRefinerEvidenceClaim[];
  rejectedEvidence: TraceRefinerRejectedEvidence[];
  confidence: number;
  generatedAt: string;
  blockedReason?: string;
}

// ── Allowed Source Refs Builder ──

function buildAllowedSourceRefs(input: TraceRefinerAgentInput): Set<string> {
  const allowed = new Set<string>();

  for (const ref of input.fullTrace.sourceRefs) {
    allowed.add(`${ref.kind}:${ref.id}`);
  }

  for (const ref of input.deterministicRefinedTrace.evidenceRefs) {
    allowed.add(ref);
  }

  for (const event of input.deterministicRefinedTrace.keyEvents) {
    for (const ref of event.evidenceRefs) {
      allowed.add(ref);
    }
  }

  return allowed;
}

// ── createTraceRefinerAgentInput ──

export function createTraceRefinerAgentInput(
  fullTrace: FullTracePayloadV2,
  deterministicRefinedTrace: RefinedTracePayload,
  objective: TraceRefinerAgentObjective,
): TraceRefinerAgentInput {
  return {
    fullTrace,
    deterministicRefinedTrace,
    objective,
    mode: 'shadow',
    constraints: {
      preserveSourceRefs: true,
      doNotInventEvidence: true,
      redactSecrets: true,
    },
  };
}

// ── validateTraceRefinerAgentOutput ──

export function validateTraceRefinerAgentOutput(
  output: unknown,
  input: TraceRefinerAgentInput,
): { ok: true; output: TraceRefinerAgentOutput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof output !== 'object' || output === null) {
    return { ok: false, errors: ['TraceRefinerAgentOutput must be an object'] };
  }

  const o = output as Record<string, unknown>;

  if (o.status !== 'refined' && o.status !== 'blocked') {
    errors.push('status must be "refined" or "blocked"');
  }

  if (typeof o.refinedTrace !== 'object' || o.refinedTrace === null) {
    errors.push('refinedTrace must be an object');
  }

  if (!Array.isArray(o.evidenceMap)) {
    errors.push('evidenceMap must be an array');
  }

  if (!Array.isArray(o.rejectedEvidence)) {
    errors.push('rejectedEvidence must be an array');
  }

  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    errors.push('confidence must be a finite number in [0, 1]');
  }

  if (typeof o.generatedAt !== 'string' || o.generatedAt.length === 0) {
    errors.push('generatedAt must be a non-empty string');
  }

  if (o.status === 'blocked') {
    if (typeof o.blockedReason !== 'string' || o.blockedReason.length === 0) {
      errors.push('blockedReason must be a non-empty string when status is "blocked"');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const allowedSourceRefs = buildAllowedSourceRefs(input);

  if (Array.isArray(o.evidenceMap)) {
    for (let i = 0; i < o.evidenceMap.length; i++) {
      const claim = o.evidenceMap[i];
      if (typeof claim !== 'object' || claim === null) {
        errors.push(`evidenceMap[${i}] must be an object`);
        continue;
      }
      const c = claim as Record<string, unknown>;
      if (typeof c.claim !== 'string' || c.claim.length === 0) {
        errors.push(`evidenceMap[${i}].claim must be a non-empty string`);
      }
      if (!Array.isArray(c.sourceRefs) || c.sourceRefs.length === 0) {
        errors.push(`evidenceMap[${i}].sourceRefs must be a non-empty array`);
      } else {
        for (const ref of c.sourceRefs) {
          if (typeof ref !== 'string') {
            errors.push(`evidenceMap[${i}].sourceRefs must contain only strings`);
          } else if (!allowedSourceRefs.has(ref)) {
            errors.push(`evidenceMap[${i}].sourceRefs contains invented ref "${ref}" not present in allowed source refs`);
          }
        }
      }
    }
  }

  if (Array.isArray(o.rejectedEvidence)) {
    for (let i = 0; i < o.rejectedEvidence.length; i++) {
      const rejected = o.rejectedEvidence[i];
      if (typeof rejected !== 'object' || rejected === null) {
        errors.push(`rejectedEvidence[${i}] must be an object`);
        continue;
      }
      const r = rejected as Record<string, unknown>;
      if (typeof r.reason !== 'string' || r.reason.length === 0) {
        errors.push(`rejectedEvidence[${i}].reason must be a non-empty string`);
      }
      if (!Array.isArray(r.sourceRefs)) {
        errors.push(`rejectedEvidence[${i}].sourceRefs must be an array`);
      } else {
        for (const ref of r.sourceRefs) {
          if (typeof ref !== 'string') {
            errors.push(`rejectedEvidence[${i}].sourceRefs must contain only strings`);
          } else if (!allowedSourceRefs.has(ref)) {
            errors.push(`rejectedEvidence[${i}].sourceRefs contains invented ref "${ref}" not present in allowed source refs`);
          }
        }
      }
    }
  }

  if (typeof o.refinedTrace === 'object' && o.refinedTrace !== null) {
    const rt = o.refinedTrace as Record<string, unknown>;

    if (Array.isArray(rt.evidenceRefs)) {
      for (const ref of rt.evidenceRefs) {
        if (typeof ref === 'string' && !allowedSourceRefs.has(ref)) {
          errors.push(`refinedTrace.evidenceRefs contains invented ref "${ref}" not present in allowed source refs`);
        }
      }
    }

    if (Array.isArray(rt.keyEvents)) {
      for (let i = 0; i < rt.keyEvents.length; i++) {
        const event = rt.keyEvents[i];
        if (typeof event !== 'object' || event === null) continue;
        const e = event as Record<string, unknown>;
        if (Array.isArray(e.evidenceRefs)) {
          for (const ref of e.evidenceRefs) {
            if (typeof ref === 'string' && !allowedSourceRefs.has(ref)) {
              errors.push(`refinedTrace.keyEvents[${i}].evidenceRefs contains invented ref "${ref}" not present in allowed source refs`);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    output: {
      status: o.status as TraceRefinerAgentStatus,
      refinedTrace: o.refinedTrace as RefinedTracePayload,
      evidenceMap: o.evidenceMap as TraceRefinerEvidenceClaim[],
      rejectedEvidence: o.rejectedEvidence as TraceRefinerRejectedEvidence[],
      confidence: o.confidence as number,
      generatedAt: o.generatedAt as string,
      ...(typeof o.blockedReason === 'string' && o.blockedReason.length > 0
        ? { blockedReason: o.blockedReason }
        : {}),
    },
  };
}

// ── applyTraceRefinerAgentShadowResult ──

export function applyTraceRefinerAgentShadowResult(
  input: TraceRefinerAgentInput,
  agentOutput: unknown,
): {
  mode: 'shadow';
  selectedTrace: RefinedTracePayload;
  deterministicRefinedTrace: RefinedTracePayload;
  agentRefinedTrace: RefinedTracePayload | null;
  acceptedAgentOutput: TraceRefinerAgentOutput | null;
  telemetry: {
    decision: 'agent_refined_recorded' | 'agent_blocked' | 'agent_output_invalid';
    errors: string[];
  };
} {
  const validation = validateTraceRefinerAgentOutput(agentOutput, input);

  if (!validation.ok) {
    return {
      mode: 'shadow',
      selectedTrace: input.deterministicRefinedTrace,
      deterministicRefinedTrace: input.deterministicRefinedTrace,
      agentRefinedTrace: null,
      acceptedAgentOutput: null,
      telemetry: {
        decision: 'agent_output_invalid',
        errors: validation.errors,
      },
    };
  }

  const accepted = validation.output;

  if (accepted.status === 'blocked') {
    return {
      mode: 'shadow',
      selectedTrace: input.deterministicRefinedTrace,
      deterministicRefinedTrace: input.deterministicRefinedTrace,
      agentRefinedTrace: null,
      acceptedAgentOutput: accepted,
      telemetry: {
        decision: 'agent_blocked',
        errors: [],
      },
    };
  }

  return {
    mode: 'shadow',
    selectedTrace: input.deterministicRefinedTrace,
    deterministicRefinedTrace: input.deterministicRefinedTrace,
    agentRefinedTrace: accepted.refinedTrace,
    acceptedAgentOutput: accepted,
    telemetry: {
      decision: 'agent_refined_recorded',
      errors: [],
    },
  };
}
