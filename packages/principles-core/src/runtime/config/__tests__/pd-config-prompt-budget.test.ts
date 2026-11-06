/**
 * PD Config promptBudget-section tests — PRI-1020
 * (SPEC-PD-OPERATOR-DECLARED-PROMPT-BUDGET-001).
 *
 * The Owner-declared model capacity section. Pins:
 *   - a present, valid section survives validation into the effective config
 *     (global value + per-host overrides, closed host set);
 *   - a LEGACY config without the section loads unchanged (zero migration —
 *     the budget chain then behaves exactly as before);
 *   - `operatorDeclaredContextWindow` resolves per-host override over the
 *     global declaration and undefined when nothing is declared;
 *   - boundary validation fails loud (rc-3): unknown keys, unknown hosts,
 *     non-integer windows, values outside the policy's plausibility bounds.
 *
 * The bounds are imported from the budget policy itself (single authority),
 * so config and policy can never disagree about what a plausible declared
 * window is.
 */
import { describe, it, expect } from 'vitest';
import { validatePdConfig, computeEffectivePdConfig, operatorDeclaredContextWindow } from '../index.js';
import { MIN_PLAUSIBLE_CONTEXT_WINDOW_TOKENS, MAX_PLAUSIBLE_CONTEXT_WINDOW_TOKENS } from '../../activation/prompt-budget-policy.js';

function makeValidRawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    features: {
      prompt: { category: 'core', enabled: true },
      code_tool_hook: { category: 'core', enabled: true },
      defer_archive: { category: 'core', enabled: true },
    },
    runtimeProfiles: {
      'openclaw.default': { type: 'openclaw', source: 'default' },
      'pd.custom': { type: 'pi-ai', provider: 'x', model: 'y', apiKeyEnv: 'X_KEY' },
    },
    internalAgents: {
      defaultRuntime: 'pd.custom',
      agents: {
        diagnostician: { enabled: true },
        dreamer: { enabled: true },
        scribe: { enabled: true },
        artificer: { enabled: true },
        philosopher: { enabled: false },
        evaluator: { enabled: false },
        rolloutReviewer: { enabled: false },
        correctionObserver: { enabled: false },
      },
    },
    ...overrides,
  };
}

function effectiveOf(raw: Record<string, unknown>) {
  const validated = validatePdConfig(raw);
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(`unexpected validation failure: ${JSON.stringify(validated.errors)}`);
  return computeEffectivePdConfig(validated.value);
}

function expectError(raw: Record<string, unknown>, pathPrefix: string): void {
  const validated = validatePdConfig(raw);
  expect(validated.ok).toBe(false);
  if (validated.ok) throw new Error('expected validation failure');
  expect(validated.errors.some((error) => error.path.startsWith(pathPrefix))).toBe(true);
}

describe('promptBudget — reading a configured section', () => {
  it('a legacy config without the section loads unchanged (zero migration)', () => {
    const effective = effectiveOf(makeValidRawConfig());
    expect(effective.config.promptBudget).toBeUndefined();
  });

  it('a global declaration survives validation into the effective config', () => {
    const effective = effectiveOf(makeValidRawConfig({
      promptBudget: { declaredContextWindowTokens: 262144 },
    }));
    expect(effective.config.promptBudget).toEqual({ declaredContextWindowTokens: 262144 });
  });

  it('per-host overrides survive with the closed host set', () => {
    const effective = effectiveOf(makeValidRawConfig({
      promptBudget: {
        declaredContextWindowTokens: 262144,
        hosts: { codex: 400000, workbuddy: 1000000 },
      },
    }));
    expect(effective.config.promptBudget).toEqual({
      declaredContextWindowTokens: 262144,
      hosts: { codex: 400000, workbuddy: 1000000 },
    });
  });

  it('hosts-only (no global value) is legal', () => {
    const effective = effectiveOf(makeValidRawConfig({
      promptBudget: { hosts: { openclaw: 211652 } },
    }));
    expect(effective.config.promptBudget).toEqual({ hosts: { openclaw: 211652 } });
  });
});

describe('promptBudget — operatorDeclaredContextWindow resolution', () => {
  it('per-host override wins over the global declaration', () => {
    const config = { declaredContextWindowTokens: 262144, hosts: { codex: 400000 } };
    expect(operatorDeclaredContextWindow(config, 'codex')).toBe(400000);
    expect(operatorDeclaredContextWindow(config, 'workbuddy')).toBe(262144);
    expect(operatorDeclaredContextWindow(config, 'openclaw')).toBe(262144);
  });

  it('undefined when nothing is declared (chain unchanged)', () => {
    expect(operatorDeclaredContextWindow(undefined, 'codex')).toBeUndefined();
    expect(operatorDeclaredContextWindow({}, 'codex')).toBeUndefined();
    expect(operatorDeclaredContextWindow({ hosts: { codex: 262144 } }, 'openclaw')).toBeUndefined();
  });
});

describe('promptBudget — fail-loud boundary validation (rc-3)', () => {
  it('rejects an unknown section key (ghost configuration)', () => {
    expectError(makeValidRawConfig({ promptBudget: { declaredWindow: 262144 } }), 'promptBudget.');
  });

  it('rejects a non-object section', () => {
    expectError(makeValidRawConfig({ promptBudget: 262144 }), 'promptBudget');
  });

  it('rejects an unknown host key', () => {
    expectError(makeValidRawConfig({ promptBudget: { hosts: { claude: 262144 } } }), 'promptBudget.hosts.');
  });

  it('rejects non-integer and out-of-bounds windows (policy plausibility bounds)', () => {
    for (const bad of [200000.5, MIN_PLAUSIBLE_CONTEXT_WINDOW_TOKENS - 1, MAX_PLAUSIBLE_CONTEXT_WINDOW_TOKENS + 1, '262144', null]) {
      expectError(
        makeValidRawConfig({ promptBudget: { declaredContextWindowTokens: bad } }),
        'promptBudget.declaredContextWindowTokens',
      );
    }
  });

  it('rejects an out-of-bounds per-host window', () => {
    expectError(
      makeValidRawConfig({ promptBudget: { hosts: { codex: 500 } } }),
      'promptBudget.hosts.codex',
    );
  });
});
