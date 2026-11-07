/**
 * Activation page validators — PRI-CR6
 *
 * Runtime validators for activation and lifecycle API responses.
 * All API responses are treated as `unknown` and validated with runtime type guards.
 * No `as` casts to bypass validation (ERR-001/005).
 * Required fields fail loud when missing or malformed (ERR-009/010).
 * Array elements validated individually (ERR-005/007).
 * `Object.hasOwn()` used for untrusted keys (ERR-013).
 * Degraded states include a reason (ERR-002).
 */

import type {
  LifecycleAdherence,
  LifecycleRuleMetric,
  LifecycleMetricsData,
} from "../../api.js";

// ── Type guard helpers ───────────────────────────────────────────────────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Lifecycle validators ─────────────────────────────────────────────────────

export function validateLifecycleRuleMetric(raw: unknown): LifecycleRuleMetric | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "ruleId") ||
    !Object.hasOwn(raw, "triggered") ||
    !Object.hasOwn(raw, "lastTriggeredAt")
  ) {
    return null;
  }
  const { ruleId, triggered, lastTriggeredAt } = raw;
  if (
    typeof ruleId !== "string" ||
    typeof triggered !== "number" ||
    (lastTriggeredAt !== null && typeof lastTriggeredAt !== "string")
  ) {
    return null;
  }
  return {
    ruleId,
    triggered,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS cannot narrow from Record<string, unknown> without assertion
    lastTriggeredAt: lastTriggeredAt as string | null,
  };
}

export function validateLifecycleAdherence(raw: unknown): LifecycleAdherence | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "insufficientData") ||
    !Object.hasOwn(raw, "rate") ||
    !Object.hasOwn(raw, "note")
  ) {
    return null;
  }
  const { insufficientData, rate, note } = raw;
  if (
    typeof insufficientData !== "boolean" ||
    (rate !== null && typeof rate !== "number") ||
    typeof note !== "string"
  ) {
    return null;
  }
  return {
    insufficientData,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS cannot narrow from Record<string, unknown> without assertion
    rate: rate as number | null,
    note,
  };
}

export function validateLifecycleMetricsData(raw: unknown): LifecycleMetricsData | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "principleId") ||
    !Object.hasOwn(raw, "adherence") ||
    !Object.hasOwn(raw, "ruleMetrics")
  ) {
    return null;
  }
  const { principleId, adherence, ruleMetrics } = raw;
  if (typeof principleId !== "string" || !Array.isArray(ruleMetrics)) {
    return null;
  }
  const validatedAdherence = validateLifecycleAdherence(adherence);
  if (validatedAdherence === null) return null;
  const validatedRules: LifecycleRuleMetric[] = [];
  for (const r of ruleMetrics) {
    const validated = validateLifecycleRuleMetric(r);
    if (validated === null) return null;
    validatedRules.push(validated);
  }
  return {
    principleId,
    adherence: validatedAdherence,
    ruleMetrics: validatedRules,
  };
}

// ── Channel helpers ──────────────────────────────────────────────────────────

export function isReversibleChannel(channel: string): boolean {
  return channel === "prompt" || channel === "defer_archive";
}
