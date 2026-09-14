import { describe, expect, it } from "vitest";
import { clearStoredToken, loadStoredToken, storeToken } from "../token-storage.js";

/** Minimal in-memory Storage double (no window dependency). */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("token-storage (PRI-793)", () => {
  it("stores into localStorage and leaves no sessionStorage copy", () => {
    const main = fakeStorage();
    const legacy = fakeStorage();
    storeToken("tok-1", main, legacy);
    expect(main.getItem("pd_token")).toBe("tok-1");
    expect(legacy.getItem("pd_token")).toBe(null);
  });

  it("loads the persisted token across 'browser restarts'", () => {
    const main = fakeStorage();
    const legacy = fakeStorage();
    storeToken("tok-2", main, legacy);
    expect(loadStoredToken(main, legacy)).toBe("tok-2");
  });

  it("migrates a legacy sessionStorage token once, then owns it in localStorage only", () => {
    const main = fakeStorage();
    const legacy = fakeStorage();
    legacy.setItem("pd_token", "legacy-tok");
    expect(loadStoredToken(main, legacy)).toBe("legacy-tok");
    expect(main.getItem("pd_token")).toBe("legacy-tok");
    expect(legacy.getItem("pd_token")).toBe(null);
  });

  it("returns null when nothing is stored anywhere", () => {
    expect(loadStoredToken(fakeStorage(), fakeStorage())).toBe(null);
  });

  it("clear removes both storage copies so a stale token cannot resurrect", () => {
    const main = fakeStorage();
    const legacy = fakeStorage();
    storeToken("tok-3", main, legacy);
    legacy.setItem("pd_token", "stale");
    clearStoredToken(main, legacy);
    expect(main.getItem("pd_token")).toBe(null);
    expect(legacy.getItem("pd_token")).toBe(null);
    expect(loadStoredToken(main, legacy)).toBe(null);
  });

  it("re-login overwrites the persisted token", () => {
    const main = fakeStorage();
    const legacy = fakeStorage();
    storeToken("old", main, legacy);
    storeToken("new", main, legacy);
    expect(loadStoredToken(main, legacy)).toBe("new");
  });

  it("degrades gracefully when no Storage exists (non-DOM environment)", () => {
    expect(loadStoredToken(null, null)).toBe(null);
    expect(() => storeToken("tok", null, null)).not.toThrow();
    expect(() => clearStoredToken(null, null)).not.toThrow();
  });
});
