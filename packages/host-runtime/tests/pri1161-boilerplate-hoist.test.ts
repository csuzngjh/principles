import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as yaml from 'js-yaml';
import {
  SqliteActivationStateStore,
  SqliteConnection,
  getDefaultPdConfig,
  measureSharedDirectiveBlockChars,
  renderPrinciplesToDirectives,
  sharedDirectiveBaseChars,
  type ActivatedPrinciple,
} from '@principles/core/runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { buildActivePrinciplePromptContext, packSharedDirectives } from '../src/index.js';

/**
 * PRI-1161 (Owner-approved card v0.1): the per-block boilerplate line
 * "Apply this as an active behavior constraint..." was hoisted to the shared
 * header, stated ONCE. These tests lock the Owner conditions:
 * - the constraint is stated exactly once per render (empty/single/multi);
 * - per-principle body, id, authority attribute and escaping are untouched;
 * - the render/base additive identity holds with and without self-report;
 * - exact budget boundary behavior is unchanged;
 * - per-principle presence-forensics slices stay complete (bodyComplete).
 */

const APPLY_LINE = 'Apply this as an active behavior constraint. Do not treat this as background context.';
const CONSTRAINT_PHRASE = 'mandatory active behavior constraints for this session, not background context';

const mk = (principleId: string, text: string, authority?: 'owner' | 'system_policy'): ActivatedPrinciple => ({
  principleId, text, artifactId: `art-${principleId}`, activationId: `act-${principleId}`, ...(authority ? { authority } : {}),
});

function render(principles: ActivatedPrinciple[], selfReport = false): string {
  return renderPrinciplesToDirectives(principles, new Set(principles.map((p) => p.principleId)), { escapeFn: escapeXml, selfReportInstruction: selfReport });
}

