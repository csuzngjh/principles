/**
 * Debt page validators and helpers — PRI-CR7
 *
 * Runtime validators for debt candidate derivation.
 * All API responses are treated as `unknown` and validated with runtime type guards.
 * No `as` casts to bypass validation (ERR-001/005).
 * Required fields fail loud when missing or malformed (ERR-009/010).
 * Array elements validated individually (ERR-005/007).
 * `Object.hasOwn()` used for untrusted keys (ERR-013).
 * Degraded states include a reason (ERR-002).
 */

import type {
  PrincipleListItem,
  PrinciplesListData,
  ActivationRecord,
  ActivationsData,
} from "../../api.js";

// ── Type guard helpers (local to CR7; will be consolidated by CR10) ─────────

/** Type guard: is this a non-null object with own properties (not inherited)? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Principle list validator ─────────────────────────────────────────────────

const VALID_PRINCIPLE_STATUSES = new Set([
  "candidate",
  "active",
  "archived",
  "deprecated",
  "probation",
]);

const VALID_PRIORITIES = new Set(["P0", "P1", "P2"]);
const VALID_SCOPES = new Set(["general", "domain"]);
const VALID_EVALUABILITIES = new Set([
  "manual_only",
  "deterministic",
  "weak_heuristic",
]);

export function validatePrincipleListItem(
  raw: unknown,
): PrincipleListItem | null {
  if (!isRecord(raw)) return null;

  const requiredKeys = [
    "id",
    "text",
    "triggerPattern",
    "action",
    "status",
    "priority",
    "scope",
    "domain",
    "evaluability",
    "valueScore",
    "adherenceRate",
    "painPreventedCount",
    "ruleCount",
    "conflictsWithCount",
    "createdAt",
    "updatedAt",
  ];

  for (const key of requiredKeys) {
    if (!Object.hasOwn(raw, key)) return null;
  }

  const {
    id,
    text,
    triggerPattern,
    action,
    status,
    priority,
    scope,
    domain,
    evaluability,
    valueScore,
    adherenceRate,
    painPreventedCount,
    ruleCount,
    conflictsWithCount,
    createdAt,
    updatedAt,
  } = raw;

  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof text !== "string" ||
    typeof triggerPattern !== "string" ||
    typeof action !== "string" ||
    typeof status !== "string" ||
    !VALID_PRINCIPLE_STATUSES.has(status) ||
    typeof priority !== "string" ||
    !VALID_PRIORITIES.has(priority) ||
    typeof scope !== "string" ||
    !VALID_SCOPES.has(scope) ||
    (domain !== null && typeof domain !== "string") ||
    typeof evaluability !== "string" ||
    !VALID_EVALUABILITIES.has(evaluability) ||
    typeof valueScore !== "number" ||
    typeof adherenceRate !== "number" ||
    typeof painPreventedCount !== "number" ||
    typeof ruleCount !== "number" ||
    typeof conflictsWithCount !== "number" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  const narrowStatus = status as PrincipleListItem["status"];
  const narrowPriority = priority as PrincipleListItem["priority"];
  const narrowScope = scope as PrincipleListItem["scope"];
  const narrowEvaluability =
    evaluability as PrincipleListItem["evaluability"];

  return {
    id,
    text,
    triggerPattern,
    action,
    status: narrowStatus,
    priority: narrowPriority,
    scope: narrowScope,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS cannot narrow unknown to string | null
    domain: domain as string | null,
    evaluability: narrowEvaluability,
    valueScore,
    adherenceRate,
    painPreventedCount,
    ruleCount,
    conflictsWithCount,
    createdAt,
    updatedAt,
  };
}

export function validatePrinciplesListData(
  raw: unknown,
): PrinciplesListData | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "principles") || !Object.hasOwn(raw, "summary")) {
    return null;
  }

  const { principles, summary } = raw;
  if (!Array.isArray(principles) || !isRecord(summary)) return null;

  const validated: PrincipleListItem[] = [];
  for (const item of principles) {
    const v = validatePrincipleListItem(item);
    if (v === null) return null; // fail loud (ERR-009)
    validated.push(v);
  }

  // Validate summary shape
  const summaryKeys = [
    "candidate",
    "probation",
    "active",
    "deprecated",
    "archived",
    "total",
  ];
  for (const key of summaryKeys) {
    if (!Object.hasOwn(summary, key)) return null;
    if (typeof summary[key] !== "number") return null;
  }

  return {
    principles: validated,
    summary: {
      candidate: summary.candidate as number,
      probation: summary.probation as number,
      active: summary.active as number,
      deprecated: summary.deprecated as number,
      archived: summary.archived as number,
      total: summary.total as number,
    },
  };
}

// ── Activation validators (local to CR7; will be consolidated by CR10) ──────

const VALID_ACTIVATION_STATUSES = new Set(["active", "inactive"]);

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
  const narrowStatus = status as "active" | "inactive";
  return {
    id, artifactId, principleId, channel, action, targetRef,
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
  const validatedRecords: ActivationRecord[] = [];
  for (const record of activations) {
    const validated = validateActivationRecord(record);
    if (validated === null) return null; // fail loud (ERR-009)
    validatedRecords.push(validated);
  }
  return {
    activations: validatedRecords,
    generatedAt,
    note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined,
  };
}

// ── Debt candidate derivation ────────────────────────────────────────────────

/**
 * Reasons a principle is flagged as debt.
 * - approvedNeverActivated: has activation record but activatedAt is null
 * - longTermInactive: all activation records are inactive
 * - noActivationRecord: principle is active but has zero activation records
 */
