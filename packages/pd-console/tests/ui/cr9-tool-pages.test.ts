/**
 * CR9 Tool Pages alignment tests — PRI-318
 *
 * Validates:
 * - Control Center uses "配置就绪" semantics, not global health
 * - Feedback page has privacy boundary and "不自动上传" guarantee
 * - Update page has basic version check / history entry points
 * - Settings page has auth token and workspace management entry points
 * - i18n keys exist in both en and zh-CN with no forbidden terms
 * - No mixed zh/en in i18n values
 * - Runtime validators reject invalid data
 */

import { describe, it, expect } from "vitest";

// ── i18n copy validation ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const enJsonUnknown: unknown = require("../../src/ui/i18n/en.json");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zhJsonUnknown: unknown = require("../../src/ui/i18n/zh-CN.json");

/** Runtime guard: assert value is a non-null object with own properties (EP-01 / ERR-001/013) */
function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a non-null object, got ${typeof value}`);
  }
  return value;
}

const enJson = expectRecord(enJsonUnknown, "enJson");
const zhJson = expectRecord(zhJsonUnknown, "zhJson");

if (!Object.hasOwn(enJson, "pages")) throw new Error("enJson must contain 'pages'");
if (!Object.hasOwn(zhJson, "pages")) throw new Error("zhJson must contain 'pages'");

const enPages = expectRecord(enJson.pages, "enJson.pages");
const zhPages = expectRecord(zhJson.pages, "zhJson.pages");

// ── Control Center: "配置就绪" semantics ──────────────────────────────────────

describe("CR9 Control Center: config readiness semantics", () => {
  const enCC = expectRecord(enPages.controlCenter, "enPages.controlCenter");
  const zhCC = expectRecord(zhPages.controlCenter, "zhPages.controlCenter");

  it("has i18n keys for controlCenter in both locales", () => {
    expect(enCC).toBeDefined();
    expect(zhCC).toBeDefined();
    expect(Object.keys(enCC).length).toBeGreaterThan(0);
    expect(Object.keys(zhCC).length).toBeGreaterThan(0);
  });

  it("title is 'Config Readiness' / '配置就绪', not global health", () => {
    expect(enCC.title).toBe("Config Readiness");
    expect(zhCC.title).toBe("配置就绪");
  });

  it("subtitle explicitly says 'not a system health dashboard'", () => {
    expect(enCC.subtitle).toContain("not a system health dashboard");
    expect(zhCC.subtitle).toContain("不是系统健康面板");
  });

  it("has readiness status messages for all states", () => {
    const requiredKeys = [
      "configReady",
      "configNeedsSetup",
      "configNotReady",
      "configUnknown",
      "configDisabled",
    ];
    for (const key of requiredKeys) {
      expect(typeof enCC[key], `en.controlCenter.${key} should be string`).toBe("string");
      expect(typeof zhCC[key], `zh.controlCenter.${key} should be string`).toBe("string");
    }
  });

  it("does not contain positive 'global health' or '系统健康大屏' claims", () => {
    // The subtitle explicitly says "not a system health dashboard" which is allowed
    // Only forbid positive/affirmative usage of these terms
    const forbidden = ["系统健康大屏", "健康大屏"];
    const forbiddenPositiveEn = ["global health status", "system health overview"];
    const allValues = Object.values(enCC).concat(Object.values(zhCC));
    for (const val of allValues) {
      if (typeof val !== "string") continue;
      for (const term of forbidden) {
        expect(val, `should not contain "${term}"`).not.toContain(term);
      }
      for (const term of forbiddenPositiveEn) {
        expect(val, `should not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("has advanced diagnostics key", () => {
    expect(typeof enCC.advancedDiagnostics).toBe("string");
    expect(typeof zhCC.advancedDiagnostics).toBe("string");
  });

  it("has copy diagnostics and redacted note keys", () => {
    expect(typeof enCC.copyDiagnostics).toBe("string");
    expect(typeof enCC.redactedNote).toBe("string");
    expect(typeof zhCC.copyDiagnostics).toBe("string");
    expect(typeof zhCC.redactedNote).toBe("string");
  });
});

// ── Feedback: privacy boundary and no-auto-upload ─────────────────────────────

