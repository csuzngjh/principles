/**
 * Principle Review Page — Source-code contract tests (PRI-315 / CR4)
 *
 * Validates structural and honesty constraints by reading actual TSX source
 * files. No jsdom/RTL — follows the project's existing test pattern.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const UI_SRC = path.join(PKG_ROOT, "src", "ui");

let principlesPageSrc: string;
let principleDetailSrc: string;
let apiSrc: string;
let enJson: Record<string, unknown>;
let zhJson: Record<string, unknown>;

beforeAll(() => {
  principlesPageSrc = fs.readFileSync(
    path.join(UI_SRC, "pages", "principles", "PrinciplesPage.tsx"),
    "utf-8",
  );
  principleDetailSrc = fs.readFileSync(
    path.join(UI_SRC, "pages", "principles", "PrincipleDetailPage.tsx"),
    "utf-8",
  );
  apiSrc = fs.readFileSync(path.join(UI_SRC, "api.ts"), "utf-8");
  enJson = JSON.parse(
    fs.readFileSync(path.join(UI_SRC, "i18n", "en.json"), "utf-8"),
  );
  zhJson = JSON.parse(
    fs.readFileSync(path.join(UI_SRC, "i18n", "zh-CN.json"), "utf-8"),
  );
});

// ── Helper ──────────────────────────────────────────────────────────────────
function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object" && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function getPagesKey(key: string): unknown {
  return getNestedValue(enJson, "pages." + key);
}

function getPagesKeyZh(key: string): unknown {
  return getNestedValue(zhJson, "pages." + key);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. PrinciplesPage structure
// ════════════════════════════════════════════════════════════════════════════
describe("PrinciplesPage structure", () => {
  it("file exists and is non-empty", () => {
    expect(principlesPageSrc.length).toBeGreaterThan(100);
  });

  it("exports a function component", () => {
    expect(principlesPageSrc).toMatch(/export function PrinciplesPage/);
  });

  it("uses PageShell layout", () => {
    expect(principlesPageSrc).toMatch(/PageShell/);
  });

  it("calls fetchApprovalsGrouped API", () => {
    expect(principlesPageSrc).toMatch(/fetchApprovalsGrouped/);
  });

  it("calls fetchPrinciples API", () => {
    expect(principlesPageSrc).toMatch(/fetchPrinciples/);
  });

  it("renders principle-level cards from grouped approvals", () => {
    // Must merge approval groups with principles
    expect(principlesPageSrc).toMatch(/approvalByPrinciple|approvalGroups/);
    expect(principlesPageSrc).toMatch(/principles\.map|principles\.filter/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. PrincipleDetailPage three-layer structure
// ════════════════════════════════════════════════════════════════════════════
describe("PrincipleDetailPage three-layer structure", () => {
  it("file exists and is non-empty", () => {
    expect(principleDetailSrc.length).toBeGreaterThan(100);
  });

  it("exports a function component", () => {
    expect(principleDetailSrc).toMatch(/export function PrincipleDetailPage/);
  });

  it("uses PageShell layout", () => {
    expect(principleDetailSrc).toMatch(/PageShell/);
  });

  it("has Layer 1 (Conclusion) section", () => {
    expect(principleDetailSrc).toMatch(/conclusion/);
  });

  it("has Layer 2 (Why) section", () => {
    expect(principleDetailSrc).toMatch(/whyExists/);
  });

  it("has Layer 3 (Full trajectory) as collapsed details element", () => {
    expect(principleDetailSrc).toMatch(/<details/);
    expect(principleDetailSrc).toMatch(/trajectory/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Approval integration
// ════════════════════════════════════════════════════════════════════════════
describe("Approval integration", () => {
  it("api.ts defines approveApproval function", () => {
    expect(apiSrc).toMatch(/function approveApproval/);
  });

  it("api.ts defines rejectApproval function", () => {
    expect(apiSrc).toMatch(/function rejectApproval/);
  });

  it("rejectApproval requires reason parameter", () => {
    // The function signature should have a reason param
    expect(apiSrc).toMatch(/rejectApproval.*reason/);
  });

  it("PrincipleDetailPage calls approveApproval", () => {
    expect(principleDetailSrc).toMatch(/approveApproval/);
  });

  it("PrincipleDetailPage calls rejectApproval", () => {
    expect(principleDetailSrc).toMatch(/rejectApproval/);
  });

  it("approval status includes pending/approved/rejected", () => {
    expect(apiSrc).toMatch(/pending/);
    expect(apiSrc).toMatch(/approved/);
    expect(apiSrc).toMatch(/rejected/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Lifecycle metrics honesty (F.1)
// ════════════════════════════════════════════════════════════════════════════
describe("Lifecycle metrics honesty", () => {
  it("lifecycleNote key exists in both languages", () => {
    expect(getPagesKey("principles.detail.lifecycleNote")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.lifecycleNote")).toBeTruthy();
  });

  it("lifecycleNote contains honest disclaimer", () => {
    const zh = String(getPagesKeyZh("principles.detail.lifecycleNote"));
    expect(zh).toContain("规则质量信号");
    expect(zh).toContain("不等于行为变化");
  });

  it("insufficientData key exists in both languages", () => {
    expect(getPagesKey("principles.detail.insufficientData")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.insufficientData")).toBeTruthy();
  });

  it("PrincipleDetailPage renders lifecycleNote", () => {
    expect(principleDetailSrc).toMatch(/lifecycleNote/);
  });

  it("PrincipleDetailPage checks insufficientData", () => {
    expect(principleDetailSrc).toMatch(/insufficientData/);
  });

  it("lifecycle metrics only shown when principle has rules", () => {
    expect(principleDetailSrc).toMatch(/hasRules/);
  });

  it("lifecycle metrics only in Layer 3 (inside details)", () => {
    // Find the <details> block and verify lifecycle is inside it
    const detailsIdx = principleDetailSrc.indexOf("<details");
    const lifecycleIdx = principleDetailSrc.indexOf("lifecycleMetrics");
    expect(detailsIdx).toBeGreaterThan(0);
    expect(lifecycleIdx).toBeGreaterThan(detailsIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Channel display honesty — no fake selector (F.4)
// ════════════════════════════════════════════════════════════════════════════
describe("Channel display honesty — no fake selector", () => {
  it("no channel selector/dropdown in PrinciplesPage", () => {
    expect(principlesPageSrc).not.toMatch(/channelSelector|channel-select|ChannelSelect/);
    expect(principlesPageSrc).not.toMatch(/channelRadio|channel-toggle/);
  });

  it("no channel selector/dropdown in PrincipleDetailPage", () => {
    expect(principleDetailSrc).not.toMatch(/channelSelector|channel-select|ChannelSelect/);
    expect(principleDetailSrc).not.toMatch(/channelRadio|channel-toggle/);
  });

  it("channel info is read-only text", () => {
    expect(principleDetailSrc).toMatch(/channelPromptReversible/);
  });

  it("channel labels exist in both languages", () => {
    expect(getPagesKey("principles.channelPrompt")).toBeTruthy();
    expect(getPagesKeyZh("principles.channelPrompt")).toBeTruthy();
  });

  it("retired channels are marked as retired in i18n", () => {
    // Check that model_training channel is marked retired
    const channelKeys = getNestedValue(enJson, "components.approvalCard.channel") as Record<string, unknown> | undefined;
    expect(channelKeys).toBeTruthy();
    expect(String(channelKeys!.model_training)).toContain("retired");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. i18n key parity
// ════════════════════════════════════════════════════════════════════════════
describe("i18n key parity", () => {
  it("review page keys exist in both languages", () => {
    const keys = [
      "principles.reviewTitle",
      "principles.reviewSubtitle",
      "principles.reviewDescription",
      "principles.searchPlaceholder",
      "principles.allStatuses",
      "principles.statusPending",
      "principles.statusApproved",
      "principles.statusRejected",
      "principles.statusParked",
      "principles.sortByUpdated",
      "principles.sortByCreated",
      "principles.emptyTitle",
      "principles.emptyDescription",
      "principles.noResults",
      "principles.channelPrompt",
      "principles.channelDeferArchive",
      "principles.channelCodeToolHook",
      "principles.confidence",
    ];
    for (const key of keys) {
      expect(getPagesKey(key), `Missing en: ${key}`).toBeTruthy();
      expect(getPagesKeyZh(key), `Missing zh: ${key}`).toBeTruthy();
    }
  });

  it("detail page keys exist in both languages", () => {
    const keys = [
      "principles.detail.backToList",
      "principles.detail.conclusion",
      "principles.detail.policyNote",
      "principles.detail.modifyWording",
      "principles.detail.modifyWordingNote",
      "principles.detail.channel",
      "principles.detail.channelPromptReversible",
      "principles.detail.whyExists",
      "principles.detail.evidence",
      "principles.detail.ownerReflection",
      "principles.detail.reflectionQ1",
      "principles.detail.reflectionQ2",
      "principles.detail.reflectionQ3",
      "principles.detail.trajectory",
      "principles.detail.lifecycleNote",
      "principles.detail.insufficientData",
      "principles.detail.approve",
      "principles.detail.park",
      "principles.detail.reject",
      "principles.detail.confirmApprove",
      "principles.detail.confirm",
      "principles.detail.cancel",
      "principles.detail.rejectReasonPlaceholder",
      "principles.detail.confirmReject",
      "principles.detail.approved",
      "principles.detail.rejected",
      "principles.detail.parked",
      "principles.detail.approveFailed",
      "principles.detail.rejectFailed",
    ];
    for (const key of keys) {
      expect(getPagesKey(key), `Missing en: ${key}`).toBeTruthy();
      expect(getPagesKeyZh(key), `Missing zh: ${key}`).toBeTruthy();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Pending/approved/rejected status display
// ════════════════════════════════════════════════════════════════════════════
describe("Status display", () => {
  it("PrinciplesPage defines status border colors", () => {
    expect(principlesPageSrc).toMatch(/STATUS_BORDER/);
    expect(principlesPageSrc).toMatch(/border-l-gov/);
    expect(principlesPageSrc).toMatch(/border-l-green/);
    expect(principlesPageSrc).toMatch(/border-l-danger/);
  });

  it("PrinciplesPage defines status text colors", () => {
    expect(principlesPageSrc).toMatch(/STATUS_TEXT/);
    expect(principlesPageSrc).toMatch(/text-gov/);
    expect(principlesPageSrc).toMatch(/text-green/);
    expect(principlesPageSrc).toMatch(/text-danger/);
  });

  it("status labels exist in both languages", () => {
    expect(getPagesKey("principles.statusPending")).toBeTruthy();
    expect(getPagesKey("principles.statusApproved")).toBeTruthy();
    expect(getPagesKey("principles.statusRejected")).toBeTruthy();
    expect(getPagesKey("principles.statusParked")).toBeTruthy();
  });

  it("toReviewStatus maps principle statuses correctly", () => {
    expect(principlesPageSrc).toMatch(/toReviewStatus/);
    expect(principlesPageSrc).toMatch(/active.*approved|approved.*active/);
    expect(principlesPageSrc).toMatch(/archived.*parked|parked.*archived/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Rejection reason required
// ════════════════════════════════════════════════════════════════════════════
describe("Rejection reason required", () => {
  it("rejectApproval in api.ts requires reason", () => {
    expect(apiSrc).toMatch(/rejectApproval/);
    // The function should accept a reason parameter
    const match = apiSrc.match(/rejectApproval[^{]*\{[^}]*reason/s);
    expect(match).toBeTruthy();
  });

  it("PrincipleDetailPage has rejection reason textarea", () => {
    expect(principleDetailSrc).toMatch(/textarea/);
    expect(principleDetailSrc).toMatch(/rejectReason/);
  });

  it("confirm reject button is disabled when reason is empty", () => {
    expect(principleDetailSrc).toMatch(/!rejectReason\.trim/);
  });

  it("rejection reason placeholder exists in both languages", () => {
    expect(getPagesKey("principles.detail.rejectReasonPlaceholder")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.rejectReasonPlaceholder")).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Modify wording disabled
// ════════════════════════════════════════════════════════════════════════════
describe("Modify wording disabled", () => {
  it("PrincipleDetailPage has modifyWording button", () => {
    expect(principleDetailSrc).toMatch(/modifyWording/);
  });

  it("modifyWording button is disabled", () => {
    expect(principleDetailSrc).toMatch(/disabled/);
  });

  it("modifyWordingNote explains why disabled", () => {
    expect(principleDetailSrc).toMatch(/modifyWordingNote/);
    expect(getPagesKey("principles.detail.modifyWordingNote")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.modifyWordingNote")).toBeTruthy();
  });

  it("no principle text editing API endpoint exists", () => {
    // api.ts should not have a modifyPrinciple or updatePrinciple function
    expect(apiSrc).not.toMatch(/export.*function.*modifyPrinciple|export.*function.*updatePrinciple/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 10. Search/filter/sort
// ════════════════════════════════════════════════════════════════════════════
describe("Search/filter/sort", () => {
  it("PrinciplesPage has search input", () => {
    expect(principlesPageSrc).toMatch(/type="text"/);
    expect(principlesPageSrc).toMatch(/searchPlaceholder/);
  });

  it("PrinciplesPage has status filter buttons", () => {
    expect(principlesPageSrc).toMatch(/statusFilter/);
    expect(principlesPageSrc).toMatch(/statusPending|statusApproved/);
  });

  it("PrinciplesPage has sort control", () => {
    expect(principlesPageSrc).toMatch(/sortBy/);
    expect(principlesPageSrc).toMatch(/sortByUpdated/);
    expect(principlesPageSrc).toMatch(/sortByCreated/);
  });

  it("filter is frontend-only (no API filter param)", () => {
    // The filter should be client-side, not passed to API
    expect(principlesPageSrc).toMatch(/\.filter\(/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Owner reflection three questions
// ════════════════════════════════════════════════════════════════════════════
describe("Owner reflection three questions", () => {
  it("PrincipleDetailPage renders ownerReflection section", () => {
    expect(principleDetailSrc).toMatch(/ownerReflection/);
  });

  it("all three reflection questions exist in both languages", () => {
    expect(getPagesKey("principles.detail.reflectionQ1")).toBeTruthy();
    expect(getPagesKey("principles.detail.reflectionQ2")).toBeTruthy();
    expect(getPagesKey("principles.detail.reflectionQ3")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.reflectionQ1")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.reflectionQ2")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.reflectionQ3")).toBeTruthy();
  });

  it("reflection questions reference the three required topics", () => {
    const q1 = String(getPagesKeyZh("principles.detail.reflectionQ1"));
    const q2 = String(getPagesKeyZh("principles.detail.reflectionQ2"));
    const q3 = String(getPagesKeyZh("principles.detail.reflectionQ3"));
    // Q1: repeated behavior
    expect(q1).toMatch(/反复出现|行为/);
    // Q2: channel activation
    expect(q2).toMatch(/通道|激活/);
    // Q3: rollback
    expect(q3).toMatch(/回滚|错了/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Validators use isRecord + Object.hasOwn + per-field checks (H section)
// ════════════════════════════════════════════════════════════════════════════
describe("Validators use isRecord + Object.hasOwn + per-field checks", () => {
  it("PrinciplesPage defines isRecord helper", () => {
    expect(principlesPageSrc).toMatch(/function isRecord/);
  });

  it("PrinciplesPage uses Object.hasOwn for key checks", () => {
    expect(principlesPageSrc).toMatch(/Object\.hasOwn/);
  });

  it("PrinciplesPage validates each principle element's required fields", () => {
    // Must check id, text, status, updatedAt, createdAt per item
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(item, "id"\)/);
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(item, "text"\)/);
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(item, "status"\)/);
  });

  it("PrinciplesPage validates each approval group element's fields", () => {
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(g, "principleId"\)/);
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(g, "status"\)/);
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(g, "records"\)/);
  });

  it("PrinciplesPage validates each approval record element's fields", () => {
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(r, "id"\)/);
    expect(principlesPageSrc).toMatch(/Object\.hasOwn\(r, "channel"\)/);
  });

  it("PrincipleDetailPage defines isRecord helper", () => {
    expect(principleDetailSrc).toMatch(/function isRecord/);
  });

  it("PrincipleDetailPage uses Object.hasOwn for key checks", () => {
    expect(principleDetailSrc).toMatch(/Object\.hasOwn/);
  });

  it("PrincipleDetailPage validates principle detail fields", () => {
    expect(principleDetailSrc).toMatch(/Object\.hasOwn\(raw, "id"\)/);
    expect(principleDetailSrc).toMatch(/Object\.hasOwn\(raw, "text"\)/);
    expect(principleDetailSrc).toMatch(/Object\.hasOwn\(raw, "status"\)/);
    expect(principleDetailSrc).toMatch(/rules/);
  });

  it("PrincipleDetailPage validates lifecycle adherence fields", () => {
    expect(principleDetailSrc).toMatch(/Object\.hasOwn\(a, "insufficientData"\)/);
    expect(principleDetailSrc).toMatch(/Object\.hasOwn\(a, "note"\)/);
  });

  it("no shallow 'as Record<string, unknown>' cast without isRecord guard", () => {
    // After the fix, the pattern "data as Record<string, unknown>" should not
    // appear in the new code (only the final "as unknown as T" after validation)
    const lines = principlesPageSrc.split("\n");
    for (const line of lines) {
      if (line.includes("as Record<string, unknown>") && !line.includes("is Record<string, unknown>")) {
        // This is a cast, not a type guard — should not exist in new code
        expect.fail(`Found shallow cast in PrinciplesPage: ${line.trim()}`);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Grouped decision applies to all records (P1 fix)
// ════════════════════════════════════════════════════════════════════════════
describe("Grouped decision applies to all records", () => {
  it("PrincipleDetailPage has applyDecisionToAllRecords function", () => {
    expect(principleDetailSrc).toMatch(/applyDecisionToAllRecords/);
  });

  it("applyDecisionToAllRecords iterates all records in the group", () => {
    expect(principleDetailSrc).toMatch(/for.*record.*of.*records/);
  });

  it("partial failure is reported with specific count (fail loud)", () => {
    expect(principleDetailSrc).toMatch(/partialFailure/);
    expect(principleDetailSrc).toMatch(/failedCount/);
    expect(principleDetailSrc).toMatch(/totalCount/);
  });

  it("partialFailure i18n key exists in both languages", () => {
    expect(getPagesKey("principles.detail.partialFailure")).toBeTruthy();
    expect(getPagesKeyZh("principles.detail.partialFailure")).toBeTruthy();
  });

  it("approve does NOT only process records[0]", () => {
    // The old pattern "approvalGroup.records[0]" should not appear in confirmApprove
    const approveSection = principleDetailSrc.substring(
      principleDetailSrc.indexOf("confirmApprove"),
      principleDetailSrc.indexOf("handleReject"),
    );
    expect(approveSection).not.toMatch(/records\[0\]/);
  });

  it("reject does NOT only process records[0]", () => {
    const rejectSection = principleDetailSrc.substring(
      principleDetailSrc.indexOf("confirmReject"),
      principleDetailSrc.indexOf("handlePark"),
    );
    expect(rejectSection).not.toMatch(/records\[0\]/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14. PrincipleDetail validator normalizes all page-accessed fields
// ════════════════════════════════════════════════════════════════════════════
describe("PrincipleDetail validator normalizes all page-accessed fields", () => {
  it("validator normalizes derivedFromPainIds with safeStringArray", () => {
    expect(principleDetailSrc).toMatch(/safeStringArray\(raw\.derivedFromPainIds\)/);
  });

  it("validator normalizes triggerPattern with safeString", () => {
    expect(principleDetailSrc).toMatch(/safeString\(raw\.triggerPattern\)/);
  });

  it("validator normalizes action with safeString", () => {
    expect(principleDetailSrc).toMatch(/safeString\(raw\.action\)/);
  });

  it("validator normalizes rules with safe default empty array", () => {
    expect(principleDetailSrc).toMatch(/Array\.isArray\(raw\.rules\).*raw\.rules.*:\s*\[\]/);
  });

  it("validator builds a normalized object, not raw data passthrough", () => {
    expect(principleDetailSrc).toMatch(/const normalized.*Record<string, unknown>/);
    expect(principleDetailSrc).toMatch(/return \{ principle: normalized \}/);
  });

  it("safeStringArray returns empty array for non-array input", () => {
    expect(principleDetailSrc).toMatch(/function safeStringArray/);
    expect(principleDetailSrc).toMatch(/if \(!Array\.isArray\(v\)\) return \[\]/);
  });

  it("safeStringArray filters elements to only strings", () => {
    expect(principleDetailSrc).toMatch(/v\.filter\(isString\)/);
  });

  it("page accesses derivedFromPainIds safely (won't crash if missing)", () => {
    // The page uses .length and .map() on derivedFromPainIds
    // After normalization, derivedFromPainIds is always string[]
    // Verify the page actually uses the field
    expect(principleDetailSrc).toMatch(/derivedFromPainIds\.length/);
    expect(principleDetailSrc).toMatch(/derivedFromPainIds\.map/);
    // And the validator ensures it's always a string array
    expect(principleDetailSrc).toMatch(/safeStringArray\(raw\.derivedFromPainIds\)/);
  });
});
