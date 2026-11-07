import { describe, expect, it } from 'vitest';
import { getPromptModelCatalog } from '../pi-ai-catalog.js';

/**
 * PRI-1066: host-supplied model identifiers arrive as arbitrary strings (hook
 * payloads, CLI wrappers, provider configs). Trim + case-fold is a
 * DETERMINISTIC exact-key normalization — it must resolve differently-cased
 * spellings of the SAME catalog entry and must never invent a match for an
 * id the catalog does not contain.
 */
describe('pi-ai catalog exact-key normalization (PRI-1066)', () => {
  const catalog = getPromptModelCatalog();

  it('resolves a differently-cased provider/model pair to the same entry', () => {
    const canonical = catalog.exact('zai', 'glm-5.3-flash');
    expect(canonical).toBeDefined();
    expect(catalog.exact('ZAI', 'GLM-5.3-Flash')).toEqual(canonical);
    expect(catalog.exact(' zai ', '  glm-5.3-flash  ')).toEqual(canonical);
  });

  it('keeps name-only lookups case-insensitive and unanimous', () => {
    const matches = catalog.byModelId('GLM-5.3-Flash');
    expect(matches.length).toBeGreaterThan(0);
    expect(new Set(matches.map((entry) => entry.contextWindowTokens)).size).toBe(1);
  });

  it('never fabricates a match for an id the catalog does not contain', () => {
    expect(catalog.exact('custom-endpoint', 'glm-5.3-flash')).toBeUndefined();
    expect(catalog.exact('zai', 'glm-9-imaginary')).toBeUndefined();
    expect(catalog.byModelId('glm-9-imaginary')).toEqual([]);
  });
});
