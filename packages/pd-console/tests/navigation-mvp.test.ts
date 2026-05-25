import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PKG_ROOT = path.resolve(__dirname, '..');
const UI_SRC = path.join(PKG_ROOT, 'src', 'ui');

const SIDEBAR_PATH = path.join(UI_SRC, 'components', 'app-sidebar.tsx');
const APP_PATH = path.join(UI_SRC, 'App.tsx');

function readFile(relPath: string): string {
  return fs.readFileSync(relPath, 'utf-8');
}

describe('MVP Three-Page Navigation — PRI-245', () => {
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

    it('diagnostics section includes Event Log and Data Flow', () => {
      const diagSection = sidebarSrc.match(/diagnosticNavItems\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
      expect(diagSection).toContain('event-log');
      expect(diagSection).toContain('data-flow');
    });

    it('settings remains accessible', () => {
      expect(sidebarSrc).toContain('/settings');
    });
  });

  describe('App routing', () => {
    let appSrc: string;

    beforeAll(() => {
      appSrc = readFile(APP_PATH);
    });

    it('default route / renders PainPage', () => {
      expect(appSrc).toMatch(/path="\/"\s+element=\{<PainPage/);
    });

    it('/pain route renders PainPage', () => {
      expect(appSrc).toMatch(/path="\/pain"\s+element=\{<PainPage/);
    });

    it('/approvals route renders ApprovalsPage', () => {
      expect(appSrc).toMatch(/path="\/approvals"\s+element=\{<ApprovalsPage/);
    });

    it('/principles route still exists', () => {
      expect(appSrc).toContain('path="/principles"');
    });

    it('overview route is accessible at /overview (not /)', () => {
      expect(appSrc).toMatch(/path="\/overview"\s+element=\{<OverviewPage/);
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
