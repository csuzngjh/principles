/**
 * PRI-900: experiment-level Behavior Signature declaration — artifact guard.
 *
 * An experiment declaration is only useful while it still matches the SPEC it
 * claims to satisfy. This test walks every behavior-signature.json under
 * docs/experiments/ in the repository and validates its shape, so a future
 * declaration cannot silently drift into something the acceptance spec does
 * not recognise.
 *
 * It is deliberately NOT a new production abstraction (PRI-900 forbids a new
 * Behavior Engine / behavior schema):
 *   - the intent contract is validated by the REAL
 *     `isValidIntentContractV1` guard from @principles/core — the declaration
 *     must reuse IntentContract semantics verbatim, never re-declare them;
 *   - the only fields this guard adds are the three the SPEC says are NEW
 *     (Eligible Opportunity / Previous Behavior / observation windows);
 *   - the validation function lives here, next to its only consumer. Promoting
 *     it into `scripts/check-*.cjs` + `verify:merge` is a separate decision.
 *
 * The negative cases below are part of the deliverable: they prove the guard
 * rejects malformed declarations rather than passing everything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isValidIntentContractV1 } from '../src/runtime-v2/internalization/intent-contract.js';
import { resolveRepoRoot } from './bdd/support/repo-root.js';

// ── Shape rule ─────────────────────────────────────────────────────────────

const ALLOWED_CHANNELS = ['prompt', 'code_tool_hook'];
/** reality map G4: long-lived sessions make before/after inseparable. */
const FORBIDDEN_SPLIT_AXES = ['session', 'session_id', 'sessionId'];

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validate one behavior-signature declaration. Pure and total: any JSON value
 * yields a verdict, never a throw.
 */
