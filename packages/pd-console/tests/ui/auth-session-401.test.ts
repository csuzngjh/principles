/**
 * Auth session-expiry handling tests — PRI-643.
 *
 * Covers the three residual gaps from PRI-643:
 * 1. api.ts: any 401 clears the token and routes to login (no `hadToken`
 *    gate — a page loaded before the server switched to token mode must
 *    also land on the login route).
 * 2. App.tsx: verifyAuth is re-run when the tab becomes visible / the
 *    window regains focus (server auth-mode switches while the page is
 *    open no longer strand the page).
 * 3. FailedTasksPage.tsx: goes through the shared request() so its 401s
 *    get the same global handling (no raw fetch / manual token header).
 *
 * Pattern: pure-function unit test for the redirect predicate + source-code
 * contract tests for wiring (mirrors Approuting.test.ts — the repo has no
 * jsdom/browser UI test environment).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRedirectToLoginOnUnauthorized } from '../../src/ui/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..', 'src', 'ui');

const apiSource = readFileSync(join(SRC_ROOT, 'api.ts'), 'utf8');
const appSource = readFileSync(join(SRC_ROOT, 'App.tsx'), 'utf8');
const failedTasksSource = readFileSync(
  join(SRC_ROOT, 'pages', 'failed-tasks', 'FailedTasksPage.tsx'),
  'utf8',
);

describe('unauthorized redirect predicate', () => {
  it('routes to login from any non-login route', () => {
    expect(shouldRedirectToLoginOnUnauthorized('#/focus')).toBe(true);
    expect(shouldRedirectToLoginOnUnauthorized('#/failed-tasks')).toBe(true);
    expect(shouldRedirectToLoginOnUnauthorized('')).toBe(true);
  });

  it('stays on the login route to avoid redirect loops on failed logins', () => {
    expect(shouldRedirectToLoginOnUnauthorized('#/login')).toBe(false);
    expect(shouldRedirectToLoginOnUnauthorized('#/login?session_expired=true')).toBe(false);
  });

  it('redirects from hashes that merely share the login prefix (CodeRabbit P1)', () => {
    // "#/login-help" is NOT the login route — prefix matching wrongly exempted
    // it, stranding the page on an unmatched route after a 401.
    expect(shouldRedirectToLoginOnUnauthorized('#/login-help')).toBe(true);
    expect(shouldRedirectToLoginOnUnauthorized('#/loginpage')).toBe(true);
    expect(shouldRedirectToLoginOnUnauthorized('#/login/x')).toBe(true);
  });
});

describe('api.ts 401 handling contract', () => {
  it('clears the token on every 401, not only when a token was attached', () => {
    expect(apiSource).toContain('clearToken();');
    expect(apiSource).not.toContain('hadToken');
  });

  it('redirects to the login route with the session-expired marker', () => {
    expect(apiSource).toContain('shouldRedirectToLoginOnUnauthorized');
    expect(apiSource).toContain('"#/login?session_expired=true"');
  });

  it('discloses the HTTP status on failure envelopes', () => {
    expect(apiSource).toContain('status: response.status');
  });
});

describe('App.tsx re-verification contract', () => {
  it('re-runs verifyAuth on window focus and visibilitychange', () => {
    expect(appSource).toContain('window.addEventListener("focus", recheck');
    expect(appSource).toContain('document.addEventListener("visibilitychange", recheck');
    expect(appSource).toMatch(/recheck[\s\S]*verifyAuth\(\)/);
  });

  it('removes the listeners on unmount', () => {
    expect(appSource).toContain('window.removeEventListener("focus", recheck');
    expect(appSource).toContain('document.removeEventListener("visibilitychange", recheck');
  });
});

describe('FailedTasksPage shared-request contract', () => {
  it('no longer reads the token or fetches manually', () => {
    expect(failedTasksSource).not.toContain('sessionStorage.getItem("pd_token")');
    expect(failedTasksSource).not.toContain('await fetch(');
  });

  it('routes through the shared request() with the page validator', () => {
    expect(failedTasksSource).toContain('request("/api/v1/failed-tasks", undefined, validateFailedTasksData)');
  });

  it('keeps the 403 flag-disabled state via the failure envelope status', () => {
    expect(failedTasksSource).toContain('result.status === 403');
  });
});
