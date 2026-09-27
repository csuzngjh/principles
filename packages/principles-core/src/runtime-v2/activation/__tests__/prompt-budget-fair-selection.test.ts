import { describe, it, expect } from 'vitest';
import {
  trimToBudget,
  RUNTIME_V2_PRINCIPLE_BUDGET,
} from '../prompt-activation-reader-contract.js';
import { escapeXml } from '../../../prompt-builder/index.js';
import type { ActivatedPrinciple } from '../prompt-activation-reader-contract.js';

/**
 * PRI-904 (SPEC v0.1) — deterministic fair rotation under the fixed prompt
 * budget. The fixture reproduces the audited live workspace byte-exactly:
 * 16 eligible prompt activations, ASC order, serialized entry lengths
 * [208,150,223,226,143,147,290,216,249,210,256,186,219,202,286,259]
 * (extracted read-only from the live state.db with the production
 * escapeXml serializer — see
 * docs/audit/pri-904-activation-injection-root-cause.md §5).
 * Under the OLD policy this reproduces the production ledger numbers
 * selected=9 / injectedCharCount=1893 / truncated=true / target absent.
 */
const LIVE_ENTRY_LENGTHS = [208, 150, 223, 226, 143, 147, 290, 216, 249, 210, 256, 186, 219, 202, 286, 259];
const TARGET_POSITION = 14; // historical ASC rank of the PRI-904 target principle
const OLDEST_POSITION = 1;

function entryLength(principle: ActivatedPrinciple): number {
  return `- [${escapeXml(principle.principleId)}] ${escapeXml(principle.text)}`.length;
}

function buildPri904Fixture(): ActivatedPrinciple[] {
  const fixture = LIVE_ENTRY_LENGTHS.map((len, i) => {
    const principleId = `PRI904-Fixture-${String(i + 1).padStart(2, '0')}`;
    const prefix = `- [${principleId}] `;
    return {
      principleId,
      text: 'P'.repeat(len - prefix.length),
      artifactId: `art-${i + 1}`,
      activationId: `act_prompt_${i + 1}`,
    };
  });
  // Fixture fidelity gate: every entry must hit the audited live length.
  fixture.forEach((p, i) => {
    if (entryLength(p) !== LIVE_ENTRY_LENGTHS[i]) {
      throw new Error(`fixture drift: entry #${i + 1} serialized to ${entryLength(p)}, expected ${LIVE_ENTRY_LENGTHS[i]}`);
    }
  });
  return fixture;
}

function pid(position: number): string {
  return `PRI904-Fixture-${String(position).padStart(2, '0')}`;
}

describe('PRI-904 trimToBudget — legacy characterization (T1 / AT-01)', () => {
  it('reproduces the audited production behavior byte-exactly: 16 → 9, 1893 chars, truncated, target absent', () => {
    const result = trimToBudget(buildPri904Fixture(), RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml);

    expect(result.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(result.injectedIds.size).toBe(9);
    expect(result.lines.join('\n').length).toBe(1893);
    expect(result.truncated).toBe(true);
    expect([...result.injectedIds]).toEqual([pid(1), pid(2), pid(3), pid(4), pid(5), pid(6), pid(7), pid(8), pid(9)]);
    expect(result.injectedIds.has(pid(TARGET_POSITION))).toBe(false);
    expect(result.eligibleCount).toBe(16);
    // The breaking entry (#10, 210c vs 107 remaining) is observable, not silent.
    expect(result.droppedActivationIds).toEqual(['act_prompt_10']);
    expect(result.oversizedActivationIds).toEqual([]);
  });

  it('legacy mode reports oversized instead of dropped when the breaking entry can never fit alone', () => {
    const result = trimToBudget(
      [{ principleId: 'BIG', text: 'B'.repeat(3000), artifactId: 'a', activationId: 'act_big' }],
      100,
    );
    expect(result.injectedIds.size).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.oversizedActivationIds).toEqual(['act_big']);
    expect(result.droppedActivationIds).toEqual([]);
  });
});