describe("CR9 Feedback: privacy boundary and no-auto-upload", () => {
  const enRP = expectRecord(enPages.reportProblem, "enPages.reportProblem");
  const zhRP = expectRecord(zhPages.reportProblem, "zhPages.reportProblem");

  it("has i18n keys for reportProblem in both locales", () => {
    expect(enRP).toBeDefined();
    expect(zhRP).toBeDefined();
  });

  it("has noAutoUpload key emphasizing no automatic upload", () => {
    expect(typeof enRP.noAutoUpload).toBe("string");
    expect(typeof zhRP.noAutoUpload).toBe("string");
    expect(String(enRP.noAutoUpload)).toMatch(/never auto-upload|not auto-upload|no auto/i);
    expect(String(zhRP.noAutoUpload)).toContain("不会自动上传");
  });

  it("subtitle mentions no auto-upload", () => {
    expect(String(enRP.subtitle)).toMatch(/never auto-upload/i);
    expect(String(zhRP.subtitle)).toContain("不会自动上传");
  });

  it("has privacy boundary section keys", () => {
    const enPrivacy = expectRecord(enRP.privacy, "enRP.privacy");
    const zhPrivacy = expectRecord(zhRP.privacy, "zhRP.privacy");
    expect(typeof enPrivacy.title).toBe("string");
    expect(typeof enPrivacy.included).toBe("string");
    expect(typeof enPrivacy.excluded).toBe("string");
    expect(typeof enPrivacy.guarantee).toBe("string");
    expect(typeof zhPrivacy.title).toBe("string");
    expect(typeof zhPrivacy.included).toBe("string");
    expect(typeof zhPrivacy.excluded).toBe("string");
    expect(typeof zhPrivacy.guarantee).toBe("string");
  });

  it("guarantee mentions no automatic upload", () => {
    const enPrivacy = expectRecord(enRP.privacy, "enRP.privacy");
    const zhPrivacy = expectRecord(zhRP.privacy, "zhRP.privacy");
    expect(String(enPrivacy.guarantee)).toMatch(/no automatic upload|not auto-upload/i);
    expect(String(zhPrivacy.guarantee)).toContain("不会自动上传");
  });

  it("has feedback form type keys for all 5 types", () => {
    const enTypes = expectRecord(expectRecord(enRP.form, "enRP.form").types, "enRP.form.types");
    const zhTypes = expectRecord(expectRecord(zhRP.form, "zhRP.form").types, "zhRP.form.types");
    const requiredTypes = ["bug", "confusing", "privacy_concern", "feature_request", "other"];
    for (const type of requiredTypes) {
      expect(typeof enTypes[type], `en form.types.${type}`).toBe("string");
      expect(typeof zhTypes[type], `zh form.types.${type}`).toBe("string");
    }
  });
});

// ── Update: basic version check / history entry points ────────────────────────

describe("CR9 Update: version check and history", () => {
  const enUpdate = expectRecord(enPages.update, "enPages.update");
  const zhUpdate = expectRecord(zhPages.update, "zhPages.update");

  it("has i18n keys for update page in both locales", () => {
    expect(enUpdate).toBeDefined();
    expect(zhUpdate).toBeDefined();
  });

  it("has version display keys", () => {
    expect(typeof enUpdate.currentVersion).toBe("string");
    expect(typeof enUpdate.latestVersion).toBe("string");
    expect(typeof zhUpdate.currentVersion).toBe("string");
    expect(typeof zhUpdate.latestVersion).toBe("string");
  });

  it("has update status tags", () => {
    expect(typeof enUpdate.upToDate).toBe("string");
    expect(typeof enUpdate.updateAvailable).toBe("string");
    expect(typeof zhUpdate.upToDate).toBe("string");
    expect(typeof zhUpdate.updateAvailable).toBe("string");
  });

  it("has check for updates button key", () => {
    expect(typeof enUpdate.checkForUpdates).toBe("string");
    expect(typeof zhUpdate.checkForUpdates).toBe("string");
  });

  it("has update history keys", () => {
    expect(typeof enUpdate.history).toBe("string");
    expect(typeof enUpdate.noHistory).toBe("string");
    expect(typeof zhUpdate.history).toBe("string");
    expect(typeof zhUpdate.noHistory).toBe("string");
  });
});

// ── Settings: auth token and workspace management ─────────────────────────────

