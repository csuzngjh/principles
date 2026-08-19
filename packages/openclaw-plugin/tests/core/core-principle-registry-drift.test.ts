import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseThinkingOsMd } from '../../src/core/thinking-os-parser.js';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
} from '@principles/core/runtime-v2';

/**
 * Core Principle Registry drift test.
 *
 * The shipped THINKING_OS.md templates (zh + en) must stay aligned with the
 * Core Principle Registry (T-01..T-10) in @principles/core: same id set, no
 * extras, no missing entries, one directive per registry principle.
 *
 * The old version of this guard compared the registry against the retired
 * builtin detection-pattern list (thinking-models.ts). That Activity-detection
 * surface was removed (2026-08-19); the registry itself and the THINKING_OS
 * guidance templates are current product and remain guarded here.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATE_ROOT = path.resolve(__dirname, '..', '..', 'templates', 'langs');

function loadTemplateDirectives(lang: 'zh' | 'en') {
  const templatePath = path.join(TEMPLATE_ROOT, lang, 'principles', 'THINKING_OS.md');
  return parseThinkingOsMd(fs.readFileSync(templatePath, 'utf-8'));
}

describe('Core Principle Registry drift test', () => {
  it('registry ships exactly ten principles', () => {
    expect(CORE_PRINCIPLES).toHaveLength(10);
    expect(CORE_PRINCIPLE_IDS).toHaveLength(10);
  });

  for (const lang of ['zh', 'en'] as const) {
    describe(`THINKING_OS.md template (${lang})`, () => {
      it('directive ids match the registry id set exactly', () => {
        const directives = loadTemplateDirectives(lang);
        expect(directives.map(d => d.id).sort()).toEqual([...CORE_PRINCIPLE_IDS].sort());
      });

      it('every directive carries non-empty name/trigger/must guidance', () => {
        const directives = loadTemplateDirectives(lang);
        expect(directives.length).toBe(10);
        for (const d of directives) {
          expect(d.name.length, `${lang} ${d.id} name`).toBeGreaterThan(0);
          expect(d.trigger.length, `${lang} ${d.id} trigger`).toBeGreaterThan(0);
          expect(d.must.length, `${lang} ${d.id} must`).toBeGreaterThan(0);
        }
      });
    });
  }
});
