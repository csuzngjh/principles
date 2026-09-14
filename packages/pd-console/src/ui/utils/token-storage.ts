/**
 * Browser-side persistence for the Console login token (PRI-793).
 *
 * The token lives in localStorage so the Owner is not re-prompted on every
 * browser start. sessionStorage is only a migration source: a token left
 * there by older builds is promoted to localStorage once and then removed —
 * localStorage is the single source of truth afterwards (P4).
 *
 * Clearing (logout / Settings "清除凭证") removes both keys so a stale copy
 * can never resurrect the session.
 *
 * Storages are resolved from globalThis (browsers expose localStorage /
 * sessionStorage there) and may be absent — non-DOM test environments run
 * the same code path with null storages, where persistence degrades to
 * "no stored token" instead of crashing. Explicit arguments override the
 * builtins for tests.
 */

const TOKEN_KEY = "pd_token";

type TokenStorage = Storage | null | undefined;

function builtin(kind: "local" | "session"): Storage | null {
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  return (kind === "local" ? g.localStorage : g.sessionStorage) ?? null;
}

export function loadStoredToken(storage?: TokenStorage, legacy?: TokenStorage): string | null {
  const main = storage ?? builtin("local");
  const old = legacy ?? builtin("session");
  const current = main?.getItem(TOKEN_KEY) ?? null;
  if (current !== null) return current;
  const legacyToken = old?.getItem(TOKEN_KEY) ?? null;
  if (legacyToken === null) return null;
  main?.setItem(TOKEN_KEY, legacyToken);
  old?.removeItem(TOKEN_KEY);
  return legacyToken;
}

export function storeToken(token: string, storage?: TokenStorage, legacy?: TokenStorage): void {
  const main = storage ?? builtin("local");
  const old = legacy ?? builtin("session");
  main?.setItem(TOKEN_KEY, token);
  old?.removeItem(TOKEN_KEY);
}

export function clearStoredToken(storage?: TokenStorage, legacy?: TokenStorage): void {
  const main = storage ?? builtin("local");
  const old = legacy ?? builtin("session");
  main?.removeItem(TOKEN_KEY);
  old?.removeItem(TOKEN_KEY);
}
