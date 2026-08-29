import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const page = fs.readFileSync(path.resolve('src/ui/pages/principles/PrincipleDetailPage.tsx'), 'utf8');
const playwrightConfig = fs.readFileSync(path.resolve('playwright.config.ts'), 'utf8');
const e2eStart = fs.readFileSync(path.resolve('scripts/e2e-start.mjs'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve('src/ui/i18n/en.json'), 'utf8')) as unknown;
const zh = JSON.parse(fs.readFileSync(path.resolve('src/ui/i18n/zh-CN.json'), 'utf8')) as unknown;

function governanceKeys(locale: unknown): unknown {
  if (typeof locale !== 'object' || locale === null || !Object.hasOwn(locale, 'pages')) return undefined;
  const pages = Object.getOwnPropertyDescriptor(locale, 'pages')?.value;
  if (typeof pages !== 'object' || pages === null || !Object.hasOwn(pages, 'principles')) return undefined;
  const principles = Object.getOwnPropertyDescriptor(pages, 'principles')?.value;
  if (typeof principles !== 'object' || principles === null || !Object.hasOwn(principles, 'detail')) return undefined;
  const detail = Object.getOwnPropertyDescriptor(principles, 'detail')?.value;
  return typeof detail === 'object' && detail !== null ? Object.getOwnPropertyDescriptor(detail, 'governance')?.value : undefined;
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
}

describe('PRI-553 Principle Detail governance projection wiring', () => {
  it('loads the flagged governance endpoint without replacing the four existing sources', () => {
    expect(page).toContain('fetchPrincipleGovernance');
    expect(page).toContain('fetchPrincipleDetail');
    expect(page).toContain('fetchApprovalsGrouped');
    expect(page).toContain('fetchLifecycleMetrics');
    expect(page).toContain('fetchPrincipleTrajectory');
  });

  it('renders the five-second Owner hierarchy without exposing technical source identifiers', () => {
    expect(page).toContain('data-testid="governance-summary"');
    expect(page).toContain('data-testid="governance-next-action"');
    expect(page).toContain('data-testid="governance-data-quality"');
    expect(page).toContain('data-testid="governance-timeline"');
    expect(page).not.toContain('{sourceRef.type}: {sourceRef.id}');
    expect(page).not.toContain('{event.sourceRef.type}: {event.sourceRef.id}');
  });

  it('enhances the existing trajectory instead of adding or replacing its durable history', () => {
    expect(page.indexOf('<details className="mb-8 border border-line')).toBeLessThan(page.indexOf('data-testid="governance-timeline"'));
    expect(page).not.toContain('governance === null && (\n        <details');
  });

  it('fails closed and hides decision controls when projection authority is unavailable', () => {
    // PRI-582: the gating expression moved into the exported pure derivation
    // (deriveGovernanceControlBlock) so the blocked-reason truth table is
    // testable in node-env. The wiring contract is unchanged: controls render
    // only when the projection authorizes them.
    expect(page).toContain('const showDecisionControls = governanceBlock === null');
    expect(page).toContain('deriveGovernanceControlBlock({ governance, governanceUnavailable })');
    expect(page).toContain('{showDecisionControls && (');
  });

  it('gates existing approval actions on projection Owner authority when projection is present', () => {
    expect(page).toContain("governance.attention.primary === 'owner_required'");
  });

  it('ships matching governance keys in both locales', () => {
    expect(governanceKeys(en)).toBeTruthy();
    expect(governanceKeys(zh)).toBeTruthy();
    expect(Object.keys(governanceKeys(en) as object).sort()).toEqual(Object.keys(governanceKeys(zh) as object).sort());
    for (const locale of [en, zh]) {
      const governance = governanceKeys(locale);
      expectRecord(governance);
      expectRecord(governance.state);
      expectRecord(governance.stage);
      expectRecord(governance.automationState);
      expectRecord(governance.attention);
      expect(Object.keys(governance.state).sort()).toEqual(['active', 'archived', 'candidate', 'deprecated', 'probation']);
      expect(Object.keys(governance.stage).sort()).toEqual(['activation', 'approval', 'generating', 'reviewing', 'revising']);
      expect(Object.keys(governance.automationState).sort()).toEqual(['idle', 'queued', 'retry_scheduled', 'running', 'stalled']);
      expect(governance.attention.verdict_missing).toEqual(expect.any(String));
      expect(governance.unavailableReason).toEqual(expect.any(String));
      expect(governance.unavailableNextAction).toEqual(expect.any(String));
      expectRecord(governance.issue);
      for (const code of ['metadata_malformed', 'timestamp_invalid', 'source_unavailable']) {
        expect(governance.issue[code]).toEqual(expect.any(String));
      }
    }
  });

  it('starts an isolated current-worktree server instead of reusing an unrelated local console', () => {
    expect(playwrightConfig).toContain('reuseExistingServer: false');
    expect(playwrightConfig).toContain("process.env.PD_CONSOLE_E2E_PORT ?? '3101'");
    expect(e2eStart).toContain("process.env.PD_CONSOLE_E2E_PORT ?? '3101'");
  });
});
