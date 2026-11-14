/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §6.1 — context budget.
 */
import { describe, it, expect } from 'vitest';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { buildDiagnosticContextBudget } from '../diagnostic-context-budget.js';

const SYSTEM_PROMPT = 'You are a diagnostician. '.repeat(20);

describe('buildDiagnosticContextBudget', () => {
  it('records an unknown window instead of inventing a limit', () => {
    const budget = buildDiagnosticContextBudget({
      stage: 'B',
      modelInfo: { provider: 'unknown-host', model: 'unknown-model' },
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(budget.contextWindowLimit).toBeNull();
    expect(budget.inputBudgetTokens).toBeNull();
    expect(budget.estimates.contextWindowSource).toBe('unknown');
    expect(budget.estimates.tokenizer).toBe('heuristic_chars');
  });

  it('derives the input budget from the model window and output reservation', () => {
    const budget = buildDiagnosticContextBudget({
      stage: 'C',
      modelInfo: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
      systemPrompt: SYSTEM_PROMPT,
    });
    expect(budget.contextWindowLimit).toBe(128_000);
    expect(budget.maxOutputTokens).toBe(8_192);
    expect(budget.estimates.contextWindowSource).toBe('model_catalog');
    expect(budget.systemPromptTokens).toBe(estimateTextTokens(SYSTEM_PROMPT));
    expect(budget.safetyMarginTokens).toBeGreaterThan(0);
    expect(budget.inputBudgetTokens).toBeGreaterThan(0);
    expect(budget.inputBudgetTokens).toBeLessThan(128_000 - 8_192);
  });

  it('never reports provider usage it did not receive', () => {
    const budget = buildDiagnosticContextBudget({
      stage: 'B',
      modelInfo: { provider: 'p', model: 'm', contextWindowTokens: 32_000 },
      systemPrompt: '',
    });
    expect(budget.actualInputTokens).toBeNull();
    expect(budget.truncationMetadata).toBeNull();
  });
});
