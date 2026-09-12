/**
 * Login auto-restore + credential lifecycle contract tests — Owner auth
 * experience simplification (PR #1635).
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
 * All login copy is routed through i18n (`pages.login.*`, both locales) so
 * English users are not shown hardcoded Chinese. Bearer remains the only
 * credential; no second auth source may appear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(__dirname, '..', '..', 'src', 'ui');

const loginSource = readFileSync(join(UI_ROOT, 'components', 'auth', 'login-form.tsx'), 'utf8');
const settingsSource = readFileSync(join(UI_ROOT, 'pages', 'settings', 'SettingsPage.tsx'), 'utf8');
const zh = JSON.parse(readFileSync(join(UI_ROOT, 'i18n', 'zh-CN.json'), 'utf8')) as {
  pages: { login: Record<string, string>; settings: Record<string, string> };
};
const en = JSON.parse(readFileSync(join(UI_ROOT, 'i18n', 'en.json'), 'utf8')) as typeof zh;

const LOGIN_KEYS = [
  'connectWorkspace',
  'detecting',
  'connecting',
  'accessToken',
  'enterAccessToken',
  'connect',
  'errorInvalid',
  'errorExpired',
  'recoveryTitle',
  'recoveryReason',
  'reconnect',
  'manualEntry',
  'manualEntryHint',
  'readFailedTitle',
  'readFailedHint',
  'persistFailed',
  'persistSucceeded',
  'persistAttached',
] as const;

describe('login form: companion auto-restore (returning user, Case 2)', () => {
  it('reads the stored credential through the pdCompanion bridge', () => {
    expect(loginSource).toContain('pdCompanion');
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
    expect(loginSource).toContain('t("pages.login.reconnect")');
  });

  it('a failed credential read surfaces a diagnosable note instead of a silent plain form (rc-9)', () => {
    expect(loginSource).toContain(`setPhase({ kind: "form-with-read-error" })`);
    expect(loginSource).toContain('t("pages.login.readFailedTitle")');
    expect(loginSource).toContain('t("pages.login.readFailedHint")');
  });
});

describe('login form: first entry persists the credential (Case 1)', () => {
  it('persists a successful manual login into the companion store', () => {
    expect(loginSource).toContain('configureConsoleToken(value)');
    expect(loginSource).toContain('await persistToCompanion(trimmed)');
  });

  it('surfaces persistence failure honestly — no fake success (rc-9)', () => {
    expect(loginSource).toContain('if (!result.persisted)');
    expect(loginSource).toContain('t("pages.login.persistFailed")');
  });

  it('no longer leads with the engineering Bearer Token label', () => {
    expect(loginSource).not.toContain('Bearer Token');
    expect(loginSource).not.toContain('id="bearer-token"');
    expect(loginSource).toContain('t("pages.login.accessToken")');
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

describe('login form: i18n contract', () => {
  it('routes every visible string through pages.login keys — no hardcoded UI copy', () => {
    // Every t() key used by the login form must exist in BOTH locales.
    const used = [...loginSource.matchAll(/t\("pages\.login\.([A-Za-z0-9]+)"\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThanOrEqual(10);
    for (const key of used) {
      expect(zh.pages.login[key], `zh missing pages.login.${key}`).toBeDefined();
      expect(en.pages.login[key], `en missing pages.login.${key}`).toBeDefined();
    }
  });

  it('defines the full login key set in both locales (zh/en parity)', () => {
    for (const key of LOGIN_KEYS) {
      expect(zh.pages.login[key], `zh missing pages.login.${key}`).toBeDefined();
      expect(en.pages.login[key], `en missing pages.login.${key}`).toBeDefined();
    }
  });

  it('drops the retired password-flow / Bearer labels from pages.login', () => {
    // The block previously held an unused password-login vocabulary and the
    // engineering Bearer label; they must not come back with the new flow.
    expect(zh.pages.login.password).toBeUndefined();
    expect(en.pages.login.bearerToken).toBeUndefined();
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

  it('reports a failed clear honestly, with the inherited-env refusal distinguished (rc-9)', () => {
    expect(settingsSource).toContain('if (!result.cleared)');
    expect(settingsSource).toContain('result.reason === "inherited_env_token"');
    expect(settingsSource).toContain('tokenInheritedEnv');
    expect(settingsSource).toContain('tokenClearFailed');
  });

  it('attached-console clear shows the clear-specific outcome, not "token saved"', () => {
    expect(settingsSource).toContain('tokenClearedExternalAttached');
    // The clear handler must not reuse the save-path "token saved" message.
    const clearHandler = settingsSource.slice(
      settingsSource.indexOf('handleClearToken'),
      settingsSource.indexOf('handleClearToken') + 1600,
    );
    expect(clearHandler).not.toContain('tokenExternalAttached');
  });
});