describe('PRI-904 trimToBudget — fair rotation (T2/T3/T4/T5 / AT-02..AT-05)', () => {
  it('16 consecutive round keys cover every eligible activation (union = 16/16)', () => {
    const fixture = buildPri904Fixture();
    const union = new Set<string>();
    for (let k = 0; k < 16; k++) {
      const result = trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k);
      expect(result.selectionPolicy).toBe('fair_rotation_v1');
      for (const id of result.injectedIds) union.add(id);
    }
    expect(union.size).toBe(16);
    expect([...union].sort()).toEqual(fixture.map((p) => p.principleId).sort());
  });

  it('the PRI-904 target (#14) is selected within the bounded 16-round window, without special-casing', () => {
    const fixture = buildPri904Fixture();
    const roundsSelected: number[] = [];
    for (let k = 0; k < 16; k++) {
      if (trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k).injectedIds.has(pid(TARGET_POSITION))) {
        roundsSelected.push(k);
      }
    }
    expect(roundsSelected.length).toBeGreaterThanOrEqual(1);
    // Audited replay: start=6 is the first round whose window reaches #14.
    expect(roundsSelected[0]).toBe(6);
  });

  it('no reverse starvation: the oldest activation (#1) is also selected within the same window', () => {
    const fixture = buildPri904Fixture();
    const roundsSelected: number[] = [];
    for (let k = 0; k < 16; k++) {
      if (trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k).injectedIds.has(pid(OLDEST_POSITION))) {
        roundsSelected.push(k);
      }
    }
    expect(roundsSelected.length).toBeGreaterThanOrEqual(1);
    expect(roundsSelected[0]).toBe(0);
  });

  it('every round stays within the hard 2000-char budget (T5 / AT-02)', () => {
    const fixture = buildPri904Fixture();
    for (let k = 0; k < 100; k++) {
      const result = trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k);
      expect(result.lines.join('\n').length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
    }
  });

  it('reports the normalized rotation start (roundKey mod N, negatives normalized)', () => {
    const fixture = buildPri904Fixture();
    expect(trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 21).rotationStartIndex).toBe(5);
    expect(trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, -1).rotationStartIndex).toBe(15);
  });
});

describe('PRI-904 trimToBudget — determinism (T6 / AT-06)', () => {
  it('same entries + budget + roundKey produce identical selection and output across 100 runs', () => {
    const fixture = buildPri904Fixture();
    const first = trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 42);
    for (let run = 0; run < 100; run++) {
      const result = trimToBudget(fixture, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 42);
      expect([...result.injectedIds]).toEqual([...first.injectedIds]);
      expect(result.lines.join('\n')).toBe(first.lines.join('\n'));
      expect(result.truncated).toBe(first.truncated);
      expect(result.rotationStartIndex).toBe(first.rotationStartIndex);
    }
  });
});

describe('PRI-904 trimToBudget — continue-on-non-fit (T7 / AT-08)', () => {
  function sized(id: string, cost: number, activationId: string): ActivatedPrinciple {
    const prefix = `- [${id}] `;
    return { principleId: id, text: 'X'.repeat(cost - 1 - prefix.length), artifactId: `art-${id}`, activationId };
  }

  it('a non-fitting entry no longer terminates the scan — a later shorter entry still fits', () => {
    // header 32 + C(400) leaves 100: A(200) cannot fit, B(100) still can.
    const entries = [sized('C', 400, 'act_c'), sized('A', 200, 'act_a'), sized('B', 100, 'act_b')];
    const fair = trimToBudget(entries, 32 + 500, (s) => s, 0);
    expect(fair.selectionPolicy).toBe('fair_rotation_v1');
    expect(fair.injectedIds.has('C')).toBe(true);
    expect(fair.injectedIds.has('A')).toBe(false);
    expect(fair.injectedIds.has('B')).toBe(true);
    expect(fair.droppedActivationIds).toEqual(['act_a']);
    expect(fair.truncated).toBe(true);
  });

  it('the legacy policy still stops at the first non-fit (rollback baseline is byte-identical)', () => {
    const entries = [sized('C', 400, 'act_c'), sized('A', 200, 'act_a'), sized('B', 100, 'act_b')];
    const legacy = trimToBudget(entries, 32 + 500);
    expect(legacy.injectedIds.has('C')).toBe(true);
    expect(legacy.injectedIds.has('A')).toBe(false);
    expect(legacy.injectedIds.has('B')).toBe(false); // break semantics: B never reconsidered
    expect(legacy.truncated).toBe(true);
  });
});

describe('PRI-904 trimToBudget — oversized semantics (T8 / AT-07)', () => {
  it('an entry larger than the whole principle budget is skipped, observable, and does not set truncated', () => {
    const oversized = { principleId: 'HUGE', text: 'H'.repeat(5000), artifactId: 'a1', activationId: 'act_huge' };
    const normal = { principleId: 'OK', text: 'ok text', artifactId: 'a2', activationId: 'act_ok' };
    const result = trimToBudget([oversized, normal], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 0);

    expect(result.injectedIds.has('HUGE')).toBe(false);
    expect(result.injectedIds.has('OK')).toBe(true); // scan continued past the oversized entry
    expect(result.oversizedActivationIds).toEqual(['act_huge']);
    expect(result.droppedActivationIds).toEqual([]);
    expect(result.truncated).toBe(false); // oversize-only is not budget truncation
  });

  it('a single oversized entry alone injects nothing and does not loop', () => {
    const result = trimToBudget(
      [{ principleId: 'ONLY', text: 'O'.repeat(9999), artifactId: 'a', activationId: 'act_only' }],
      RUNTIME_V2_PRINCIPLE_BUDGET,
      escapeXml,
      3,
    );
    expect(result.injectedIds.size).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.oversizedActivationIds).toEqual(['act_only']);
  });
});

