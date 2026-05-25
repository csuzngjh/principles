import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isNavActive } from '../src/ui/utils/navigation.js';

const PKG_ROOT = path.resolve(__dirname, '..');
const UI_SRC = path.join(PKG_ROOT, 'src', 'ui');

const SIDEBAR_PATH = path.join(UI_SRC, 'components', 'app-sidebar.tsx');
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

describe('MVP Three-Page Navigation — PRI-245', () => {
  describe('isNavActive (extracted unit)', () => {
    it('exact match on "/" only when pathname is "/"', () => {
      expect(isNavActive('/', '/')).toBe(true);
      expect(isNavActive('/', '/pain')).toBe(false);
      expect(isNavActive('/', '/principles')).toBe(false);
      expect(isNavActive('/', '/overview')).toBe(false);
      expect(isNavActive('/', '/approvals')).toBe(false);
    });

    it('exact match on non-root path', () => {
      expect(isNavActive('/pain', '/pain')).toBe(true);
      expect(isNavActive('/principles', '/principles')).toBe(true);
      expect(isNavActive('/approvals', '/approvals')).toBe(true);
    });

    it('sub-path matches parent', () => {
      expect(isNavActive('/principles', '/principles/123')).toBe(true);
      expect(isNavActive('/pain', '/pain/detail')).toBe(true);
    });

    it('does not match partial prefix without slash boundary', () => {
      expect(isNavActive('/pain', '/paint')).toBe(false);
      expect(isNavActive('/data-flow', '/data-flow-chart')).toBe(false);
    });

    it('does not cross-match sibling routes', () => {
      expect(isNavActive('/pain', '/principles')).toBe(false);
      expect(isNavActive('/principles', '/pain')).toBe(false);
      expect(isNavActive('/overview', '/pain')).toBe(false);
    });
  });

  describe('Sidebar primary navigation', () => {
    let sidebarSrc: string;

    beforeAll(() => {
      sidebarSrc = readFile(SIDEBAR_PATH);
    });

    it('has exactly 3 MVP nav items: Pain, Principle, Approval', () => {
      expect(sidebarSrc).toContain('id: "pain"');
      expect(sidebarSrc).toContain('id: "principles"');
      expect(sidebarSrc).toContain('id: "approvals"');
    });

    it('MVP nav items link to /pain, /principles, /approvals', () => {
      expect(sidebarSrc).toContain('href: "/pain"');
      expect(sidebarSrc).toContain('href: "/principles"');
      expect(sidebarSrc).toContain('href: "/approvals"');
    });

    it('does not expose skill or model_training in primary nav', () => {
      const mvpSection = sidebarSrc.match(/mvpNavItems\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
      expect(mvpSection).not.toContain('skill');
      expect(mvpSection).not.toContain('model_training');
    });

    it('does not expose tasks, agents, gates, samples, central, thinking-models in primary nav', () => {
      const mvpSection = sidebarSrc.match(/mvpNavItems\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
      expect(mvpSection).not.toContain('tasks');
      expect(mvpSection).not.toContain('agents');
      expect(mvpSection).not.toContain('gates');
      expect(mvpSection).not.toContain('samples');
      expect(mvpSection).not.toContain('central');
      expect(mvpSection).not.toContain('thinking-models');
    });

    it('diagnostics section exists for advanced access', () => {
      expect(sidebarSrc).toContain('diagnosticNavItems');
      expect(sidebarSrc).toContain('Diagnostics');
    });

    it('diagnostics Overview links to /overview (not /)', () => {
      const diagHrefs = extractNavHrefs(sidebarSrc, 'diagnosticNavItems');
      const overviewEntry = diagHrefs.find(() => true);
      expect(overviewEntry).toBe('/overview');
    });

    it('diagnostics section includes Event Log, Data Flow, Evolution, Overview', () => {
      const diagSection = sidebarSrc.match(/diagnosticNavItems\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
      expect(diagSection).toContain('event-log');
      expect(diagSection).toContain('data-flow');
      expect(diagSection).toContain('evolution');
      expect(diagSection).toContain('overview');
    });

    it('settings remains accessible', () => {
      expect(sidebarSrc).toContain('/settings');
    });

    it('sidebar uses isNavActive from extracted utility', () => {
      expect(sidebarSrc).toContain('isNavActive');
      expect(sidebarSrc).toContain('from "../utils/navigation.js"');
    });
  });

  describe('Nav-to-route mapping (real route contract)', () => {
    let sidebarSrc: string;
    let appSrc: string;
    let mvpHrefs: string[];
    let diagHrefs: string[];
    let appRoutes: Map<string, string>;

    beforeAll(() => {
      sidebarSrc = readFile(SIDEBAR_PATH);
      appSrc = readFile(APP_PATH);
      mvpHrefs = extractNavHrefs(sidebarSrc, 'mvpNavItems');
      diagHrefs = extractNavHrefs(sidebarSrc, 'diagnosticNavItems');
      appRoutes = extractAppRoutes(appSrc);
    });

    it('every MVP nav href has a corresponding App route', () => {
      for (const href of mvpHrefs) {
        expect(appRoutes.has(href)).toBe(true);
      }
    });

    it('every diagnostics nav href has a corresponding App route', () => {
      for (const href of diagHrefs) {
        expect(appRoutes.has(href)).toBe(true);
      }
    });

    it('settings href has a corresponding App route', () => {
      expect(appRoutes.has('/settings')).toBe(true);
    });

    it('default route / renders PainPage', () => {
      expect(appRoutes.get('/')).toBe('PainPage');
    });

    it('/pain renders PainPage', () => {
      expect(appRoutes.get('/pain')).toBe('PainPage');
    });

    it('/approvals renders ApprovalsPage', () => {
      expect(appRoutes.get('/approvals')).toBe('ApprovalsPage');
    });

    it('/overview renders OverviewPage', () => {
      expect(appRoutes.get('/overview')).toBe('OverviewPage');
    });

    it('/principles renders PrinciplesPage', () => {
      expect(appRoutes.get('/principles')).toBe('PrinciplesPage');
    });

    it('no nav href points to a route that does not exist', () => {
      const allNavHrefs = [...mvpHrefs, ...diagHrefs, '/settings'];
      for (const href of allNavHrefs) {
        expect(appRoutes.has(href)).toBe(true);
      }
    });
  });

  describe('App routing', () => {
    let appSrc: string;

    beforeAll(() => {
      appSrc = readFile(APP_PATH);
    });

    it('all legacy routes remain accessible', () => {
      const legacyRoutes = [
        '/central', '/tasks', '/feedback', '/gates', '/samples',
        '/evolution', '/agents', '/data-flow', '/event-log',
        '/thinking-models', '/settings',
      ];
      for (const route of legacyRoutes) {
        expect(appSrc).toContain(`path="${route}"`);
      }
    });

    it('imports PainPage and ApprovalsPage', () => {
      expect(appSrc).toContain('from "./pages/PainPage.js"');
      expect(appSrc).toContain('from "./pages/ApprovalsPage.js"');
    });
  });

  describe('Page files exist', () => {
    it('PainPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'PainPage.tsx'))).toBe(true);
    });

    it('ApprovalsPage.tsx exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'ApprovalsPage.tsx'))).toBe(true);
    });

    it('FeedbackPage.tsx still exists (not deleted)', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'FeedbackPage.tsx'))).toBe(true);
    });

    it('TasksPage.tsx still exists (not deleted)', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'pages', 'TasksPage.tsx'))).toBe(true);
    });

    it('navigation.ts utility exists', () => {
      expect(fs.existsSync(path.join(UI_SRC, 'utils', 'navigation.ts'))).toBe(true);
    });
  });

  describe('PainPage content', () => {
    let painSrc: string;

    beforeAll(() => {
      painSrc = readFile(path.join(UI_SRC, 'pages', 'PainPage.tsx'));
    });

    it('uses pain i18n keys (not feedback keys)', () => {
      expect(painSrc).toContain('pages:pain.title');
      expect(painSrc).toContain('pages:pain.description');
    });

    it('has empty state hint for fresh workspace', () => {
      expect(painSrc).toContain('pages:pain.emptyHint');
    });

    it('uses existing API functions (no new storage logic)', () => {
      expect(painSrc).toContain('fetchFeedbackGfi');
      expect(painSrc).toContain('fetchEmpathyEvents');
      expect(painSrc).toContain('fetchFeedbackGateBlocks');
    });

    it('GfiGauge receives error and onRetry props', () => {
      expect(painSrc).toMatch(/gfi={gfi\.data}\s+error={gfi\.error}\s+onRetry={gfi\.refresh}/);
    });

    it('GfiGauge shows error state when error is set and gfi is null', () => {
      const gaugeMatch = painSrc.match(/function GfiGauge[\s\S]*?^}/m);
      expect(gaugeMatch).not.toBeNull();
      const gaugeSrc = gaugeMatch![0];
      expect(gaugeSrc).toMatch(/if\s*\(\s*error\s+&&\s*!gfi\s*\)/);
      expect(gaugeSrc).toContain('text-destructive');
      expect(gaugeSrc).toContain('onRetry');
    });
  });

  describe('ApprovalsPage content', () => {
    let approvalsSrc: string;

    beforeAll(() => {
      approvalsSrc = readFile(path.join(UI_SRC, 'pages', 'ApprovalsPage.tsx'));
    });

    it('uses approvals i18n keys', () => {
      expect(approvalsSrc).toContain('pages:approvals.title');
      expect(approvalsSrc).toContain('pages:approvals.description');
    });

    it('has empty state hint for fresh workspace', () => {
      expect(approvalsSrc).toContain('pages:approvals.emptyHint');
    });

    it('uses existing approval API functions (no new storage logic)', () => {
      expect(approvalsSrc).toContain('fetchApprovals');
      expect(approvalsSrc).toContain('fetchApprovalDetail');
      expect(approvalsSrc).toContain('approveApproval');
      expect(approvalsSrc).toContain('rejectApproval');
    });

    it('uses existing ApprovalCard and ApprovalDetailDialog components', () => {
      expect(approvalsSrc).toContain('ApprovalCard');
      expect(approvalsSrc).toContain('ApprovalDetailDialog');
      expect(approvalsSrc).toContain('RejectionReasonDialog');
    });

    it('does not import or reference skill/model_training channels', () => {
      expect(approvalsSrc).not.toContain('skill');
      expect(approvalsSrc).not.toContain('model_training');
    });
  });

  describe('i18n keys', () => {
    let enSrc: string;
    let zhSrc: string;

    beforeAll(() => {
      enSrc = readFile(path.join(UI_SRC, 'i18n', 'en.json'));
      zhSrc = readFile(path.join(UI_SRC, 'i18n', 'zh-CN.json'));
    });

    it('en.json has pain page keys', () => {
      const en = JSON.parse(enSrc);
      expect(en.pages.pain).toBeDefined();
      expect(en.pages.pain.title).toBe('Pain');
      expect(en.pages.pain.emptyHint).toBeDefined();
    });

    it('en.json has approvals page keys', () => {
      const en = JSON.parse(enSrc);
      expect(en.pages.approvals).toBeDefined();
      expect(en.pages.approvals.title).toBe('Approval');
      expect(en.pages.approvals.emptyHint).toBeDefined();
    });

    it('zh-CN.json has pain page keys', () => {
      const zh = JSON.parse(zhSrc);
      expect(zh.pages.pain).toBeDefined();
      expect(zh.pages.pain.title).toBeDefined();
      expect(zh.pages.pain.emptyHint).toBeDefined();
    });

    it('zh-CN.json has approvals page keys', () => {
      const zh = JSON.parse(zhSrc);
      expect(zh.pages.approvals).toBeDefined();
      expect(zh.pages.approvals.title).toBeDefined();
      expect(zh.pages.approvals.emptyHint).toBeDefined();
    });
  });
});
