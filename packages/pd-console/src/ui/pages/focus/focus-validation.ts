/**
 * Focus-page runtime validators for the approvals-grouped payload.
 * Lives outside FocusPage.tsx so contract tests need not load the React page;
 * kept separate from ui/utils/validators.ts because the page additionally
 * enforces the pending/approved/rejected status whitelist it renders on.
 */
import type { ApprovalsGroupedData, ApprovalGroup } from "../../api.js";
import { validatePromptInjectionBudgetStatus } from "../../utils/validators.js";

/** Type guard: is this a non-null object with own properties (not inherited)? */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateApprovalGroup(raw: unknown): ApprovalGroup | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "principleId") ||
    !Object.hasOwn(raw, "principleTitle") ||
    !Object.hasOwn(raw, "status") ||
    !Object.hasOwn(raw, "records")
  ) {
    return null;
  }
  const { principleId, principleTitle, status, records } = raw;
  if (
    typeof principleId !== "string" ||
    typeof principleTitle !== "string" ||
    typeof status !== "string" ||
    !["pending", "approved", "rejected"].includes(status) ||
    !Array.isArray(records)
  ) {
    return null;
  }
  const validRecords: ApprovalGroup["records"] = [];
  for (const r of records) {
    if (!isRecord(r)) return null;
    if (
      !Object.hasOwn(r, "id") ||
      !Object.hasOwn(r, "artifactId") ||
      !Object.hasOwn(r, "channel") ||
      !Object.hasOwn(r, "createdAt") ||
      !Object.hasOwn(r, "status") ||
      typeof r.id !== "string" ||
      typeof r.artifactId !== "string" ||
      typeof r.channel !== "string" ||
      typeof r.createdAt !== "string" ||
      typeof r.status !== "string"
    ) {
      return null;
    }
    validRecords.push({
      id: r.id,
      artifactId: r.artifactId,
      channel: r.channel,
      createdAt: r.createdAt,
      status: r.status,
    });
  }
  // Wave 7: candidateDescription is optional — present when backend could
  // extract human-readable content from the artifact contentJson.
  // ERR-009: if field exists but is wrong type, fail loud (return null).
  let candidateDescription: string | undefined;
  if (Object.hasOwn(raw, "candidateDescription")) {
    const { candidateDescription: description } = raw;
    if (typeof description !== "string") return null;
    candidateDescription = description;
  }
  return {
    principleId,
    principleTitle,
    candidateDescription,
    status,
    records: validRecords,
  };
}

export function validateApprovalsGroupedData(raw: unknown): ApprovalsGroupedData | null {
  if (!isRecord(raw)) return null;
  if (
    !Object.hasOwn(raw, "groups") ||
    !Object.hasOwn(raw, "generatedAt")
  ) {
    return null;
  }
  const { groups, generatedAt } = raw;
  if (!Array.isArray(groups) || typeof generatedAt !== "string") {
    return null;
  }
  const validatedGroups: ApprovalGroup[] = [];
  for (const g of groups) {
    const validated = validateApprovalGroup(g);
    if (validated === null) return null;
    validatedGroups.push(validated);
  }
  return {
    groups: validatedGroups,
    generatedAt,
    note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined,
    // PRI-908: the pre-approval injection-budget forecast must survive page-local
    // validation, or the queue badge can never render; malformed status degrades
    // to undefined (badge absent) rather than rejecting the payload.
    promptInjection: validatePromptInjectionBudgetStatus(raw.promptInjection) ?? undefined,
  };
}
