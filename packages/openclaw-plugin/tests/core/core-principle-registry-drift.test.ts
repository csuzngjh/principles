import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseThinkingOsMd } from '../../src/core/thinking-os-parser.js';
import type { ThinkingOsDirective } from '../../src/core/thinking-os-parser.js';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
  getActiveCorePrinciples,
  getFoundationalPrinciples,
  getOperatingPrinciples,
  isCorePrincipleId,
} from '@principles/core/runtime-v2';
import type { CorePrinciple } from '@principles/core/runtime-v2';

/**
 * Core Principle Registry drift test (PRI-606/PRI-607).
 *
 * The shipped THINKING_OS.md templates (zh + en + workspace distribution)
 * must stay aligned with the Core Principle Registry in @principles/core:
 * same ACTIVE id set (deprecated ids excluded), exact names, exact layer
 * classification, and — the PRI-607 hardening — every <must> must contain
 * the registry's canonical statement as a verbatim anchor. Id-set or
 * name-only equality let semantics drift (correct id + correct name +
 * wrong statement passed the old guard); the statement anchor closes that.
 *
 * The old version of this guard compared the registry against the retired
 * builtin detection-pattern list (thinking-models.ts). That Activity-detection
 * surface was removed (2026-08-19); the registry itself and the THINKING_OS
 * guidance templates are current product and remain guarded here.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..', 'templates', 'langs');

const ACTIVE_PRINCIPLES = getActiveCorePrinciples();
const ACTIVE_IDS = ACTIVE_PRINCIPLES.map(p => p.id);
const DEPRECATED_PRINCIPLES = CORE_PRINCIPLES.filter(p => p.status === 'deprecated');

function loadTemplateDirectives(lang: 'zh' | 'en'): ThinkingOsDirective[] {
  const templatePath = path.join(TEMPLATE_ROOT, lang, 'principles', 'THINKING_OS.md');
  return parseThinkingOsMd(fs.readFileSync(templatePath, 'utf-8'));
}

/** Canonical statement anchor for a language: 'en' anchors statement, 'zh' anchors statementZh. */
function anchorFor(p: CorePrinciple, lang: 'en' | 'zh'): string {
  return lang === 'en' ? p.statement : p.statementZh;
}

/**
 * Full registry↔template alignment check. Throws (vitest expect) on any
 * drift: id set, name, layer, non-empty guidance, statement anchor.
 * Also reused by the negative-control test below.
 */
function expectTemplateMatchesRegistry(
  directives: ThinkingOsDirective[],
  lang: 'en' | 'zh',
  label: string,
): void {
  expect(directives.map(d => d.id).sort(), `${label}: directive id set must equal the ACTIVE registry id set`).toEqual([...ACTIVE_IDS].sort());

  for (const d of directives) {
    const p = ACTIVE_PRINCIPLES.find(x => x.id === d.id);
    expect(p, `${label} ${d.id}: directive id must resolve to an active registry principle`).toBeDefined();
    if (!p) continue;

    expect(d.name, `${label} ${d.id}: name drift`).toBe(p.name);
    expect(d.layer, `${label} ${d.id}: layer drift`).toBe(p.layer);
    expect(d.trigger.length, `${label} ${d.id} trigger`).toBeGreaterThan(0);
    expect(d.must.length, `${label} ${d.id} must`).toBeGreaterThan(0);
    expect(d.forbidden.length, `${label} ${d.id} forbidden`).toBeGreaterThan(0);

    // PRI-607 hardening: the canonical statement must survive verbatim inside
    // <must> — a template whose must quietly restates a different principle
    // (right id + right name, wrong semantics) must fail here.
    expect(d.must, `${label} ${d.id}: <must> must anchor the canonical ${lang} statement verbatim`).toContain(anchorFor(p, lang));
  }
}

describe('Core Principle Registry drift test', () => {
  describe('registry two-layer model invariants (PRI-606/PRI-607)', () => {
    it('active set is exactly 10 principles: 6 foundational + 4 operating', () => {
      expect(ACTIVE_PRINCIPLES).toHaveLength(10);
      expect(getFoundationalPrinciples()).toHaveLength(6);
      expect(getOperatingPrinciples()).toHaveLength(4);
      for (const p of ACTIVE_PRINCIPLES) {
        expect(['foundational', 'operating'], `${p.id} layer`).toContain(p.layer);
      }
    });

    it('deprecated entries stay resolvable but are excluded from every active set', () => {
      expect(DEPRECATED_PRINCIPLES.length).toBeGreaterThanOrEqual(1);
      const deprecatedIds = DEPRECATED_PRINCIPLES.map(p => p.id);
      for (const id of deprecatedIds) {
        expect(ACTIVE_IDS, `${id} must not be active`).not.toContain(id);
        // Historical artifacts reference deprecated ids — they keep validating.
        expect(isCorePrincipleId(id), `${id} must stay a known core principle id`).toBe(true);
      }
      expect(isCorePrincipleId('T-12')).toBe(false);
      // All registry ids (active + deprecated) resolvable via the frozen list.
      expect(CORE_PRINCIPLE_IDS.length).toBe(ACTIVE_PRINCIPLES.length + DEPRECATED_PRINCIPLES.length);
    });

    it('every deprecated entry declares supersededBy pointing at an active id', () => {
      for (const p of DEPRECATED_PRINCIPLES) {
        expect(p.supersededBy, `${p.id} supersededBy`).toBeDefined();
        expect(ACTIVE_IDS, `${p.id} supersededBy ${p.supersededBy} must be active`).toContain(p.supersededBy!);
      }
    });
  });

  for (const lang of ['zh', 'en'] as const) {
    describe(`THINKING_OS.md template (${lang})`, () => {
      it('matches the registry: ids, names, layers, and canonical statement anchors', () => {
        expectTemplateMatchesRegistry(loadTemplateDirectives(lang), lang, `${lang} template`);
      });
    });
  }

  // PRI-607: the workspace distribution template ships to fresh installs and
  // was frozen at the legacy 8-entry version, invisible to the langs guard.
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
  describe('repo dogfood .principles/THINKING_OS.md', () => {
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
  describe('negative control (PRI-607 statement anchor)', () => {
    it('a directive with correct id + name but mutated must FAILS the anchor check', () => {
      const mutated: ThinkingOsDirective[] = ACTIVE_PRINCIPLES.map((p, index) => ({
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
      const baseline: ThinkingOsDirective[] = ACTIVE_PRINCIPLES.map(p => ({
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