describe("CR9 Settings: auth and workspace management", () => {
  const enSettings = expectRecord(enPages.settings, "enPages.settings");
  const zhSettings = expectRecord(zhPages.settings, "zhPages.settings");

  it("has i18n keys for settings page in both locales", () => {
    expect(enSettings).toBeDefined();
    expect(zhSettings).toBeDefined();
  });

  it("has auth token management keys", () => {
    expect(typeof enSettings.bearerToken).toBe("string");
    expect(typeof enSettings.enterAccessToken).toBe("string");
    expect(typeof enSettings.tokenSaved).toBe("string");
    expect(typeof enSettings.tokenSessionOnly).toBe("string");
    expect(typeof zhSettings.bearerToken).toBe("string");
    expect(typeof zhSettings.enterAccessToken).toBe("string");
    expect(typeof zhSettings.tokenSaved).toBe("string");
    expect(typeof zhSettings.tokenSessionOnly).toBe("string");
  });

  it("has workspace management keys", () => {
    expect(typeof enSettings.workspace).toBe("string");
    expect(typeof enSettings.addWorkspace).toBe("string");
    expect(typeof enSettings.syncWorkspace).toBe("string");
    expect(typeof enSettings.removeWorkspace).toBe("string");
    expect(typeof zhSettings.workspace).toBe("string");
    expect(typeof zhSettings.addWorkspace).toBe("string");
    expect(typeof zhSettings.syncWorkspace).toBe("string");
    expect(typeof zhSettings.removeWorkspace).toBe("string");
  });

  it("has inline confirm delete keys", () => {
    expect(typeof enSettings.confirmDeleteTitle).toBe("string");
    expect(typeof enSettings.confirmDeleteDescription).toBe("string");
    expect(typeof zhSettings.confirmDeleteTitle).toBe("string");
    expect(typeof zhSettings.confirmDeleteDescription).toBe("string");
  });
});

// ── No mixed zh/en in i18n values ────────────────────────────────────────────

describe("CR9: no mixed zh/en in i18n values", () => {
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  const toolPageKeys = ["controlCenter", "settings", "reportProblem", "update"];

  it("English i18n tool page keys contain no Chinese characters", () => {
    for (const pageKey of toolPageKeys) {
      const page = expectRecord(enPages[pageKey], `enPages.${pageKey}`);
      if (!page) continue;
      const entries = Object.entries(page);
      // languageZhCN intentionally contains native CJK name for the language picker
      const ALLOWED_CJK_KEYS = ['languageZhCN'];
      for (const [key, value] of entries) {
        if (typeof value !== "string") continue;
        if (ALLOWED_CJK_KEYS.includes(key)) continue;
        // Skip nested objects like form.types
        expect(value, `en.pages.${pageKey}.${key} should not contain Chinese`).not.toMatch(cjkPattern);
      }
    }
  });

  it("Chinese i18n tool page keys contain no raw English UI terms", () => {
    // We check for obviously untranslated English UI terms in zh values
    // (not technical terms like "Bearer" or "Markdown" which are proper nouns)
    const rawEnglishPattern = /\b(the|this|your|will|should|must|can|cannot|click|button|page|section)\b/i;
    for (const pageKey of toolPageKeys) {
      const page = expectRecord(zhPages[pageKey], `zhPages.${pageKey}`);
      if (!page) continue;
      const entries = Object.entries(page);
      for (const [key, value] of entries) {
        if (typeof value !== "string") continue;
        // Skip proper nouns and technical terms
        if (key === "bearerToken" || key === "copyMarkdown" || key === "openGithub") continue;
        expect(value, `zh.pages.${pageKey}.${key} should not contain raw English UI terms`).not.toMatch(rawEnglishPattern);
      }
    }
  });
});

// ── Component import tests ────────────────────────────────────────────────────

describe("CR9: tool page components can be imported", () => {
  it("imports ControlCenterPage without error", async () => {
    const mod = await import("../../src/ui/pages/control-center/ControlCenterPage.js");
    expect(mod.ControlCenterPage).toBeDefined();
    expect(typeof mod.ControlCenterPage).toBe("function");
  });

  it("imports SettingsPage without error", async () => {
    const mod = await import("../../src/ui/pages/settings/SettingsPage.js");
    expect(mod.SettingsPage).toBeDefined();
    expect(typeof mod.SettingsPage).toBe("function");
  });

  it("imports ReportProblemPage without error", async () => {
    const mod = await import("../../src/ui/pages/report-problem/ReportProblemPage.js");
    expect(mod.ReportProblemPage).toBeDefined();
    expect(typeof mod.ReportProblemPage).toBe("function");
  });

  it("imports UpdatePage without error", async () => {
    const mod = await import("../../src/ui/pages/settings/UpdatePage.js");
    expect(mod.UpdatePage).toBeDefined();
    expect(typeof mod.UpdatePage).toBe("function");
  });
});

