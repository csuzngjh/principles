import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseThinkingOsMd } from '../../src/core/thinking-os-parser.js';
import type { ThinkingOsDirective } from '../../src/core/thinking-os-parser.js';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  getFoundationalPrinciples,
  getOperatingPrinciples,
  isCorePrincipleId,
} from '@principles/core/runtime-v2';
import type { CorePrinciple } from '@principles/core/runtime-v2';

/**
 * Core Principle Registry drift test (PRI-606/PRI-607).
 *
 * The shipped THINKING_OS.md templates (zh + en + workspace distribution +
 * repo dogfood copy) must stay aligned with the Core Principle Registry in
 * @principles/core: same exact id set (T-01..T-10), names, layers, and — the
 * PRI-607 hardening — every <must> must contain the registry's canonical
 * statement verbatim. Id-set or name-only equality let semantics drift (a
 * correct id + correct name + wrong statement passed the old guard); the
 * statement anchor closes that.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..', 'templates', 'langs');

/** Canonical statement anchor for a language: 'en' anchors statement, 'zh' anchors statementZh. */
function anchorFor(p: CorePrinciple, lang: 'en' | 'zh'): string {
  return lang === 'en' ? p.statement : p.statementZh;
}

describe('Core Principle Registry drift test', () => {
  describe('registry two-layer model invariants', () => {
    it('registry is exactly 10 principles: 6 foundational + 4 operating', () => {
      expect(CORE_PRINCIPLES).toHaveLength(10);
      expect(CORE_PRINCIPLE_IDS).toHaveLength(10);
      expect(getFoundationalPrinciples()).toHaveLength(6);
      expect(getOperatingPrinciples()).toHaveLength(4);
    });

    it('ids are exactly T-01..T-10 and no other id resolves', () => {
      expect(CORE_PRINCIPLE_IDS).toEqual(
        ['T-01','T-02','T-03','T-04','T-05','T-06','T-07','T-08','T-09','T-10']
      );
      expect(isCorePrincipleId('T-07')).toBe(true);
      expect(isCorePrincipleId('T-11')).toBe(false);
    });
  });

  /**
   * Full registry↔template alignment check. Throws (vitest expect) on any
   * drift: id set, name, layer, non-empty guidance, statement anchor.
   * Reused by the negative-control test below.
   */
  function expectTemplateMatchesRegistry(
    directives: ThinkingOsDirective[],
    lang: 'en' | 'zh',
    label: string,
  ): void {
    expect(directives.map(d => d.id).sort(), `${label}: directive ids must equal the registry id set exactly`).toEqual([...CORE_PRINCIPLE_IDS].sort());

    for (const d of directives) {
      const p = CORE_PRINCIPLES.find(x => x.id === d.id);
      expect(p, `${label} ${d.id}: directive id must resolve to a registry principle`).toBeDefined();
      if (!p) continue;

      expect(d.name, `${label} ${d.id}: name drift`).toBe(p.name);
      expect(d.layer, `${label} ${d.id}: layer drift`).toBe(p.layer);
      expect(d.trigger.length, `${label} ${d.id} trigger`).toBeGreaterThan(0);
      expect(d.must.length, `${label} ${d.id} must`).toBeGreaterThan(0);
      expect(d.forbidden.length, `${label} ${d.id} forbidden`).toBeGreaterThan(0);

      // PRI-607 hardening: the canonical statement must survive verbatim
      // inside <must> — a template whose must quietly restates a different
      // principle (right id + right name, wrong semantics) must fail here.
      expect(d.must, `${label} ${d.id}: <must> must anchor the canonical ${lang} statement verbatim`).toContain(anchorFor(p, lang));
    }
  }

  function loadTemplateDirectives(lang: 'zh' | 'en'): ThinkingOsDirective[] {
    const templatePath = path.join(TEMPLATE_ROOT, lang, 'principles', 'THINKING_OS.md');
    return parseThinkingOsMd(fs.readFileSync(templatePath, 'utf-8'));
  }

  for (const lang of ['zh', 'en'] as const) {
    describe(`THINKING_OS.md template (${lang})`, () => {
      it('matches the registry: ids, names, layers, and canonical statement anchors', () => {
        expectTemplateMatchesRegistry(loadTemplateDirectives(lang), lang, `${lang} template`);
      });
    });
  }

  // The workspace distribution template ships to fresh installs; it was once
  // frozen at a legacy version invisible to the langs guard. Keep guarded.
  describe('workspace distribution template', () => {
    const WORKSPACE_TEMPLATE = path.resolve(
      __dirname, '..', '..', 'templates', 'workspace', '.principles', 'THINKING_OS.md',
    );

    it('matches the registry: ids, names, layers, and canonical zh statement anchors', () => {
      const directives = parseThinkingOsMd(fs.readFileSync(WORKSPACE_TEMPLATE, 'utf-8'));
      expectTemplateMatchesRegistry(directives, 'zh', 'workspace template');
    });
  });

  // The repo-root dogfood copy is what this repository's own agent sees; it is
  // not shipped in the npm tarball, so the guard is existence-conditional.
  describe('repo dogfood THINKING_OS template', () => {
    const DOGFOOD_TEMPLATE = path.resolve(__dirname, '..', '..', '..', '..', '.principles', 'THINKING_OS.md');

    it('matches the registry when present (ids, names, layers, zh statement anchors)', () => {
      if (!fs.existsSync(DOGFOOD_TEMPLATE)) return;
      const directives = parseThinkingOsMd(fs.readFileSync(DOGFOOD_TEMPLATE, 'utf-8'));
      expectTemplateMatchesRegistry(directives, 'zh', 'dogfood template');
    });
  });

  // EP-09 / ERR-037: a regression guard must prove it can fail. The old guard
  // passed templates whose <must> restated a different principle under the
  // right id + name — this negative control pins that the anchor check bites.
  describe('negative control (statement anchor)', () => {
    it('a directive with correct id + name but mutated must FAILS the anchor check', () => {
      const mutated: ThinkingOsDirective[] = CORE_PRINCIPLES.map((p, index) => ({
        id: p.id,
        name: p.name,
        layer: p.layer,
        trigger: 'trigger',
        // Correct id, correct name — but the THIRD principle's must quietly
        // restates a different (fabricated) semantic.
        must: index === 2
          ? 'Always trust your first assumption and avoid reading logs or code before concluding.'
          : `${anchorFor(p, 'en')} Operational expansion follows.`,
        forbidden: 'forbidden',
      }));
      expect(() => expectTemplateMatchesRegistry(mutated, 'en', 'negative control')).toThrow();
    });

    it('the unmutated synthetic baseline passes the same check (guard is not vacuous)', () => {
      const baseline: ThinkingOsDirective[] = CORE_PRINCIPLES.map(p => ({
        id: p.id,
        name: p.name,
        layer: p.layer,
        trigger: 'trigger',
        must: `${anchorFor(p, 'en')} Operational expansion follows.`,
        forbidden: 'forbidden',
      }));
      expect(() => expectTemplateMatchesRegistry(baseline, 'en', 'baseline control')).not.toThrow();
    });
  });
});
