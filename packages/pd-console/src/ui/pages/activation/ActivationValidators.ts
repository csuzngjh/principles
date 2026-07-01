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
  ActivationRecord,
  ActivationsData,
  LifecycleAdherence,
  LifecycleRuleMetric,
  LifecycleMetricsData,
} from "../../api.js";

// ── Type guard helpers ───────────────────────────────────────────────────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const VALID_ACTIVATION_STATUSES = new Set(["active", "inactive", "deactivated", "suspended_by_flag"]);

// ── Activation validators ────────────────────────────────────────────────────

export function validateActivationRecord(raw: unknown): ActivationRecord | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "id") ||
    !Object.hasOwn(raw, "artifactId") ||
    !Object.hasOwn(raw, "principleId") ||
    !Object.hasOwn(raw, "channel") ||
    !Object.hasOwn(raw, "action") ||
    !Object.hasOwn(raw, "targetRef") ||
    !Object.hasOwn(raw, "activatedAt") ||
    !Object.hasOwn(raw, "status")
  ) {
    return null;
  }
  const { id, artifactId, principleId, channel, action, targetRef, activatedAt, status } = raw;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof artifactId !== "string" ||
    typeof principleId !== "string" ||
    typeof channel !== "string" ||
    typeof action !== "string" ||
    typeof targetRef !== "string" ||
    (activatedAt !== null && typeof activatedAt !== "string") ||
    typeof status !== "string" ||
    !VALID_ACTIVATION_STATUSES.has(status)
  ) {
    return null;
  }
  // Narrow status from string to union type via const assertion
  const narrowStatus = status as "active" | "inactive" | "deactivated" | "suspended_by_flag";
  return {
    id: id,
    artifactId: artifactId,
    principleId: principleId,
    channel: channel,
    action: action,
    targetRef: targetRef,
    activatedAt: activatedAt,
    status: narrowStatus,
  };
}

export function validateActivationsData(raw: unknown): ActivationsData | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "activations") || !Object.hasOwn(raw, "generatedAt")) {
    return null;
  }
  const { activations, generatedAt } = raw;
  if (!Array.isArray(activations) || typeof generatedAt !== "string") {
    return null;
  }
  // Fail loud: any invalid record rejects the entire payload (ERR-009)
  const validatedRecords: ActivationRecord[] = [];
  for (const record of activations) {
    const validated = validateActivationRecord(record);
    if (validated === null) return null;
    validatedRecords.push(validated);
  }
  return {
    activations: validatedRecords,
    generatedAt,
    note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined,
  };
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