// ── Runtime validator tests (production imports, not re-implementations) ──────

import { validateUpdateStatus, validateUpdateHistoryEntry, validateUpdateHistory } from "../../src/ui/utils/validators.js";
import { validateWorkspaceEntry, validateWorkspaceArray } from "../../src/ui/pages/settings/SettingsPage.js";
import { parseDraftSummary, parseDraftRecord } from "../../src/ui/pages/ReportProblemValidators.js";

describe("CR9: runtime validators for tool pages", () => {

  describe("validateUpdateStatus", () => {
    it("accepts valid data", () => {
      const result = validateUpdateStatus({ currentVersion: "1.0.0", latestVersion: "1.1.0", hasUpdate: true });
      expect(result).toEqual({ currentVersion: "1.0.0", latestVersion: "1.1.0", hasUpdate: true });
    });

    it("accepts valid data with optional error", () => {
      const result = validateUpdateStatus({ currentVersion: "1.0.0", latestVersion: "1.1.0", hasUpdate: false, error: "registry unreachable" });
      expect(result).not.toBeNull();
      expect(result!.error).toBe("registry unreachable");
    });

    it("rejects null", () => expect(validateUpdateStatus(null)).toBeNull());
    it("rejects missing fields", () => expect(validateUpdateStatus({ currentVersion: "1.0.0" })).toBeNull());
    it("rejects wrong types", () => expect(validateUpdateStatus({ currentVersion: 1, latestVersion: "1.1.0", hasUpdate: true })).toBeNull());
    it("rejects inherited property", () => {
      const obj = Object.create({ currentVersion: "1.0.0" });
      obj.latestVersion = "1.1.0";
      obj.hasUpdate = true;
      expect(validateUpdateStatus(obj)).toBeNull();
    });
  });

  describe("validateUpdateHistoryEntry", () => {
    it("accepts valid data", () => {
      const result = validateUpdateHistoryEntry({ id: "upd-1", timestamp: "2026-06-01T00:00:00Z", fromVersion: "1.0.0", toVersion: "1.1.0", success: true, kind: "update" });
      expect(result).toEqual({ id: "upd-1", timestamp: "2026-06-01T00:00:00Z", fromVersion: "1.0.0", toVersion: "1.1.0", success: true, kind: "update" });
    });

    it("rejects null", () => expect(validateUpdateHistoryEntry(null)).toBeNull());
    it("rejects missing fields", () => expect(validateUpdateHistoryEntry({ id: "upd-1", timestamp: "2026" })).toBeNull());
    it("rejects wrong types", () => expect(validateUpdateHistoryEntry({ id: 1, timestamp: "2026", fromVersion: "1.0.0", toVersion: "1.1.0", success: true })).toBeNull());
    it("rejects non-boolean success", () => expect(validateUpdateHistoryEntry({ id: "upd-1", timestamp: "2026", fromVersion: "1.0.0", toVersion: "1.1.0", success: "yes" })).toBeNull());
    it("rejects an unknown event kind", () => expect(validateUpdateHistoryEntry({ id: "upd-1", timestamp: "2026", fromVersion: "1.0.0", toVersion: "1.1.0", success: false, kind: "unknown" })).toBeNull());
  });

  describe("validateUpdateHistory", () => {
    it("accepts valid { updates: [...] } shape", () => {
      const result = validateUpdateHistory({ updates: [{ id: "upd-1", timestamp: "2026-06-01", fromVersion: "1.0.0", toVersion: "1.1.0", success: true, kind: "update" }] });
      expect(result).not.toBeNull();
      expect(result!.updates).toHaveLength(1);
    });

    it("accepts bare array shape (backend contract)", () => {
      const result = validateUpdateHistory([{ id: "upd-1", timestamp: "2026-06-01", fromVersion: "1.0.0", toVersion: "1.1.0", success: true, kind: "update" }]);
      expect(result).not.toBeNull();
      expect(result!.updates).toHaveLength(1);
    });

    it("rejects null", () => expect(validateUpdateHistory(null)).toBeNull());
    it("rejects non-array updates field", () => expect(validateUpdateHistory({ updates: "not-array" })).toBeNull());
    it("rejects invalid entry in updates array", () => expect(validateUpdateHistory({ updates: [{ id: 1 }] })).toBeNull());
  });

  describe("validateWorkspaceEntry", () => {
    it("accepts valid data with lastSync", () => {
      const result = validateWorkspaceEntry({ name: "ws1", path: "/path/to/ws", lastSync: "2026-06-01" });
      expect(result).not.toBeNull();
      expect(result!.name).toBe("ws1");
      expect(result!.path).toBe("/path/to/ws");
      expect(result!.lastSync).toBe("2026-06-01");
    });

    it("accepts valid data with null lastSync", () => {
      const result = validateWorkspaceEntry({ name: "ws1", path: "/path/to/ws", lastSync: null });
      expect(result).not.toBeNull();
      expect(result!.lastSync).toBeNull();
    });

    it("accepts valid data with config", () => {
      const result = validateWorkspaceEntry({
        name: "ws1", path: "/path", lastSync: null,
        config: { workspaceName: "ws1", enabled: true, syncEnabled: false },
      });
      expect(result).not.toBeNull();
      expect(result!.config).not.toBeNull();
      expect(result!.config!.workspaceName).toBe("ws1");
    });

    it("rejects null", () => expect(validateWorkspaceEntry(null)).toBeNull());
    it("rejects empty name", () => expect(validateWorkspaceEntry({ name: "", path: "/path", lastSync: null })).toBeNull());
    it("rejects empty path", () => expect(validateWorkspaceEntry({ name: "ws1", path: "", lastSync: null })).toBeNull());
    it("rejects non-string lastSync", () => expect(validateWorkspaceEntry({ name: "ws1", path: "/path", lastSync: 123 })).toBeNull());
    it("rejects inherited property", () => {
      const obj = Object.create({ name: "inherited" });
      obj.path = "/path";
      obj.lastSync = null;
      expect(validateWorkspaceEntry(obj)).toBeNull();
    });
  });

  describe("validateWorkspaceArray", () => {
    it("accepts valid array", () => {
      const result = validateWorkspaceArray([{ name: "ws1", path: "/p", lastSync: null }]);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
    });

    it("rejects null", () => expect(validateWorkspaceArray(null)).toBeNull());
    it("rejects non-array", () => expect(validateWorkspaceArray("not-array")).toBeNull());
    it("rejects array with invalid entry", () => expect(validateWorkspaceArray([{ name: "" }])).toBeNull());
  });

  describe("parseDraftSummary", () => {
    it("accepts valid data", () => {
      const result = parseDraftSummary({ id: "abc", createdAt: "2026-06-01", type: "bug", title: "Test" });
      expect(result).toEqual({ id: "abc", createdAt: "2026-06-01", type: "bug", title: "Test" });
    });

    it("rejects null", () => expect(parseDraftSummary(null)).toBeNull());
    it("rejects missing fields", () => expect(parseDraftSummary({ id: "abc" })).toBeNull());
    it("rejects wrong types", () => expect(parseDraftSummary({ id: 1, createdAt: "2026", type: "bug", title: "T" })).toBeNull());
  });

  describe("parseDraftRecord", () => {
    const validRecord = {
      id: "r1",
      createdAt: "2026-06-01",
      type: "bug" as const,
      title: "A bug",
      userText: { description: "Something broke" },
      diagnosticSummary: {},
      privacy: { includedSections: ["versions"], excludedByDefault: ["secrets"], redactionNotes: [] },
      outputs: { markdown: "# Bug", emailText: "email", githubIssueUrl: "https://github.com/issue/1" },
    };

    it("accepts valid data", () => {
      const result = parseDraftRecord(validRecord);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("r1");
      expect(result!.type).toBe("bug");
      expect(result!.outputs.markdown).toBe("# Bug");
    });

    it("rejects null", () => expect(parseDraftRecord(null)).toBeNull());
    it("rejects missing required fields", () => expect(parseDraftRecord({ id: "r1" })).toBeNull());
    it("rejects invalid type value", () => {
      const result = parseDraftRecord({ ...validRecord, type: "invalid_type" });
      expect(result).toBeNull();
    });
    it("rejects missing outputs fields", () => {
      const result = parseDraftRecord({ ...validRecord, outputs: { markdown: "# Bug" } });
      expect(result).toBeNull();
    });
    it("rejects missing privacy array fields", () => {
      const result = parseDraftRecord({ ...validRecord, privacy: { includedSections: [123], excludedByDefault: [], redactionNotes: [] } });
      expect(result).toBeNull();
    });
  });
});
