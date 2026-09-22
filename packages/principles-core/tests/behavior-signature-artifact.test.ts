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
/**
 * The IntentContractV1 field names (the authority is
 * `packages/principles-core/src/runtime-v2/internalization/intent-contract.ts`).
 * Spelling them once here keeps the fork check honest — an earlier draft listed
 * `validationExpected`, which does not exist, so the check silently passed.
 */
const CONTRACT_FIELDS = ['ownerIntent', 'targetBehavior', 'forbiddenBehavior', 'evidenceSource', 'validationExpectation'];

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

/**
 * Strict ISO-8601 UTC timestamp → epoch milliseconds, or null when the value is
 * not one.
 *
 * `Date.parse` alone is NOT a validity test (measured on this repo's Node):
 *   - `Date.parse('2026-02-30T00:00:00.000Z')` is not NaN — it silently yields
 *     2026-03-02, so a non-existent date would pass as a valid timestamp;
 *   - `Date.parse('March 1, 2026')` / `'03/01/2026'` / `'2026/03/01 00:00:00'`
 *     are all accepted through implementation-specific parsing, i.e. a
 *     declaration could carry something that is not ISO at all.
 * So the format is matched explicitly AND the parsed instant is round-tripped
 * back through the UTC calendar to reject dates that only exist after rollover.
 */
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = ISO_TIMESTAMP.exec(trimmed);
  if (!match) return null;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(ms);
  const sameCalendarMoment = parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() === Number(month) - 1
    && parsed.getUTCDate() === Number(day)
    && parsed.getUTCHours() === Number(hour)
    && parsed.getUTCMinutes() === Number(minute)
    && parsed.getUTCSeconds() === Number(second);
  return sameCalendarMoment ? ms : null;
}

