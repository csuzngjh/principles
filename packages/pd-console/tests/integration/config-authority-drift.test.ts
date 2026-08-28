import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VALID_OUTPUT_LANGUAGES,
  DEFAULT_OUTPUT_LANGUAGE,
} from '@principles/core/runtime-v2';

/**
 * PRI-611 — config semantic authority drift guard.
 *
 * The pd-console config store must DERIVE the output-language contract from
 * the canonical core authority (runtime-v2/language-directive.ts), not
 * re-declare it. Before PRI-611 the store carried its own
 * `VALID_OUTPUT_LANGUAGES = ['zh-CN', 'en']` / `DEFAULT_OUTPUT_LANGUAGE` /
 * `OutputLanguage` literals — the ERR-083 drift class (a new language added
 * to core would silently miss the console).
 *
 * This source-scan guard follows the established pattern in
 * create-principles-disciple/tests/mvp-config.test.ts (installer parity
 * guards): fail if the duplicate declaration sneaks back in.
 */

const storePath = path.resolve(__dirname, '..', '..', 'src', 'server', 'config', 'pd-config-store.ts');

describe('PRI-611 config authority drift guard', () => {
  it('pd-config-store derives output-language constants from core (no local re-declaration)', () => {
    const src = fs.readFileSync(storePath, 'utf-8');
    expect(
      src,
      'pd-config-store must not re-declare VALID_OUTPUT_LANGUAGES locally — import from @principles/core/runtime-v2 (PRI-611)',
    ).not.toMatch(/const\s+VALID_OUTPUT_LANGUAGES\s*=/);
    expect(
      src,
      'pd-config-store must not re-declare DEFAULT_OUTPUT_LANGUAGE locally — import from @principles/core/runtime-v2 (PRI-611)',
    ).not.toMatch(/const\s+DEFAULT_OUTPUT_LANGUAGE\s*=/);
    expect(
      src,
      'pd-config-store must import the output-language contract from the core barrel',
    ).toMatch(/import\s+\{[^}]*VALID_OUTPUT_LANGUAGES[^}]*\}\s+from\s+'@principles\/core\/runtime-v2'/);
  });

  it('console validation delegates to the same value list core exports (parity smoke)', () => {
    // The canonical authority must keep covering the values the console
    // accepts — if core changes this list, the console follows automatically
    // through the import; this assertion documents the current contract and
    // makes an accidental core-side narrowing visible in the console suite.
    expect(VALID_OUTPUT_LANGUAGES).toContain('zh-CN');
    expect(VALID_OUTPUT_LANGUAGES).toContain('en');
    expect(DEFAULT_OUTPUT_LANGUAGE).toBe('zh-CN');
  });
});