export function validateBehaviorSignature(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(value)) return { valid: false, errors: ['declaration must be a JSON object'] };

  for (const key of ['experimentId', 'activationId', 'principleId', 'channel', 'activatedAt']) {
    if (!isNonEmptyString(value[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (isNonEmptyString(value['channel']) && !ALLOWED_CHANNELS.includes(value['channel'])) {
    errors.push(`channel must be one of ${ALLOWED_CHANNELS.join(' / ')}, got "${value['channel']}"`);
  }
  if (!isTimestamp(value['activatedAt'])) errors.push('activatedAt must be an ISO timestamp');
  if (value['deactivatedAt'] !== null && !isTimestamp(value['deactivatedAt'])) {
    errors.push('deactivatedAt must be null or an ISO timestamp');
  }

  const signature = value['behaviorSignature'];
  if (!isObject(signature)) {
    errors.push('behaviorSignature must be an object');
    return { valid: false, errors };
  }

  // The reused contract: validated by the SAME guard the pipeline uses.
  const contract = signature['intentContract'];
  if (!isObject(contract)) {
    errors.push('behaviorSignature.intentContract must be an object (reuse IntentContractV1 verbatim)');
  } else if (!isValidIntentContractV1(contract)) {
    errors.push('behaviorSignature.intentContract must be a valid IntentContractV1 (all five fields non-empty strings)');
  }

  // Eligible Opportunity — the SPEC's first NEW field.
  const opportunity = signature['eligibleOpportunity'];
  if (!isObject(opportunity)) {
    errors.push('behaviorSignature.eligibleOpportunity must be an object');
  } else {
    if (!isNonEmptyString(opportunity['definition'])) {
      errors.push('eligibleOpportunity.definition must describe when the behavior should appear');
    }
    const triggers = opportunity['observableTriggers'];
    if (!Array.isArray(triggers) || triggers.length === 0 || !triggers.every(isNonEmptyString)) {
      errors.push('eligibleOpportunity.observableTriggers must be a non-empty array of strings');
    }
  }

  // Previous Behavior — the SPEC's second NEW field, including B0 facts.
  const previous = signature['previousBehavior'];
  if (!isObject(previous)) {
    errors.push('behaviorSignature.previousBehavior must be an object');
  } else {
    if (!isNonEmptyString(previous['description'])) {
      errors.push('previousBehavior.description must describe how the agent behaved before activation');
    }
    if (!isNonEmptyString(previous['failurePattern'])) {
      errors.push('previousBehavior.failurePattern must name the failure family');
    }
    const baseline = previous['baselineWindow'];
    if (!isObject(baseline)) {
      errors.push('previousBehavior.baselineWindow must be an object');
    } else {
      if (!isTimestamp(baseline['from']) || !isTimestamp(baseline['to'])) {
        errors.push('previousBehavior.baselineWindow must carry from/to ISO timestamps');
      }
      if (isTimestamp(baseline['from']) && isTimestamp(baseline['to'])
        && Date.parse(baseline['from'] as string) >= Date.parse(baseline['to'] as string)) {
        errors.push('previousBehavior.baselineWindow.from must be strictly before .to');
      }
    }
    if (!isObject(previous['frequency'])) {
      errors.push('previousBehavior.frequency must record the baseline occurrence count');
    }
  }

  // Observation windows — at least one baseline plus two independent after-arms.
  const windows = signature['observationWindows'];
  if (!Array.isArray(windows) || windows.length < 3) {
    errors.push('behaviorSignature.observationWindows must declare a baseline plus at least two after windows');
  } else {
    const ids: string[] = [];
    for (const [index, window] of windows.entries()) {
      if (!isObject(window)) {
        errors.push(`observationWindows[${index}] must be an object`);
        continue;
      }
      const id = window['id'];
      if (!isNonEmptyString(id)) errors.push(`observationWindows[${index}].id must be a non-empty string`);
      else ids.push(id);
      if (!isTimestamp(window['from'])) errors.push(`observationWindows[${index}].from must be an ISO timestamp`);
      // An after window may still be open (to: null); a baseline may not.
      if (window['to'] !== null && !isTimestamp(window['to'])) {
        errors.push(`observationWindows[${index}].to must be null or an ISO timestamp`);
      }
      if (!isNonEmptyString(window['splitAxis'])) {
        errors.push(`observationWindows[${index}].splitAxis is required (created_at or runId, never session)`);
      } else if (FORBIDDEN_SPLIT_AXES.includes(window['splitAxis'])) {
        errors.push(`observationWindows[${index}].splitAxis must not be "session" — long-lived sessions mix before/after`);
      }
    }
    const baselines = windows.filter((w) => isObject(w) && w['kind'] === 'baseline');
    const afterWindows = windows.filter((w) => isObject(w) && w['kind'] === 'after');
    if (baselines.length !== 1) errors.push('exactly one baseline window is required');
    if (afterWindows.length < 2) errors.push('at least two independent after windows are required');
    if (new Set(ids).size !== ids.length) errors.push('observation window ids must be unique');
  }

  return { valid: errors.length === 0, errors };
}

// ── Repository artifacts ───────────────────────────────────────────────────

function behaviorSignaturePaths(): string[] {
  const root = join(resolveRepoRoot(), 'docs', 'experiments');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'behavior-signature.json'))
    .filter(existsSync);
}

describe('PRI-900 — repository behavior signatures validate', () => {
  const paths = behaviorSignaturePaths();

  it('the experiments directory declares at least one behavior signature', () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  for (const filePath of paths) {
    it(`${filePath.replace(resolveRepoRoot(), '').replace(/\\/g, '/')} matches the SPEC shape`, () => {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      const result = validateBehaviorSignature(parsed);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  }

  it('the PRI-836 declaration reuses its intent contract verbatim (no re-declared behavior fields)', () => {
    const filePath = paths.find((p) => p.includes('pri-836'));
    expect(filePath).toBeDefined();
    const parsed = JSON.parse(readFileSync(filePath as string, 'utf8')) as {
      behaviorSignature: { intentContract: unknown; intentContractProvenance: unknown };
    };
    // The upstream guard is the authority; the declaration must satisfy it as-is.
    expect(isValidIntentContractV1(parsed.behaviorSignature.intentContract)).toBe(true);
    expect(typeof parsed.behaviorSignature.intentContractProvenance).toBe('string');
    // The signature must NOT fork its own copies of the contract's fields.
    const signature = parsed.behaviorSignature as unknown as Record<string, unknown>;
    for (const forkedKey of ['targetBehavior', 'forbiddenBehavior', 'evidenceSource', 'validationExpected']) {
      expect(Object.hasOwn(signature, forkedKey)).toBe(false);
    }
  });

  it('the PRI-836 declaration anchors on activation lineage, and its windows bracket the activation', () => {
    const filePath = paths.find((p) => p.includes('pri-836'));
    const parsed = JSON.parse(readFileSync(filePath as string, 'utf8')) as {
      activationId: string;
      channel: string;
      activatedAt: string;
      behaviorSignature: {
        previousBehavior: { baselineWindow: { from: string; to: string } };
        observationWindows: Array<{ id: string; kind: string; from: string; to: string | null }>;
      };
    };
    // reality map G6: the bundle's lineage anchor is the activation, not the
    // principle id (which mixes titles/UUIDs/legacy values).
    expect(parsed.activationId).toContain('act_');
    expect(parsed.activatedAt).toBe('2026-09-21T19:20:48.751Z');

    const activatedAt = Date.parse(parsed.activatedAt);
    const baseline = parsed.behaviorSignature.previousBehavior.baselineWindow;
    expect(Date.parse(baseline.to)).toBeLessThanOrEqual(activatedAt);
    for (const window of parsed.behaviorSignature.observationWindows.filter((w) => w.kind === 'after')) {
      expect(Date.parse(window.from)).toBeGreaterThanOrEqual(activatedAt);
    }
  });
});

// ── Negative cases: the guard must reject, not bless ───────────────────────

function validDeclaration(): Record<string, unknown> {
  return {
    experimentId: 'PRI-000-001',
    activationId: 'act_test',
    principleId: 'principle-test',
    channel: 'prompt',
    activatedAt: '2026-01-01T00:00:00.000Z',
    deactivatedAt: null,
    behaviorSignature: {
      intentContract: {
        ownerIntent: 'owner intent',
        targetBehavior: 'target behavior',
        forbiddenBehavior: 'forbidden behavior',
        evidenceSource: 'evidence source',
        validationExpectation: 'validation expectation',
      },
      eligibleOpportunity: { definition: 'when it should appear', observableTriggers: ['a trigger'] },
      previousBehavior: {
        description: 'what the agent did before',
        failurePattern: 'assertion_without_observation',
        baselineWindow: { from: '2025-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
        frequency: { occurrences: 1 },
      },
      observationWindows: [
        { id: 'B0', kind: 'baseline', from: '2025-12-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z', splitAxis: 'created_at' },
        { id: 'A1', kind: 'after', from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', splitAxis: 'created_at' },
        { id: 'A2', kind: 'after', from: '2026-01-02T00:00:00.000Z', to: null, splitAxis: 'created_at' },
      ],
    },
  };
}

describe('PRI-900 — the shape rule rejects malformed declarations', () => {
  it('accepts the reference shape (the rule is not vacuously strict)', () => {
    expect(validateBehaviorSignature(validDeclaration()).errors).toEqual([]);
  });

  it.each([
    ['a missing behaviorSignature', (d: Record<string, unknown>) => { delete d['behaviorSignature']; }, 'behaviorSignature must be an object'],
    ['a missing intentContract', (d: Record<string, unknown>) => { delete (d['behaviorSignature'] as Record<string, unknown>)['intentContract']; }, 'intentContract must be an object'],
    ['an empty targetBehavior', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      (s['intentContract'] as Record<string, unknown>)['targetBehavior'] = '   ';
    }, 'valid IntentContractV1'],
    ['a missing eligibleOpportunity', (d: Record<string, unknown>) => { delete (d['behaviorSignature'] as Record<string, unknown>)['eligibleOpportunity']; }, 'eligibleOpportunity must be an object'],
    ['a missing previousBehavior', (d: Record<string, unknown>) => { delete (d['behaviorSignature'] as Record<string, unknown>)['previousBehavior']; }, 'previousBehavior must be an object'],
    ['only one after window', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      s['observationWindows'] = (s['observationWindows'] as unknown[]).slice(0, 2);
    }, 'at least two after windows'],
    ['a session-based split axis', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      for (const w of s['observationWindows'] as Array<Record<string, unknown>>) w['splitAxis'] = 'session';
    }, 'must not be "session"'],
    ['an unknown channel', (d: Record<string, unknown>) => { d['channel'] = 'telepathy'; }, 'channel must be one of'],
    ['an unanchored declaration (no activationId)', (d: Record<string, unknown>) => { d['activationId'] = ''; }, 'activationId must be a non-empty string'],
    ['a baseline that is not before its own end', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      const prev = s['previousBehavior'] as Record<string, unknown>;
      prev['baselineWindow'] = { from: '2026-01-02T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' };
    }, 'must be strictly before'],
  ])('rejects %s', (_label, mutate, expectedError) => {
    const declaration = validDeclaration();
    (mutate as (d: Record<string, unknown>) => void)(declaration);
    const result = validateBehaviorSignature(declaration);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' | ')).toContain(expectedError);
  });
});