describe('PRI-1161 hoisted boilerplate — Owner conditions', () => {
  it('empty selection renders the empty string (unchanged contract)', () => {
    expect(renderPrinciplesToDirectives([], new Set(), { escapeFn: escapeXml })).toBe('');
  });

  it('single principle: constraint stated exactly once in the header, zero per-block copies', () => {
    const text = render([mk('ONE', '只做相关改动。', 'owner')]);
    expect(text.split(CONSTRAINT_PHRASE).length - 1).toBe(1);
    expect(text.split(APPLY_LINE).length - 1).toBe(0);
    expect(text).toContain('<directive id="ONE" source="runtime_v2_activation" authority="owner">');
    expect(text).toContain('MANDATORY: 只做相关改动。');
    expect(text).toContain('</directive>');
  });

  it('multiple principles: one block each, constraint still exactly once, order preserved', () => {
    const principles = [mk('M-1', '第一条。', 'owner'), mk('M-2', '第二条。', 'system_policy'), mk('M-3', '第三条。')];
    const text = render(principles);
    expect(text.split(CONSTRAINT_PHRASE).length - 1).toBe(1);
    expect((text.match(/<directive /g) ?? []).length).toBe(3);
    const positions = ['M-1', 'M-2', 'M-3'].map((id) => text.indexOf(`id="${id}"`));
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(text).toContain('authority="owner"');
    expect(text).toContain('authority="system_policy"');
    // Unknown authority stays unannotated (INV-05: 宁缺毋假).
    expect(text.split('id="M-3"')[1].split('</directive>')[0]).not.toContain('authority=');
  });

  it('XML-special characters escape exactly once and the additive identity holds (self-report on and off)', () => {
    const principles = [
      mk('ESC&<1>', '含 <tag> 与 & "quotes" 和 \'single\' 以及 &amp; 实体。', 'owner'),
      mk('ESC-2', '第二条 & 更长一些的正文。', 'system_policy'),
    ];
    for (const selfReport of [false, true]) {
      const text = render(principles, selfReport);
      expect(text.split('&lt;tag&gt;').length - 1).toBe(1);
      expect(text.split('&amp; &quot;quotes&quot;').length - 1).toBe(1);
      expect(text).toContain('<directive id="ESC&amp;&lt;1&gt;"');
      expect(text.split(APPLY_LINE).length - 1).toBe(0);
      const identity = text.length === sharedDirectiveBaseChars({ escapeFn: escapeXml, selfReportInstruction: selfReport })
        + principles.reduce((sum, p) => sum + measureSharedDirectiveBlockChars(p, { escapeFn: escapeXml, selfReportInstruction: selfReport }), 0);
      expect(identity).toBe(true);
    }
  });

  it('exact budget boundary: a block exactly filling the remaining budget is included; one char more is dropped (arithmetic unchanged)', () => {
    const filler = mk('FILLER', 'x'.repeat(50), 'owner');
    const opts = { escapeFn: escapeXml, selfReportInstruction: false };
    const base = sharedDirectiveBaseChars(opts);
    const fillerCost = measureSharedDirectiveBlockChars(filler, opts);
    const probeLen = (len: number) => measureSharedDirectiveBlockChars(mk('PROBE', 'y'.repeat(len), 'owner'), opts);
    // Binary-search the text length where PROBE exactly fills the rest of the budget.
    let exactLen = 1;
    while (base + fillerCost + probeLen(exactLen) <= 2000) exactLen += 1;
    // exactLen now OVERFLOWS by one char of rendered cost; use exactLen - 1.
    const fits = packSharedDirectives({ scanOrder: [filler, mk('PROBE', 'y'.repeat(exactLen - 1), 'owner')], budgetChars: 2000, selfReportEnabled: false, continueOnNonFit: true });
    expect(fits.included.map((p) => p.principleId)).toEqual(['FILLER', 'PROBE']);
    expect(fits.truncated).toBe(false);
    const overflows = packSharedDirectives({ scanOrder: [filler, mk('PROBE', 'y'.repeat(exactLen), 'owner')], budgetChars: 2000, selfReportEnabled: false, continueOnNonFit: true });
    expect(overflows.included.map((p) => p.principleId)).toEqual(['FILLER']);
    expect(overflows.truncated).toBe(true);
    expect(overflows.dropped).toEqual(['act-PROBE']);
  });

  it('presence forensics: per-principle slices stay complete in the final assembly (bodyComplete true, no boilerplate inside)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri1161-'));
    try {
      fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
      const config = getDefaultPdConfig();
      fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml.dump(config), 'utf8');
      const connection = new SqliteConnection({ workspaceDir });
      const base = Date.UTC(2026, 10, 10, 8, 0, 0);
      try {
        const insertArtifact = connection.getDb().prepare(`
          INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
          VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
        `);
        const store = new SqliteActivationStateStore(connection);
        const entries: ActivatedPrinciple[] = [
          mk('P-1', '第一条可观察验证。', 'owner'),
          mk('P-2', '第二条可观察验证。', 'system_policy'),
        ];
        for (const [i, p] of entries.entries()) {
          const at = new Date(base + i * 60_000).toISOString();
          insertArtifact.run(p.artifactId, `task-${p.artifactId}`, p.principleId, JSON.stringify({ principleId: p.principleId, text: p.text }), at, at);
          await store.recordActivation({
            activationId: p.activationId, idempotencyKey: `${p.artifactId}::prompt`, artifactId: p.artifactId,
            channel: 'prompt', action: 'prompt_activate', targetRef: `ledger://${p.principleId}`,
            activatedAt: at, deactivatedAt: null,
          });
        }
      } finally {
        connection.close();
      }
      const context = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: 0 });
      expect(context.principleIds).toEqual(['P-1', 'P-2']);
      expect(context.injectedExpectations ?? []).toHaveLength(2);
      for (const expectation of context.injectedExpectations ?? []) {
        expect(expectation.bodyComplete).toBe(true);
        expect(expectation.bodyText.startsWith('<directive ')).toBe(true);
        expect(expectation.bodyText.endsWith('</directive>')).toBe(true);
        expect(expectation.bodyText.includes('MANDATORY: ')).toBe(true);
        expect(expectation.bodyText.includes(APPLY_LINE)).toBe(false);
        expect(context.additionalContext.includes(expectation.bodyText)).toBe(true);
      }
      expect(context.additionalContext.split(CONSTRAINT_PHRASE).length - 1).toBe(1);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
