import { describe, it, expect } from 'vitest';
import { listThinkingModels } from '../../src/core/thinking-models.js';
import {
  CORE_PRINCIPLES,
  CORE_PRINCIPLE_IDS,
} from '@principles/core/runtime-v2';

describe('Core Principle Registry drift test', () => {
  it('registry count matches thinking-models.ts builtin count', () => {
    // No workspace → falls back to builtin patterns (T-01..T-10)
    const models = listThinkingModels();
    expect(models).toHaveLength(10);
    expect(CORE_PRINCIPLES).toHaveLength(10);
  });

  it('registry ids match thinking-models.ts ids', () => {
    const models = listThinkingModels();
    const modelIds = models.map(m => m.id).sort();
    const registryIds = CORE_PRINCIPLE_IDS.slice().sort();
    expect(registryIds).toEqual(modelIds);
  });

  it('registry names match thinking-models.ts fallback names', () => {
    const models = listThinkingModels();
    for (const model of models) {
      const registryEntry = CORE_PRINCIPLES.find(p => p.id === model.id);
      expect(registryEntry).toBeDefined();
      // model.name comes from getFallbackName() when no workspace
      expect(registryEntry!.name).toBe(model.name);
    }
  });

  it('no extra or missing ids in registry', () => {
    const models = listThinkingModels();
    const modelIdSet = new Set(models.map(m => m.id));
    const registryIdSet = new Set(CORE_PRINCIPLE_IDS);
    expect(registryIdSet).toEqual(modelIdSet);
  });
});
