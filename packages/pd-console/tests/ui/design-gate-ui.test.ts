import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getNestedRecord, parseJsonRecord } from "./i18n-test-helper.js";

const testsDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(testsDir, "..", "..", "src", "ui");
const readSrc = (path: string) => readFileSync(join(srcRoot, path), "utf8");
const component = readSrc("pages/control-center/DesignGatePanel.tsx");
const page = readSrc("pages/control-center/ControlCenterPage.tsx");

describe("Control Center local Codex Design Gate panel", () => {
  it("is reachable from the existing Control Center page and uses the observed-session API", () => {
    expect(page).toContain("<DesignGatePanel />");
    expect(component).toContain("fetchDesignGateSessions()");
    expect(component).toContain("fetchDesignGateDeclaration(");
    expect(component).toContain("createDesignGateDeclaration({");
  });

  it("keeps decision changes revision-bound and refreshes on a stale revision conflict", () => {
    expect(component).toContain("updateDesignGateDecision(declaration.sourceRef, declaration.revision");
    expect(component).toContain("revokeDesignGateDeclaration(declaration.sourceRef, declaration.revision)");
    expect(component).toContain("result.status === 409");
    expect(component).toContain("await loadDeclaration(selectedSession)");
  });

  it("shows project paths, action scope, SPEC snapshot and the limit of an Owner declaration", () => {
    for (const field of ["declaration.specPath", "declaration.specDigest", "declaration.scope.paths", "declaration.scope.actions", "declaration.actor.ownerId"]) {
      expect(component).toContain(field);
    }
    expect(component).toContain("designGate.semanticLimit");
    expect(component).toContain("designGate.revokedLatest");
  });

  it("has translated labels and decision/action states in both supported locales", () => {
    const en = getNestedRecord(parseJsonRecord(readSrc("i18n/en.json")), ["pages", "controlCenter", "designGate"]);
    const zh = getNestedRecord(parseJsonRecord(readSrc("i18n/zh-CN.json")), ["pages", "controlCenter", "designGate"]);
    for (const locale of [en, zh]) {
      expect(typeof locale.title).toBe("string");
      expect(typeof locale.description).toBe("string");
      expect(typeof locale.semanticLimit).toBe("string");
      expect(typeof locale.scopePathsHelp).toBe("string");
      expect(typeof locale.approve).toBe("string");
      expect(typeof locale.markPending).toBe("string");
      expect(typeof locale.revoke).toBe("string");
      expect(getNestedRecord(locale, ["decisions"]).approved).toBeDefined();
      expect(getNestedRecord(locale, ["decisions"]).notApproved).toBeDefined();
      expect(getNestedRecord(locale, ["decisions"]).notRequired).toBeDefined();
      expect(getNestedRecord(locale, ["actions"]).read).toBeDefined();
      expect(getNestedRecord(locale, ["actions"]).write).toBeDefined();
      expect(getNestedRecord(locale, ["actions"]).execute).toBeDefined();
    }
    expect(en.semanticLimit).toContain("does not sandbox process effects");
    expect(en.semanticLimit).toContain("remain unknown");
    expect(zh.semanticLimit).toContain("不会沙箱化进程副作用");
    expect(zh.semanticLimit).toContain("仍属未知");
  });
});