describe('PRI-904 trimToBudget — adversarial inputs', () => {
  it('empty eligible set: no crash, header-only, legacy policy (fair path must not mod by zero)', () => {
    const fair = trimToBudget([], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 7);
    expect(fair.injectedIds.size).toBe(0);
    expect(fair.lines).toEqual(['Runtime V2 activated principles:']);
    expect(fair.selectionPolicy).toBe('legacy_fifo_prefix_v1');
    expect(fair.truncated).toBe(false);
  });

  it('single entry that fits: selected under any round key', () => {
    const entry = { principleId: 'ONE', text: 'single principle', artifactId: 'a', activationId: 'act_one' };
    for (const k of [0, 1, 5]) {
      const result = trimToBudget([entry], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k);
      expect(result.injectedIds.has('ONE')).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.rotationStartIndex).toBe(0);
    }
  });

  it('all entries fit: the fair policy must not introduce any drop', () => {
    const entries = ['alpha', 'beta', 'gamma'].map((id) => ({
      principleId: id, text: `text of ${id}`, artifactId: `a-${id}`, activationId: `act_${id}`,
    }));
    for (let k = 0; k < 3; k++) {
      const result = trimToBudget(entries, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k);
      expect(result.injectedIds.size).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.droppedActivationIds).toEqual([]);
      expect(result.oversizedActivationIds).toEqual([]);
    }
  });

  it('100 eligible entries under pressure: bounded payload, single-pass scan, bounded diagnostics, deterministic', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      principleId: `M-${String(i).padStart(3, '0')}`,
      text: 'm'.repeat(150),
      artifactId: `a-${i}`,
      activationId: `act_m_${i}`,
    }));
    const a = trimToBudget(entries, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 12345);
    const b = trimToBudget(entries, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 12345);
    expect(a.lines.join('\n').length).toBeLessThanOrEqual(RUNTIME_V2_PRINCIPLE_BUDGET);
    expect(a.injectedIds.size).toBeLessThan(100);
    expect(a.droppedActivationIds.length).toBeLessThanOrEqual(16);
    expect(a.oversizedActivationIds.length).toBeLessThanOrEqual(16);
    expect([...a.injectedIds]).toEqual([...b.injectedIds]);
    // Every key hits a valid start; the rotation reaches every position over
    // 100 consecutive keys (each position is its own round's first pick).
    const union = new Set<string>();
    for (let k = 0; k < 100; k++) {
      for (const id of trimToBudget(entries, RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, k).injectedIds) union.add(id);
    }
    expect(union.size).toBe(100);
  });

  it('extremely long activation text does not crash and stays observable', () => {
    const huge = { principleId: 'LONG', text: 'L'.repeat(1_000_000), artifactId: 'a', activationId: 'act_long' };
    const result = trimToBudget([huge], RUNTIME_V2_PRINCIPLE_BUDGET, escapeXml, 1);
    expect(result.injectedIds.size).toBe(0);
    expect(result.oversizedActivationIds).toEqual(['act_long']);
    expect(result.truncated).toBe(false);
  });

  it('diagnostic id lists are hard-capped at 16 entries', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      principleId: `D-${String(i).padStart(2, '0')}`,
      text: 'd'.repeat(200),
      artifactId: `a-${i}`,
      activationId: `act_d_${i}`,
    }));
    const result = trimToBudget(entries, 1000, (s) => s, 0);
    expect(result.droppedActivationIds.length).toBeLessThanOrEqual(16);
    expect(result.truncated).toBe(true);
  });

  it('oversized diagnostics are hard-capped at 16 entries (fair scan continues past every oversized entry)', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      principleId: `O-${String(i).padStart(2, '0')}`,
      text: 'o'.repeat(5000),
      artifactId: `a-${i}`,
      activationId: `act_o_${i}`,
    }));
    const result = trimToBudget(entries, 1000, (s) => s, 3);
    expect(result.oversizedActivationIds.length).toBe(16);
    expect(result.injectedIds.size).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