function isTimestamp(value: unknown): boolean {
  return parseIsoTimestamp(value) !== null;
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
  // Parsed ONCE: the epoch value doubles as the anchor for every window
  // invariant below, and an unparseable activatedAt simply suppresses those
  // comparisons instead of adding a second, redundant error.
  const activatedAt = parseIsoTimestamp(value['activatedAt']);
  if (activatedAt === null) errors.push('activatedAt must be an ISO timestamp');
  if (value['deactivatedAt'] !== null && !isTimestamp(value['deactivatedAt'])) {
    errors.push('deactivatedAt must be null or an ISO timestamp');
  }

  const signature = value['behaviorSignature'];
  if (!isObject(signature)) {
    errors.push('behaviorSignature must be an object');
    return { valid: false, errors };
  }

  // The contract fields the SPEC says to REUSE must not be re-declared beside
  // the contract: two copies of targetBehavior is a second source of truth for
  // the same fact (P4), and this guard covers every declaration, not just the
  // one reviewed today.
  for (const contractField of CONTRACT_FIELDS) {
    if (Object.hasOwn(signature, contractField)) {
      errors.push(`behaviorSignature must not redeclare ${contractField}; reuse intentContract.${contractField}`);
    }
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
      const fromMs = parseIsoTimestamp(baseline['from']);
      const toMs = parseIsoTimestamp(baseline['to']);
      if (fromMs === null || toMs === null) {
        errors.push('previousBehavior.baselineWindow must carry from/to ISO timestamps');
      } else if (fromMs >= toMs) {
        errors.push('previousBehavior.baselineWindow.from must be strictly before .to');
      }
      // "Previous Behavior" is by definition pre-activation (v3 §B0 Baseline),
      // so the same upper bound the observation windows carry applies here.
      if (toMs !== null && activatedAt !== null && toMs > activatedAt) {
        errors.push('previousBehavior.baselineWindow.to must not be after activatedAt');
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
      const fromMs = parseIsoTimestamp(window['from']);
      if (fromMs === null) errors.push(`observationWindows[${index}].from must be an ISO timestamp`);
      // An AFTER window may still be open (to: null) — the observation has not
      // finished. A baseline may NOT: a baseline with no end is unbounded and
      // cannot state what the "before" period actually was.
      if (window['to'] === null && window['kind'] === 'baseline') {
        errors.push(`observationWindows[${index}].baseline.to must be an ISO timestamp, not null`);
      }
      const toMs = window['to'] === null ? null : parseIsoTimestamp(window['to']);
      if (window['to'] !== null && toMs === null) {
        errors.push(`observationWindows[${index}].to must be null or an ISO timestamp`);
      }
      // Only compare when BOTH endpoints parsed: an unparseable endpoint
      // already produced its own error above.
      if (fromMs !== null && toMs !== null && fromMs >= toMs) {
        errors.push(`observationWindows[${index}].from must be strictly before .to`);
      }
      if (window['kind'] === 'baseline' && toMs !== null && activatedAt !== null && toMs > activatedAt) {
        errors.push(`observationWindows[${index}].baseline.to must not be after activatedAt`);
      }
      if (window['kind'] === 'after' && fromMs !== null && activatedAt !== null && fromMs < activatedAt) {
        errors.push(`observationWindows[${index}].after.from must not be before activatedAt`);
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

  it('the PRI-836 declaration reuses its intent contract verbatim', () => {
    const filePath = paths.find((p) => p.includes('pri-836'));
    expect(filePath).toBeDefined();
    const parsed = JSON.parse(readFileSync(filePath as string, 'utf8')) as {
      behaviorSignature: { intentContract: unknown; intentContractProvenance: unknown };
    };
    // The upstream guard is the authority; the declaration must satisfy it as-is.
    // (Forked contract fields are rejected by validateBehaviorSignature itself —
    // see the negative cases — so this test only pins the reuse.)
    expect(isValidIntentContractV1(parsed.behaviorSignature.intentContract)).toBe(true);
    expect(typeof parsed.behaviorSignature.intentContractProvenance).toBe('string');
    expect(parsed.behaviorSignature.intentContractProvenance).toContain('content_json.intentContract');
  });

  it('the PRI-836 declaration anchors on activation lineage and declares B0 + two after arms', () => {
    const filePath = paths.find((p) => p.includes('pri-836'));
    const parsed = JSON.parse(readFileSync(filePath as string, 'utf8')) as {
      activationId: string;
      channel: string;
      activatedAt: string;
      behaviorSignature: {
        observationWindows: Array<{ id: string; kind: string; status: string }>;
      };
    };
    // reality map G6: the bundle's lineage anchor is the activation, not the
    // principle id (which mixes titles/UUIDs/legacy values).
    expect(parsed.activationId).toContain('act_');
    expect(parsed.channel).toBe('prompt');
    // The activation under experiment (PRI-768's golden-journey activation).
    expect(parsed.activatedAt).toBe('2026-09-21T19:20:48.751Z');

    // Artifact-specific fact the generic rule cannot know: the observed arms.
    // The temporal invariants over these windows are enforced generically.
    const windows = parsed.behaviorSignature.observationWindows;
    expect(windows.map((w) => w.id)).toEqual(['B0', 'A1', 'A2']);
    expect(windows.filter((w) => w.kind === 'after')).toHaveLength(2);
    // A1 is collected but NOT yet adjudicated — the declaration must not imply
    // a verdict (reality map Gap 2: prompt-channel compliance needs the Owner).
    expect(windows.find((w) => w.id === 'A1')?.status).toBe('declared_pending_adjudication');
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
    // ── Timestamp strictness (Date.parse alone accepts all of these) ────────
    ['a non-existent calendar date (2026-02-30 rolls over to Mar 2)', (d: Record<string, unknown>) => {
      d['activatedAt'] = '2026-02-30T00:00:00.000Z';
    }, 'activatedAt must be an ISO timestamp'],
    ['a non-ISO date format', (d: Record<string, unknown>) => {
      d['activatedAt'] = 'March 1, 2026';
    }, 'activatedAt must be an ISO timestamp'],
    ['a locale-style numeric date', (d: Record<string, unknown>) => {
      d['activatedAt'] = '03/01/2026';
    }, 'activatedAt must be an ISO timestamp'],
    ['a date-only value with no time component', (d: Record<string, unknown>) => {
      d['activatedAt'] = '2026-01-01';
    }, 'activatedAt must be an ISO timestamp'],
    ['an out-of-range hour', (d: Record<string, unknown>) => {
      d['activatedAt'] = '2026-01-01T25:00:00.000Z';
    }, 'activatedAt must be an ISO timestamp'],
    ['an out-of-range timezone offset', (d: Record<string, unknown>) => {
      d['activatedAt'] = '2026-01-01T00:00:00.000+99:00';
    }, 'activatedAt must be an ISO timestamp'],
    ['a non-UTC (offset) timestamp instead of the Z form', (d: Record<string, unknown>) => {
      d['activatedAt'] = '2026-01-01T00:00:00.000+08:00';
    }, 'activatedAt must be an ISO timestamp'],
    ['a window endpoint that is not a real date', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      (s['observationWindows'] as Array<Record<string, unknown>>)[1]!['from'] = '2026-02-30T00:00:00.000Z';
    }, 'observationWindows[1].from must be an ISO timestamp'],
    // ── Observation-window invariants ──────────────────────────────────────
    ['a baseline window that is open-ended (to: null)', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      (s['observationWindows'] as Array<Record<string, unknown>>)[0]!['to'] = null;
    }, 'baseline.to must be an ISO timestamp, not null'],
    ['a closed window whose from is after its to', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      const w = (s['observationWindows'] as Array<Record<string, unknown>>)[1]!;
      w['from'] = '2026-01-05T00:00:00.000Z';
      w['to'] = '2026-01-02T00:00:00.000Z';
    }, 'from must be strictly before .to'],
    ['a closed window whose from equals its to', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      const w = (s['observationWindows'] as Array<Record<string, unknown>>)[1]!;
      w['to'] = w['from'];
    }, 'from must be strictly before .to'],
    ['a baseline that ends after the activation', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      (s['observationWindows'] as Array<Record<string, unknown>>)[0]!['to'] = '2027-01-01T00:00:00.000Z';
    }, 'baseline.to must not be after activatedAt'],
    ['an after window that starts before the activation', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      (s['observationWindows'] as Array<Record<string, unknown>>)[1]!['from'] = '2025-01-01T00:00:00.000Z';
    }, 'after.from must not be before activatedAt'],
    ['a previousBehavior baseline that ends after the activation', (d: Record<string, unknown>) => {
      const s = d['behaviorSignature'] as Record<string, unknown>;
      const prev = s['previousBehavior'] as Record<string, unknown>;
      prev['baselineWindow'] = { from: '2025-12-31T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' };
    }, 'previousBehavior.baselineWindow.to must not be after activatedAt'],
    // ── Forking the contract beside the contract ───────────────────────────
    // The earlier draft listed `validationExpected` (a field that does not
    // exist) and omitted ownerIntent, so it proved nothing. Both real names are
    // now covered.
    ['a forked validationExpectation beside the contract', (d: Record<string, unknown>) => {
      (d['behaviorSignature'] as Record<string, unknown>)['validationExpectation'] = 'a second source of truth';
    }, 'must not redeclare validationExpectation'],
    ['a forked ownerIntent beside the contract', (d: Record<string, unknown>) => {
      (d['behaviorSignature'] as Record<string, unknown>)['ownerIntent'] = 'a second source of truth';
    }, 'must not redeclare ownerIntent'],
    ['a forked targetBehavior beside the contract', (d: Record<string, unknown>) => {
      (d['behaviorSignature'] as Record<string, unknown>)['targetBehavior'] = 'a second source of truth';
    }, 'must not redeclare targetBehavior'],
  ])('rejects %s', (_label, mutate, expectedError) => {
    const declaration = validDeclaration();
    (mutate as (d: Record<string, unknown>) => void)(declaration);
    const result = validateBehaviorSignature(declaration);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' | ')).toContain(expectedError);
  });

  it('the reuse guard still accepts the reference contract (no over-rejection)', () => {
    // The positive arm above covers the whole declaration; this pins that the
    // fork rule keys on the SIGNATURE object, not on the nested contract.
    expect(isValidIntentContractV1(
      (validDeclaration()['behaviorSignature'] as Record<string, unknown>)['intentContract'],
    )).toBe(true);
  });

  it('CONTRACT_FIELDS matches the authority in intent-contract.ts', () => {
    // Pins the fork-check list to the real guard: a renamed or misspelled entry
    // (the defect this test was added for) makes one of these fail.
    const contract = Object.fromEntries(CONTRACT_FIELDS.map((field) => [field, `value for ${field}`]));
    expect(isValidIntentContractV1(contract)).toBe(true);
    for (const field of CONTRACT_FIELDS) {
      const missing = { ...contract };
      delete missing[field];
      expect(isValidIntentContractV1(missing), `dropping ${field} must invalidate the contract`).toBe(false);
    }
    expect(Object.keys(contract)).toHaveLength(5);
  });
});
