/**
 * PRI-43: Core InternalizationRoute model tests
 *
 * Verifies that decideInternalizationRoute maps each DiagnosticianRecommendation
 * kind to the correct internalization pipeline route with proper readiness
 * and missing-field diagnostics.
 */
import { describe, it, expect } from 'vitest';
import type { DiagnosticianRecommendation } from '../diagnostician-output.js';

function makeRecommendation(
  overrides: Partial<DiagnosticianRecommendation> & Pick<DiagnosticianRecommendation, 'kind'>,
): DiagnosticianRecommendation {
  return {
    description: 'test recommendation',
    ...overrides,
  };
}

describe('decideInternalizationRoute', () => {
  // ── principle ──────────────────────────────────────────────────────────────

  it('principle with abstractedPrinciple maps to principle-ledger, ready=true', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({
      kind: 'principle',
      abstractedPrinciple: 'Avoid mixing concerns in a single module',
    });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('principle-ledger');
    expect(decision.ready).toBe(true);
    expect(decision.missingFields).toEqual([]);
  });

  it('principle missing abstractedPrinciple maps to principle-ledger, ready=false', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'principle' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('principle-ledger');
    expect(decision.ready).toBe(false);
    expect(decision.missingFields).toContain('abstractedPrinciple');
  });

  it('principle with whitespace-only abstractedPrinciple maps to principle-ledger, ready=false', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'principle', abstractedPrinciple: '   ' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('principle-ledger');
    expect(decision.ready).toBe(false);
    expect(decision.missingFields).toContain('abstractedPrinciple');
  });

  // ── rule ───────────────────────────────────────────────────────────────────

  it('rule with triggerPattern and action maps to rule-candidate, ready=true', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({
      kind: 'rule',
      triggerPattern: 'git\\s+push\\s+--force',
      action: 'block and require approval',
    });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('rule-candidate');
    expect(decision.ready).toBe(true);
    expect(decision.missingFields).toEqual([]);
  });

  it('rule missing triggerPattern maps to rule-candidate, ready=false', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({
      kind: 'rule',
      action: 'block and require approval',
    });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('rule-candidate');
    expect(decision.ready).toBe(false);
    expect(decision.missingFields).toContain('triggerPattern');
    expect(decision.missingFields).not.toContain('action');
  });

  it('rule missing action maps to rule-candidate, ready=false', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({
      kind: 'rule',
      triggerPattern: 'git\\s+push\\s+--force',
    });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('rule-candidate');
    expect(decision.ready).toBe(false);
    expect(decision.missingFields).toContain('action');
    expect(decision.missingFields).not.toContain('triggerPattern');
  });

  it('rule missing both triggerPattern and action has both in missingFields', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'rule' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('rule-candidate');
    expect(decision.ready).toBe(false);
    expect(decision.missingFields).toContain('triggerPattern');
    expect(decision.missingFields).toContain('action');
  });

  // ── implementation ─────────────────────────────────────────────────────────

  it('implementation maps to implementation-candidate, ready=true', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'implementation' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('implementation-candidate');
    expect(decision.ready).toBe(true);
    expect(decision.missingFields).toEqual([]);
  });

  // ── prompt ─────────────────────────────────────────────────────────────────

  it('prompt maps to prompt-injection-candidate, ready=true', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'prompt' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('prompt-injection-candidate');
    expect(decision.ready).toBe(true);
    expect(decision.missingFields).toEqual([]);
  });

  // ── defer ──────────────────────────────────────────────────────────────────

  it('defer maps to deferred, ready=false (never enters executable pipeline)', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({ kind: 'defer' });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('deferred');
    expect(decision.ready).toBe(false);
    expect(decision.reason).toContain('explicitly deferred');
    expect(decision.nextAction).toContain('No action needed');
  });

  // ── defensive: unknown kind ────────────────────────────────────────────────

  it('unknown/invalid kind maps to deferred with reason explaining unrecognized kind', async () => {
    const { decideInternalizationRoute } = await import('../internalization/internalization-route.js');
    const rec = makeRecommendation({
      kind: 'unknown_nonsense' as DiagnosticianRecommendation['kind'],
    });
    const decision = decideInternalizationRoute(rec);

    expect(decision.route).toBe('deferred');
    expect(decision.ready).toBe(false);
    expect(decision.reason).toContain('unknown_nonsense');
  });

  // ── barrel export ──────────────────────────────────────────────────────────

  it('core barrel exports decideInternalizationRoute', async () => {
    const mod = (await import('../index.js')) as Record<string, unknown>;
    expect(mod).toHaveProperty('decideInternalizationRoute');
    expect(typeof mod.decideInternalizationRoute).toBe('function');
  }, 30_000);
});
