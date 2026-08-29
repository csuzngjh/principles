/**
 * Issue 2 (Codex E2E) / PRI-621 graduation: Artificer `output_invalid` retry flag.
 *
 * The `artificer_output_retry` feature flag (quiet, default ON since the
 * 2026-08-29 PRI-621 graduation) controls whether `output_invalid`
 * (malformed LLM output, e.g. the LLM never calls submit_rulecode) is
 * treated as a permanent error (legacy — immediate failure, no retry) or as
 * a retriable error (base retry policy, bounded by task.maxAttempts).
 *
 * Acceptance criteria:
 *   1. No effectiveConfig → `output_invalid` stays permanent (legacy).
 *   2. effectiveConfig + flag OFF → `output_invalid` stays permanent
 *      (explicit config override — the rollback path).
 *   3. effectiveConfig + flag ON → `output_invalid` is NOT permanent
 *      (retriable via base runner retry policy).
 *
 * ERR entries considered:
 *   - ERR-001/ERR-005: no `as` casts; flag resolution reads effectiveConfig
 *     only when present, falls back to false (rc-9: no silent fallback —
 *     legacy behavior is explicit).
 *   - ERR-024: no process/global state; pure feature-flag resolution.
 *
 * @see packages/principles-core/src/runtime-v2/internalization/artificer-runner.ts
 *   (permanentErrorCategories, isArtificerOutputRetryEnabled)
 * @see packages/principles-core/src/runtime-v2/config/pd-config-feature-flags.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { ArtificerRunner, type ArtificerRunnerDeps } from '../artificer-runner.js';
import { DefaultArtificerValidator } from '../artificer-output.js';
import type { EffectivePdConfig } from '../../config/pd-config-types.js';
import { getDefaultPdConfig } from '../../config/pd-config-defaults.js';
import { resolveProfile } from '../../config/pd-profile-constants.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { PDRuntimeAdapter } from '../../runtime-protocol.js';
import type { StoreEventEmitter } from '../../store/event-emitter.js';
import type { PIArtifactStore } from '../pi-artifact.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeEffectiveConfig(artificerOutputRetry: boolean): EffectivePdConfig {
  const base = getDefaultPdConfig();
  return {
    config: {
      ...base,
      features: {
        ...base.features,
        artificer_output_retry: {
          category: 'quiet',
          enabled: artificerOutputRetry,
        },
      },
    },
    source: 'user_config',
    warnings: [],
    featuresChangedFromDefault: artificerOutputRetry ? ['artificer_output_retry'] : [],
    resolvedProfile: resolveProfile({}),
    resolvedContextInjection: {
      thinkingOs: false,
      projectFocus: 'off',
      evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
    },
  };
}

function makeMinimalDeps(): ArtificerRunnerDeps {
  const empty = { get: vi.fn(), set: vi.fn() } as unknown;
  return {
    stateManager: empty as RuntimeStateManager,
    runtimeAdapter: empty as PDRuntimeAdapter,
    eventEmitter: empty as StoreEventEmitter,
    validator: new DefaultArtificerValidator(),
    artifactStore: empty as PIArtifactStore,
  };
}

function makeRunner(effectiveConfig?: EffectivePdConfig): ArtificerRunner {
  return new ArtificerRunner(makeMinimalDeps(), {
    owner: 'test',
    runtimeKind: 'artificer',
    effectiveConfig,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ArtificerRunner permanentErrorCategories — `artificer_output_retry` flag (Issue 2)', () => {
  it('output_invalid is permanent when effectiveConfig is absent (legacy)', () => {
    const runner = makeRunner();
    expect(runner.permanentErrorCategories.has('output_invalid')).toBe(true);
  });

  it('output_invalid is permanent when flag is OFF (explicit config override — rollback path)', () => {
    const runner = makeRunner(makeEffectiveConfig(false));
    expect(runner.permanentErrorCategories.has('output_invalid')).toBe(true);
  });

  it('output_invalid is retriable when flag is ON (explicit effective config)', () => {
    const runner = makeRunner(makeEffectiveConfig(true));
    expect(runner.permanentErrorCategories.has('output_invalid')).toBe(false);
  });

  it('output_invalid is retriable under the plain registry-default config (PRI-621 graduation)', () => {
    // No flag override at all: getDefaultPdConfig() derives from the
    // feature-flag contract, so this proves the registry default (ON) —
    // not just an explicit effectiveConfig.
    const base = getDefaultPdConfig();
    const runner = makeRunner({
      config: { ...base },
      source: 'user_config',
      warnings: [],
      featuresChangedFromDefault: [],
      resolvedProfile: resolveProfile({}),
      resolvedContextInjection: {
        thinkingOs: false,
        projectFocus: 'off',
        evolutionContext: { enabled: true, maxMessages: 4, maxCharsPerMessage: 200 },
      },
    });
    expect(runner.permanentErrorCategories.has('output_invalid')).toBe(false);
  });

  it('non-output_invalid permanent categories are unaffected by the flag', () => {
    const runner = makeRunner(makeEffectiveConfig(true));
    for (const category of ['storage_unavailable', 'workspace_invalid', 'capability_missing', 'cancelled', 'input_invalid'] as const) {
      expect(runner.permanentErrorCategories.has(category)).toBe(true);
    }
  });
});
