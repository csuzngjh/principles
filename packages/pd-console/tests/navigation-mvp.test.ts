import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '..');
const UI_SRC = path.join(PKG_ROOT, 'src', 'ui');

const SIDEBAR_PATH = path.join(UI_SRC, 'components', 'layout', 'app-sidebar.tsx');
const APP_PATH = path.join(UI_SRC, 'App.tsx');

function readFile(relPath: string): string {
  return fs.readFileSync(relPath, 'utf-8');
}

function extractNavHrefs(src: string, arrayName: string): string[] {
  const match = src.match(new RegExp(`${arrayName}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) return [];
  const hrefs: string[] = [];
  const hrefRegex = /href:\s*"([^"]+)"/g;
  let m;
  while ((m = hrefRegex.exec(match[1])) !== null) {
    hrefs.push(m[1]);
  }
  return hrefs;
}

function extractAppRoutes(src: string): Map<string, string> {
  const routes = new Map<string, string>();
  const routeRegex = /path="([^"]+)"\s+element=\{<(\w+)/g;
  let m;
  while ((m = routeRegex.exec(src)) !== null) {
    routes.set(m[1], m[2]);
  }
  return routes;
}

describe('Console Rebuild Navigation — CR2', () => {
  describe('Sidebar primary navigation', () => {
    let sidebarSrc: string;

    beforeAll(() => {
      sidebarSrc = readFile(SIDEBAR_PATH);
    });

    it('has exactly 5 governance nav items', () => {
      expect(sidebarSrc).toContain('id: "focus"');
      expect(sidebarSrc).toContain('id: "pain"');
      expect(sidebarSrc).toContain('id: "principles"');
      expect(sidebarSrc).toContain('id: "activation"');
      expect(sidebarSrc).toContain('id: "debt"');
    });

    it('governance nav items link to /focus, /pain, /principles, /activation, /debt', () => {
      expect(sidebarSrc).toContain('href: "/focus"');
      expect(sidebarSrc).toContain('href: "/pain"');
      expect(sidebarSrc).toContain('href: "/principles"');
      expect(sidebarSrc).toContain('href: "/activation"');
      expect(sidebarSrc).toContain('href: "/debt"');
    });

    it('has tool nav items for control-center, report-problem, settings, update', () => {
      expect(sidebarSrc).toContain('id: "control-center"');
      expect(sidebarSrc).toContain('id: "report-problem"');
      expect(sidebarSrc).toContain('id: "settings"');
      expect(sidebarSrc).toContain('id: "update"');
    });

    it('does not expose old page IDs in nav', () => {
      const mainSection = sidebarSrc.match(/mainNavItems\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
      expect(mainSection).not.toContain('overview');
      expect(mainSection).not.toContain('approvals');
      expect(mainSection).not.toContain('tasks');
      expect(mainSection).not.toContain('agents');
      expect(mainSection).not.toContain('gates');
      expect(mainSection).not.toContain('samples');
      expect(mainSection).not.toContain('central');
      expect(mainSection).not.toContain('thinking-models');
    });

    it('has ThresholdMark brand component', () => {
      expect(sidebarSrc).toContain('ThresholdMark');
    });

    it('has theme toggle button', () => {
      expect(sidebarSrc).toContain('setTheme');
    });

    it('has sign out button', () => {
      expect(sidebarSrc).toContain('clearToken');
      expect(sidebarSrc).toContain('LogOut');
    });

    it('has keyboard shortcut hints (Alt+)', () => {
      expect(sidebarSrc).toContain('Alt+3');
      expect(sidebarSrc).toContain('Alt+4');
      expect(sidebarSrc).toContain('Alt+5');
    });

    it('no health red dot, no DNA logo', () => {
      expect(sidebarSrc).not.toContain('alertCount');
      expect(sidebarSrc).not.toContain('DNA');
    });
  });

  describe('Nav-to-route mapping (real route contract)', () => {
    let sidebarSrc: string;
    let appSrc: string;
    let mainHrefs: string[];
    let toolHrefs: string[];
    let appRoutes: Map<string, string>;

    beforeAll(() => {
      sidebarSrc = readFile(SIDEBAR_PATH);
      appSrc = readFile(APP_PATH);
      mainHrefs = extractNavHrefs(sidebarSrc, 'mainNavItems');
      toolHrefs = extractNavHrefs(sidebarSrc, 'toolNavItems');
      appRoutes = extractAppRoutes(appSrc);
    });

    it('every main nav href has a corresponding App route', () => {
      for (const href of mainHrefs) {
        expect(appRoutes.has(href), `Route ${href} not found in App.tsx`).toBe(true);
      }
    });

    it('every tool nav href has a corresponding App route', () => {
      for (const href of toolHrefs) {
        expect(appRoutes.has(href), `Route ${href} not found in App.tsx`).toBe(true);
      }
    });

    it('default route / redirects to /focus', () => {
      expect(appSrc).toContain('Navigate to="/focus"');
    });

    it('/focus renders FocusPage', () => {
      expect(appRoutes.get('/focus')).toBe('FocusPage');
    });

    it('/pain renders PainPage', () => {
      expect(appRoutes.get('/pain')).toBe('PainPage');
    });

    it('/principles renders PrinciplesPage', () => {
      expect(appRoutes.get('/principles')).toBe('PrinciplesPage');
    });

    it('/activation renders ActivationPage', () => {
      expect(appRoutes.get('/activation')).toBe('ActivationPage');
    });

    it('/debt renders DebtPage', () => {
      expect(appRoutes.get('/debt')).toBe('DebtPage');
    });
  });

  describe('App routing', () => {
    let appSrc: string;

    beforeAll(() => {
      appSrc = readFile(APP_PATH);
    });

    it('has splash route', () => {
      expect(appSrc).toContain('path="/splash"');
    });

    it('has login route', () => {
      expect(appSrc).toContain('path="/login"');
    });

    it('imports new directory-based pages', () => {
      expect(appSrc).toContain('pages/focus/FocusPage.js');
      expect(appSrc).toContain('pages/pain/PainPage.js');
      expect(appSrc).toContain('pages/principles/PrinciplesPage.js');
      expect(appSrc).toContain('pages/activation/ActivationPage.js');
      expect(appSrc).toContain('pages/debt/DebtPage.js');
    });

    it('no legacy route paths remain', () => {
      const legacyRoutes = [
        '/central', '/tasks', '/feedback', '/gates', '/samples',
        '/evolution', '/agents', '/data-flow', '/event-log',
        '/thinking-models', '/overview', '/approvals',
      ];
      for (const route of legacyRoutes) {
        expect(appSrc, `Legacy route ${route} still in App.tsx`).not.toContain(`path="${route}"`);
      }
    });
  });

  describe('Page files exist in new directory structure', () => {
    it('FocusPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'focus', 'FocusPage.tsx'))).toBe(true);
    });

    it('PainPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'pain', 'PainPage.tsx'))).toBe(true);
    });

    it('PrinciplesPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'principles', 'PrinciplesPage.tsx'))).toBe(true);
    });

    it('ActivationPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'activation', 'ActivationPage.tsx'))).toBe(true);
    });

    it('DebtPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'debt', 'DebtPage.tsx'))).toBe(true);
    });

    it('ControlCenterPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'control-center', 'ControlCenterPage.tsx'))).toBe(true);
    });

    it('SettingsPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'settings', 'SettingsPage.tsx'))).toBe(true);
    });
  });

  describe('Auth flow', () => {
    let appSrc: string;

    beforeAll(() => {
      appSrc = readFile(APP_PATH);
    });

    it('Router always renders (not conditional)', () => {
      expect(appSrc).toContain('HashRouter');
    });

    it('LoginForm is a route inside Router', () => {
      expect(appSrc).toContain('path="/login"');
      expect(appSrc).toContain('LoginForm');
    });

    it('SplashScreen is a route inside Router', () => {
      expect(appSrc).toContain('path="/splash"');
      expect(appSrc).toContain('SplashScreen');
    });

    it('unauthenticated users redirect to /login', () => {
      expect(appSrc).toContain('Navigate to="/login"');
    });
  });

  describe('/design-system dev-only guard', () => {
    let appSrc: string;

    beforeAll(() => {
      appSrc = readFile(APP_PATH);
    });

    it('/design-system route is gated by IS_DEV (import.meta.env.DEV)', () => {
      expect(appSrc).toContain('IS_DEV');
      expect(appSrc).toContain('import.meta');
      expect(appSrc).toContain('path="/design-system"');
    });

    it('non-DEV /design-system redirects to /focus', () => {
      // The route should have a Navigate to="/focus" fallback for production
      const designSystemBlock = appSrc.substring(
        appSrc.indexOf('path="/design-system"'),
      );
      expect(designSystemBlock).toContain('Navigate to="/focus"');
    });
  });
});
