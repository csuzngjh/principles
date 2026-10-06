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

/**
 * PRI-942: literal navigation targets found anywhere in the console UI.
 *
 * Read forms: `to="/x"`, `to={"/x"}`, `to={'/x'}`, `to={`/x`}` — the backtick
 * form is already in use (`FocusPage.tsx` `/activation`), so a guard that read
 * only double quotes would keep promising coverage it does not have. The capture
 * stops at the matching quote, so the other two quote characters are legal
 * inside a target.
 *
 * An interpolated target is read down to its STATIC PREFIX: `to={`/x/${id}`}`
 * still says "this link lives under /x", and /x is precisely the part a typo can
 * corrupt. Exempting such a link wholesale is how `to={`/failed-taskz?taskId=${x}`}`
 * would read as "dynamic, nothing to check".
 *
 * NOT read: a `to=` whose value is an expression that merely CONTAINS a literal —
 * the ternary in `OwnerDecisionCard.tsx:377-381` (`to={cond ? `/x` : "/principles"}`)
 * is skipped along with its literal arm, because separating arms from a JSX
 * expression is parsing, not scanning. Every link the console writes today other
 * than that one puts its path directly after `to=`, which is what this guard sees.
 */
const LINK_TARGET_REGEX = /\bto=\s*\{?\s*(["'`])(.*?)\1/g;

function collectLiteralLinkTargets(dir: string): { file: string; to: string; dynamic: boolean }[] {
  const found: { file: string; to: string; dynamic: boolean }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectLiteralLinkTargets(full));
      continue;
    }
    if (!/\.(tsx|ts)$/.test(entry.name)) continue;
    const src = fs.readFileSync(full, 'utf-8');
    let m;
    while ((m = LINK_TARGET_REGEX.exec(src)) !== null) {
      const dollar = m[2].indexOf('${');
      const dynamic = dollar !== -1;
      const staticPart = dynamic ? m[2].slice(0, dollar) : m[2];
      // strip query string / hash fragment: they never participate in routing
      const target = staticPart.split(/[?#]/)[0];
      // in-app route only — a protocol-relative `//host` is not one
      if (target.startsWith('/') && !target.startsWith('//')) {
        found.push({ file: path.relative(UI_SRC, full).replace(/\\/g, '/'), to: target, dynamic });
      }
    }
  }
  return found;
}

/**
 * Route-table matching.
 *
 * Static target: must line up with a registered route one segment at a time,
 * where a `:param` accepts any single non-empty segment.
 *
 * Interpolated prefix (`dynamic`): only the part before the first `${` is known,
 * so it is matched as a PREFIX — the link is dead only when NO registered route
 * could ever begin with it. A prefix ending in `/` contributes no segment of its
 * own (the interpolation supplies it), which is why `/principles/` has to line up
 * with `/principles/:id` and must not be failed for lack of a bare `/principles/`.
 */
function isRegisteredRoute(target: string, routes: Map<string, string>, dynamic: boolean): boolean {
  const parts = target.split('/').filter(Boolean);
  for (const pattern of routes.keys()) {
    const patternParts = pattern.split('/').filter(Boolean);
    if (patternParts.length < parts.length || (!dynamic && patternParts.length !== parts.length)) continue;
    if (patternParts.slice(0, parts.length).every((seg, i) => seg.startsWith(':') || seg === parts[i])) return true;
  }
  return false;
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

  describe('Literal link targets (PRI-942)', () => {
    let routes: Map<string, string>;
    let targets: { file: string; to: string; dynamic: boolean }[];

    beforeAll(() => {
      routes = extractAppRoutes(readFile(APP_PATH));
      targets = collectLiteralLinkTargets(UI_SRC);
    });

    it('the scanner sees the in-product links, not an empty set', () => {
      const unique = new Set(targets.map((t) => `${t.file} -> ${t.to}`));
      expect(unique.has('pages/focus/FocusPage.tsx -> /pain')).toBe(true);
      expect(
        unique.has('pages/principles/PrincipleDetailPage.tsx -> /pain'),
      ).toBe(true);
      expect(targets.length).toBeGreaterThanOrEqual(10);
    });

    it('covers the backtick form, not just double quotes (negative control: fails against a double-quote-only scanner)', () => {
      // FocusPage.tsx writes this one in `to={`/activation`}`, so a scanner that
      // read only to="…" would silently exempt half the codebase's idiom.
      expect(
        new Set(targets.map((t) => `${t.file} -> ${t.to}`)).has(
          'pages/focus/FocusPage.tsx -> /activation',
        ),
      ).toBe(true);
    });

    it('covers the static prefix of an interpolated link (negative control: fails when such a link is skipped as dynamic)', () => {
      // OwnerDecisionCard.tsx:236 writes this one as
      // `to={`/failed-tasks?taskId=${…}`}`. A scanner that exempted anything with
      // `${` would never look at that path, so a typo in it — /failed-taskz —
      // would stay invisible to the guard below.
      expect(
        new Set(targets.map((t) => `${t.file} -> ${t.to}`)).has(
          'pages/focus/OwnerDecisionCard.tsx -> /failed-tasks',
        ),
      ).toBe(true);
    });

    it('every literal link target resolves to a registered route (negative control: /evidence fails here)', () => {
      const dead = targets.filter((t) => !isRegisteredRoute(t.to, routes, t.dynamic));
      expect(
        dead.map((d) => `${d.file}: to="${d.to}"`),
        'unregistered literal navigation target',
      ).toEqual([]);
    });

    it('the prefix rule rejects an unknown static prefix instead of waving it through', () => {
      // The two halves of the rule above, pinned with synthetic paths so the
      // repo-wide assertion cannot be satisfied by "dynamic ⇒ skip": an
      // interpolated link whose prefix matches nothing must still be dead, and a
      // trailing `/` before the interpolation must not be read as a segment.
      expect(isRegisteredRoute('/failed-taskz/', routes, true)).toBe(false);
      expect(isRegisteredRoute('/principles/', routes, true)).toBe(true);
    });

    it('the guard is not carried by the outer /* fallback route', () => {
      // App.tsx wraps the console in <Route path="/*"> whose element is a
      // conditional, so extractAppRoutes never records it; the inner <Routes> has
      // no wildcard of its own, which is why an unmatched path renders chrome with
      // an empty <main>. If a wildcard that carries an element ever entered the
      // table, this guard would pass every dead link — so its absence is asserted.
      expect(routes.has('/*')).toBe(false);
      expect(routes.has('*')).toBe(false);
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
