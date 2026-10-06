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
  // PR-1894: fitsPromptBudget is optional. ERR-009 discipline — present but
  // wrong type fails loud; absent stays undefined, which the badge treats as
  // "unknown size → do not promise rotation".
  let fitsPromptBudget: boolean | undefined;
  if (Object.hasOwn(raw, "fitsPromptBudget")) {
    const { fitsPromptBudget: fits } = raw;
    if (typeof fits !== "boolean") return null;
    fitsPromptBudget = fits;
  }
  // PRI-940: artifactUnavailable is optional. ERR-009 discipline — present but
  // wrong type fails loud (return null); absent stays undefined, which keeps
  // the card title rendering exactly as before.
  let artifactUnavailable: boolean | undefined;
  if (Object.hasOwn(raw, "artifactUnavailable")) {
    const { artifactUnavailable: unavailable } = raw;
    if (typeof unavailable !== "boolean") return null;
    artifactUnavailable = unavailable;
  }
  return {
    principleId,
    principleTitle,
    candidateDescription,
    status,
    fitsPromptBudget,
    artifactUnavailable,
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

/**
 * PRI-940: which string may the pending-review card render as its title.
 *
 * `principleTitle` degrades to the synthesized `unlinked:<artifactId>` grouping
 * key when the pinned artifact is missing — a machine id that must never reach
 * the Owner as a title (real case: an approval pinned to a superseded scribe
 * revision rendered `unlinked:pi-art-scribe-…` on the card). Returns undefined
 * for that case so the caller falls back to the localized untitled copy; the
 * degradation itself is explained by the artifactUnavailable note, not here.
 */
export function selectApprovalGroupDisplayTitle(
  group: Pick<ApprovalGroup, "candidateDescription" | "principleTitle" | "artifactUnavailable">,
): string | undefined {
  if (group.candidateDescription !== undefined && group.candidateDescription !== "") {
    return group.candidateDescription;
  }
  if (group.artifactUnavailable === true) return undefined;
  return group.principleTitle;
}
