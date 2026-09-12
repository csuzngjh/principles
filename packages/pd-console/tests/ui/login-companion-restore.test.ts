/**
 * Login auto-restore + credential lifecycle contract tests — Owner auth
 * experience simplification.
 *
 * Pattern: source-code contract tests for wiring (mirrors
 * auth-session-401.test.ts — the repo has no jsdom/browser UI test
 * environment). They lock the behavioral contract of the login form and the
 * settings credential section against the SPEC's acceptance criteria:
 *
 *   Case 1 (first entry): manual token entry persists into the Companion
 *     encrypted store on success; a failed persist is surfaced honestly.
 *   Case 2 (returning user): a stored Companion credential auto-connects
 *     with no user input; sessionStorage stays a mere session cache.
 *   Case 3 (invalid credential): a rejected stored credential shows a
 *     recovery path (retry + manual entry that updates the store).
 *
 * Bearer remains the only credential; no second auth source may appear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(__dirname, '..', '..', 'src', 'ui');

const loginSource = readFileSync(join(UI_ROOT, 'components', 'auth', 'login-form.tsx'), 'utf8');
const settingsSource = readFileSync(join(UI_ROOT, 'pages', 'settings', 'SettingsPage.tsx'), 'utf8');
const preloadContract = 'pdCompanion'; // bridge name shared by console + companion preload

describe('login form: companion auto-restore (returning user, Case 2)', () => {
  it('reads the stored credential through the pdCompanion bridge', () => {
    expect(loginSource).toContain(preloadContract);
    expect(loginSource).toContain('getConsoleToken()');
    expect(loginSource).toContain('status.available');
  });

  it('connects automatically: stored token → checkAuth → onAuthSuccess with no user input', () => {
    expect(loginSource).toContain('setToken(status.token)');
    expect(loginSource).toContain('const valid = await checkAuth()');
    expect(loginSource).toContain('onAuthSuccess()');
  });

  it('degrades to manual entry (never a dead end) when no companion or no stored credential', () => {
    expect(loginSource).toContain(`setPhase({ kind: "form" })`);
    expect(loginSource).toContain('companion === undefined');
  });

  it('a rejected stored credential routes to the recovery view, not a bare error', () => {
    expect(loginSource).toContain(`setPhase({ kind: "recovery" })`);
    expect(loginSource).toContain('login-recovery');
    expect(loginSource).toContain('重新连接');
  });
});

describe('login form: first entry persists the credential (Case 1)', () => {
  it('persists a successful manual login into the companion store', () => {
    expect(loginSource).toContain('configureConsoleToken(value)');
    expect(loginSource).toContain('await persistToCompanion(trimmed)');
  });

  it('surfaces persistence failure honestly — no fake success (rc-9)', () => {
    expect(loginSource).toContain('if (!result.persisted)');
    expect(loginSource).toContain('凭证未能安全保存');
  });

  it('no longer leads with the engineering Bearer Token label', () => {
    expect(loginSource).not.toContain('Bearer Token');
    expect(loginSource).not.toContain('id="bearer-token"');
    expect(loginSource).toContain('访问令牌');
  });
});

describe('login form: no second credential source', () => {
  it('keeps localStorage out of the long-term credential path', () => {
    expect(loginSource).not.toContain('localStorage');
    // sessionStorage only via the api.ts helpers (setToken/clearToken).
    expect(loginSource).not.toContain('sessionStorage.setItem');
    expect(loginSource).not.toContain('sessionStorage.getItem');
  });
});

describe('settings: credential lifecycle completion (clear / rollback)', () => {
  it('exposes a clear action wired to the companion bridge with inline confirm', () => {
    expect(settingsSource).toContain('clearConsoleToken()');
    expect(settingsSource).toContain('handleClearToken');
    expect(settingsSource).toContain('confirmClearToken');
  });

  it('clear also drops the browser session cache', () => {
    expect(settingsSource).toContain('clearToken();');
  });

  it('reports a failed clear honestly (rc-9)', () => {
    expect(settingsSource).toContain('if (!result.cleared)');
    expect(settingsSource).toContain('tokenClearFailed');
  });
});
