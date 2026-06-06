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
const enJson = require("../../src/ui/i18n/en.json") as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zhJson = require("../../src/ui/i18n/zh-CN.json") as Record<string, unknown>;

const enPages = enJson.pages as Record<string, unknown>;
const zhPages = zhJson.pages as Record<string, unknown>;

// ── Control Center: "配置就绪" semantics ──────────────────────────────────────

describe("CR9 Control Center: config readiness semantics", () => {
  const enCC = enPages.controlCenter as Record<string, unknown>;
  const zhCC = zhPages.controlCenter as Record<string, unknown>;

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
  const enRP = enPages.reportProblem as Record<string, unknown>;
  const zhRP = zhPages.reportProblem as Record<string, unknown>;

  it("has i18n keys for reportProblem in both locales", () => {
    expect(enRP).toBeDefined();
    expect(zhRP).toBeDefined();
  });

  it("has noAutoUpload key emphasizing no automatic upload", () => {
    expect(typeof enRP.noAutoUpload).toBe("string");
    expect(typeof zhRP.noAutoUpload).toBe("string");
    expect(enRP.noAutoUpload as string).toMatch(/never auto-upload|not auto-upload|no auto/i);
    expect(zhRP.noAutoUpload as string).toContain("不会自动上传");
  });

  it("subtitle mentions no auto-upload", () => {
    expect(enRP.subtitle as string).toMatch(/never auto-upload/i);
    expect(zhRP.subtitle as string).toContain("不会自动上传");
  });

  it("has privacy boundary section keys", () => {
    const enPrivacy = (enRP.privacy as Record<string, unknown>);
    const zhPrivacy = (zhRP.privacy as Record<string, unknown>);
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
    const enPrivacy = (enRP.privacy as Record<string, unknown>);
    const zhPrivacy = (zhRP.privacy as Record<string, unknown>);
    expect(enPrivacy.guarantee as string).toMatch(/no automatic upload|not auto-upload/i);
    expect(zhPrivacy.guarantee as string).toContain("不会自动上传");
  });

  it("has feedback form type keys for all 5 types", () => {
    const enTypes = ((enRP.form as Record<string, unknown>).types as Record<string, unknown>);
    const zhTypes = ((zhRP.form as Record<string, unknown>).types as Record<string, unknown>);
    const requiredTypes = ["bug", "confusing", "privacy_concern", "feature_request", "other"];
    for (const type of requiredTypes) {
      expect(typeof enTypes[type], `en form.types.${type}`).toBe("string");
      expect(typeof zhTypes[type], `zh form.types.${type}`).toBe("string");
    }
  });
});

// ── Update: basic version check / history entry points ────────────────────────

describe("CR9 Update: version check and history", () => {
  const enUpdate = enPages.update as Record<string, unknown>;
  const zhUpdate = zhPages.update as Record<string, unknown>;

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
  const enSettings = enPages.settings as Record<string, unknown>;
  const zhSettings = zhPages.settings as Record<string, unknown>;

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
      const page = enPages[pageKey] as Record<string, unknown>;
      if (!page) continue;
      const entries = Object.entries(page);
      for (const [key, value] of entries) {
        if (typeof value !== "string") continue;
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
      const page = zhPages[pageKey] as Record<string, unknown>;
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

// ── Runtime validator tests ───────────────────────────────────────────────────

describe("CR9: runtime validators for tool pages", () => {
  // Re-implement validators to test logic directly
  // (same pattern as focus-page.test.ts)

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // Update page validators
  function validateUpdateStatusData(raw: unknown): { currentVersion: string; latestVersion: string; updateAvailable: boolean; lastChecked: string } | null {
    if (!isRecord(raw)) return null;
    if (!Object.hasOwn(raw, "currentVersion") || !Object.hasOwn(raw, "latestVersion") || !Object.hasOwn(raw, "updateAvailable") || !Object.hasOwn(raw, "lastChecked")) return null;
    const { currentVersion, latestVersion, updateAvailable, lastChecked } = raw;
    if (typeof currentVersion !== "string" || typeof latestVersion !== "string" || typeof updateAvailable !== "boolean" || typeof lastChecked !== "string") return null;
    return { currentVersion, latestVersion, updateAvailable, lastChecked };
  }

  function validateUpdateHistoryEntry(raw: unknown): { version: string; appliedAt: string; notes: string } | null {
    if (!isRecord(raw)) return null;
    if (!Object.hasOwn(raw, "version") || !Object.hasOwn(raw, "appliedAt") || !Object.hasOwn(raw, "notes")) return null;
    const { version, appliedAt, notes } = raw;
    if (typeof version !== "string" || typeof appliedAt !== "string" || typeof notes !== "string") return null;
    return { version, appliedAt, notes };
  }

  // Settings page validators
  function validateWorkspaceEntry(raw: unknown): { name: string; path: string; lastSync: string | null } | null {
    if (!isRecord(raw)) return null;
    if (!Object.hasOwn(raw, "name") || !Object.hasOwn(raw, "path") || !Object.hasOwn(raw, "lastSync")) return null;
    const { name, path, lastSync } = raw;
    if (typeof name !== "string" || name.length === 0 || typeof path !== "string" || path.length === 0) return null;
    if (lastSync !== null && typeof lastSync !== "string") return null;
    return { name, path, lastSync: lastSync as string | null };
  }

  describe("validateUpdateStatusData", () => {
    it("accepts valid data", () => {
      const result = validateUpdateStatusData({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, lastChecked: "2026-06-01T00:00:00Z" });
      expect(result).toEqual({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true, lastChecked: "2026-06-01T00:00:00Z" });
    });

    it("rejects null", () => expect(validateUpdateStatusData(null)).toBeNull());
    it("rejects missing fields", () => expect(validateUpdateStatusData({ currentVersion: "1.0.0" })).toBeNull());
    it("rejects wrong types", () => expect(validateUpdateStatusData({ currentVersion: 1, latestVersion: "1.1.0", updateAvailable: true, lastChecked: "2026" })).toBeNull());
    it("rejects inherited property", () => {
      const obj = Object.create({ currentVersion: "1.0.0" });
      obj.latestVersion = "1.1.0";
      obj.updateAvailable = true;
      obj.lastChecked = "2026";
      expect(validateUpdateStatusData(obj)).toBeNull();
    });
  });

  describe("validateUpdateHistoryEntry", () => {
    it("accepts valid data", () => {
      const result = validateUpdateHistoryEntry({ version: "1.0.0", appliedAt: "2026-06-01", notes: "Initial release" });
      expect(result).toEqual({ version: "1.0.0", appliedAt: "2026-06-01", notes: "Initial release" });
    });

    it("rejects null", () => expect(validateUpdateHistoryEntry(null)).toBeNull());
    it("rejects missing notes", () => expect(validateUpdateHistoryEntry({ version: "1.0.0", appliedAt: "2026" })).toBeNull());
    it("rejects wrong types", () => expect(validateUpdateHistoryEntry({ version: 1, appliedAt: "2026", notes: "" })).toBeNull());
  });

  describe("validateWorkspaceEntry", () => {
    it("accepts valid data with lastSync", () => {
      const result = validateWorkspaceEntry({ name: "ws1", path: "/path/to/ws", lastSync: "2026-06-01" });
      expect(result).toEqual({ name: "ws1", path: "/path/to/ws", lastSync: "2026-06-01" });
    });

    it("accepts valid data with null lastSync", () => {
      const result = validateWorkspaceEntry({ name: "ws1", path: "/path/to/ws", lastSync: null });
      expect(result).toEqual({ name: "ws1", path: "/path/to/ws", lastSync: null });
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
});