export type DebtReason =
  | "approvedNeverActivated"
  | "longTermInactive"
  | "noActivationRecord";

/**
 * Suggested actions for a debt candidate.
 * All are currently disabled (no backend endpoint exists).
 */
export type SuggestedAction = "archive" | "downgrade" | "keepObserving";

export interface DebtCandidate {
  principleId: string;
  principleTitle: string;
  debtReason: DebtReason;
  suggestedAction: SuggestedAction;
  channel: string | null;
  daysSinceActivation: number | null;
}

/**
 * Derive debt candidates from principles and activations data.
 *
 * Logic:
 * 1. Principles with activation records where activatedAt is null → approvedNeverActivated
 * 2. Principles whose all activations are inactive → longTermInactive
 * 3. Active principles with zero activation records → noActivationRecord
 */
export function deriveDebtCandidates(
  principles: PrincipleListItem[],
  activations: ActivationRecord[],
): DebtCandidate[] {
  const candidates: DebtCandidate[] = [];

  // Index activations by principleId
  const activationByPrinciple = new Map<string, ActivationRecord[]>();
  for (const act of activations) {
    const existing = activationByPrinciple.get(act.principleId);
    if (existing) {
      existing.push(act);
    } else {
      activationByPrinciple.set(act.principleId, [act]);
    }
  }

  for (const principle of principles) {
    // Skip already archived or deprecated — they're already "managed"
    if (principle.status === "archived" || principle.status === "deprecated") {
      continue;
    }

    const principleActivations = activationByPrinciple.get(principle.id);

    if (!principleActivations || principleActivations.length === 0) {
      // Active principle with zero activation records
      if (principle.status === "active") {
        candidates.push({
          principleId: principle.id,
          principleTitle: principle.text,
          debtReason: "noActivationRecord",
          suggestedAction: "keepObserving",
          channel: null,
          daysSinceActivation: null,
        });
      }
      continue;
    }

    // Check for never-activated (activatedAt is null for all records)
    const neverActivatedRecords = principleActivations.filter(
      (a) => a.activatedAt === null,
    );
    if (neverActivatedRecords.length === principleActivations.length) {
      // All records are never activated
      candidates.push({
        principleId: principle.id,
        principleTitle: principle.text,
        debtReason: "approvedNeverActivated",
        suggestedAction: "keepObserving",
        channel: principleActivations[0]?.channel ?? null,
        daysSinceActivation: null,
      });
      continue;
    }

    // Check for all-inactive
    const allInactive = principleActivations.every(
      (a) => a.status === "inactive",
    );
    if (allInactive) {
      // Find most recent activation to compute days since
      const sortedDates = principleActivations
        .map((a) => a.activatedAt)
        .filter((d): d is string => typeof d === "string")
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

      const daysSince =
        sortedDates.length > 0
          ? Math.floor(
              (Date.now() - new Date(sortedDates[0] ?? "").getTime()) /
                (1000 * 60 * 60 * 24),
            )
          : null;

      candidates.push({
        principleId: principle.id,
        principleTitle: principle.text,
        debtReason: "longTermInactive",
        suggestedAction: daysSince !== null && daysSince > 14 ? "archive" : "keepObserving",
        channel: principleActivations[0]?.channel ?? null,
        daysSinceActivation: daysSince,
      });
    }
  }

  return candidates;
}

/**
 * Get the suggested action for a debt candidate.
 * Currently all actions are disabled since no backend endpoint exists.
 */
export function isActionAvailable(_action: SuggestedAction): boolean {
  // No backend endpoint for principle status changes exists yet.
  // All actions are disabled with honest explanation (F.5).
  return false;
}
