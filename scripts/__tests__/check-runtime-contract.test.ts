/**
 * Incremental Runtime Contract Scanner — TDD self-tests (Issue #996).
 *
 * Mirrors scripts/__tests__/check-repo-hygiene.test.ts convention: direct
 * import of pure functions, no child-process spawn. Coverage:
 *   - 6 issue-required acceptance cases (tests #1–#6 below)
 *   - 6 boundary cases for false-positive prevention (tests #7–#12)
 *
 * ERR-025 (Test Reality Gap): the diff-parse and end-to-end scan tests use
 * real unified-diff fixture strings, not stub returns, so they exercise the
 * actual hunk-parsing path users rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  checkLine,
  parseExemption,
  RULES,
} from '../runtime-contract-rules.js';
import {
  parseDiffHunks,
  resolveBaseRef,
  buildTrustContext,
} from '../runtime-contract-diff.js';
import { scan, isEscapeHatchSet } from '../check-runtime-contract.js';
import type { ResolvedBase, FileHunks } from '../runtime-contract-diff.js';

const untrustedCtx = (vars: string[]) => ({ untrustedVars: new Set(vars) });

describe('runtime-contract-rules — RULES export', () => {
  it('exposes ERR-001, ERR-005, ERR-013 with title + autofix', () => {
    const ids = RULES.map((r) => r.id).sort();
    expect(ids).toEqual(['ERR-001', 'ERR-005', 'ERR-013']);
    for (const r of RULES) {
      expect(typeof r.title).toBe('string');
      expect(r.title.length).toBeGreaterThan(10);
      expect(typeof r.autofix).toBe('string');
    }
  });
});

describe('runtime-contract-rules — checkLine', () => {
  it('#1 detects `key in obj` as ERR-013 when operand is untrusted', () => {
    // Issue acceptance criterion.
    const r = checkLine("'type' in parsed", untrustedCtx(['parsed']));
    expect(r).toEqual({ ruleId: 'ERR-013' });
  });

  it('#2 does NOT flag Object.hasOwn(obj, key)', () => {
    // Issue acceptance criterion — no false positive on the sanctioned pattern.
    const r = checkLine("if (!Object.hasOwn(parsed, 'type')) return;", untrustedCtx(['parsed']));
    expect(r).toBeNull();
  });

  it('#7 does NOT flag `as const` (literal narrowing)', () => {
    expect(checkLine("const mode = 'full' as const;", untrustedCtx([]))).toBeNull();
  });

  it('#8 flags `as unknown as X` double cast (ERR-001, unconditional)', () => {
    // Double cast defeats even loose type checks — always a bypass.
    expect(checkLine('const x = parsed as unknown as Foo;', untrustedCtx(['parsed']))).toEqual({
      ruleId: 'ERR-001',
    });
    // Even when operand is NOT in the untrusted set, double cast is flagged.
    expect(checkLine('const x = localVal as unknown as Foo;', untrustedCtx([]))).toEqual({
      ruleId: 'ERR-001',
    });
  });

  it('#9 does NOT flag `in` after `instanceof Error` (type narrowing on caught)', () => {
    // Explore-calibrated whitelist: Error-narrowing is a typed-union case.
    const r = checkLine(
      "if (e instanceof Error && 'code' in e) { /* ... */ }",
      untrustedCtx(['e']),
    );
    expect(r).toBeNull();
  });

  it('#10 flags array-element `as Foo[]` cast on untrusted operand (ERR-005)', () => {
    const r = checkLine('const rows = db.all(sql) as Row[];', untrustedCtx([]));
    expect(r).toEqual({ ruleId: 'ERR-005' });
  });

  it('#11 does NOT flag `as unknown[]` (sanctioned ERR-005 fix prefix)', () => {
    const r = checkLine(
      "(plugins.allow as unknown[]).filter((a): a is string => typeof a === 'string')",
      untrustedCtx(['plugins']),
    );
    expect(r).toBeNull();
  });

  it('does NOT flag `in` when operand is not an untracked var (typed union)', () => {
    // Explore sample: 'ok' in result on a typed Result union.
    expect(checkLine("return 'ok' in result && result.ok === false;", untrustedCtx([]))).toBeNull();
  });

  it('flags inline `JSON.parse(...) as Foo` (ERR-001) without trust context', () => {
    // Inline untrusted call is detected directly on the line — no data flow needed.
    expect(checkLine('const x = JSON.parse(raw) as Foo;', untrustedCtx([]))).toEqual({
      ruleId: 'ERR-001',
    });
  });

  it('does NOT flag `as NodeJS.ErrnoException` (Error narrowing)', () => {
    expect(
      checkLine("const code = (err as NodeJS.ErrnoException).code;", untrustedCtx(['err'])),
    ).toBeNull();
  });

  it('returns null for a non-string input (defensive)', () => {
    // Runtime Contract Rule 1 — treat everything as unknown; no exceptions.
    expect(checkLine(undefined as unknown as string, untrustedCtx([]))).toBeNull();
  });

  // ── Regression tests for adversarial-review findings (ERR-025 protection) ──
  // These pin the P0/P1 fixes that the first review pass missed. Each test
  // documents a concrete counter-example that previously produced a wrong
  // result; without these tests the same bug class could silently recur.

  describe('regression: regex literals and comments (P0-1, P1-1)', () => {
    it('does NOT let a regex literal containing // mask a real violation', () => {
      // P0-1: `/http:\/\//` was wrongly parsed as a line comment, hiding the
      // `parsed as string` violation on the same line.
      const r = checkLine(
        String.raw`const re = /http:\/\//; const x = parsed as string;`,
        untrustedCtx(['parsed']),
      );
      expect(r).toEqual({ ruleId: 'ERR-001' });
    });

    it('does NOT flag `as` tokens inside a block comment', () => {
      // P1-1: `/* parsed as Foo */` was wrongly flagged.
      const r = checkLine('const x = 1; /* parsed as Foo */', untrustedCtx(['parsed']));
      expect(r).toBeNull();
    });

    it('does NOT flag `as` inside a string literal', () => {
      const r = checkLine("const msg = 'parsed as string';", untrustedCtx(['parsed']));
      expect(r).toBeNull();
    });

    it('still honors a trailing exemption after a regex literal', () => {
      // Exemption handling is the caller's job, but checkLine must not strip
      // the exemption comment — it should still see the code before it.
      const r = checkLine(
        "const x = parsed as string; // runtime-contract-exempt: ERR-001 reason",
        untrustedCtx(['parsed']),
      );
      // checkLine reports the violation; the caller's isExempted consumes it.
      expect(r).toEqual({ ruleId: 'ERR-001' });
    });
  });

  describe('regression: for-in loops (P0-2)', () => {
    it('does NOT flag `for (const k in untrusted)` as ERR-013', () => {
      // P0-2: for-in iteration is not a property-existence check.
      expect(checkLine('for (const k in parsed) {', untrustedCtx(['parsed']))).toBeNull();
      expect(checkLine('for (const key in data) console.log(key);', untrustedCtx(['data']))).toBeNull();
    });

    it('still flags a real `in` check after a for-of (different construct)', () => {
      // for-of is not for-in — but more importantly, a real `'k' in obj` check
      // elsewhere on the line is still caught.
      expect(checkLine("if ('x' in parsed) {}", untrustedCtx(['parsed']))).toEqual({
        ruleId: 'ERR-013',
      });
    });
  });

  describe('regression: trust-context data flow (P0-3, P1-2, P1-3)', () => {
    it('does NOT mark `.map()` results as untrusted (P0-3)', () => {
      // P0-3: Array.prototype.map was wrongly classified as a DB method.
      const ctx = buildTrustContext(['const items = list.map((x) => x.id);']);
      expect(ctx.untrustedVars.has('items')).toBe(false);
      expect(checkLine("if ('k' in items) {}", ctx)).toBeNull();
    });

    it('marks only the untrusted pair in a multi-declaration (P1-2)', () => {
      // P1-2: `const a = 1, b = JSON.parse(x)` — only b should be untrusted.
      const ctx = buildTrustContext(['const a = 1, b = JSON.parse(x);']);
      expect(ctx.untrustedVars.has('a')).toBe(false);
      expect(ctx.untrustedVars.has('b')).toBe(true);
    });

    it('does NOT pollute the untrusted set with type-annotation tokens (P1-3)', () => {
      // P1-3: `const parsed: Record<string, unknown> = JSON.parse(raw)` was
      // collecting Record/string/unknown as bogus untrusted vars.
      const ctx = buildTrustContext([
        'const parsed: Record<string, unknown> = JSON.parse(raw);',
      ]);
      expect([...ctx.untrustedVars]).toEqual(['parsed']);
    });

    it('still tracks destructuring from an untrusted source', () => {
      const ctx = buildTrustContext(['const { a, b } = JSON.parse(raw);']);
      expect(ctx.untrustedVars.has('a')).toBe(true);
      expect(ctx.untrustedVars.has('b')).toBe(true);
    });

    it('still tracks db.all / db.get / db.query / db.raw', () => {
      const ctx = buildTrustContext([
        'const rows = stmt.all(sql);',
        'const one = stmt.get(id);',
        'const q = db.query(sql);',
        'const r = db.raw(sql);',
      ]);
      expect(ctx.untrustedVars.has('rows')).toBe(true);
      expect(ctx.untrustedVars.has('one')).toBe(true);
      expect(ctx.untrustedVars.has('q')).toBe(true);
      expect(ctx.untrustedVars.has('r')).toBe(true);
    });
  });
});

describe('runtime-contract-rules — parseExemption', () => {
  it('#3 honors valid exemption (ERR ID + non-empty reason)', () => {
    // Issue acceptance criterion.
    const r = parseExemption(
      '// runtime-contract-exempt: ERR-013 upstream schema already validated',
    );
    expect(r).toEqual({ errId: 'ERR-013', reason: 'upstream schema already validated' });
  });

  it('#4 rejects exemption without reason (returns MALFORMED)', () => {
    // Issue acceptance criterion — an exemption that silently passes would mask
    // a violation. Treat it as its own defect.
    expect(parseExemption('// runtime-contract-exempt: ERR-013')).toBe('MALFORMED');
    // Empty reason after trimming.
    expect(parseExemption('// runtime-contract-exempt: ERR-013    ')).toBe('MALFORMED');
  });

  it('returns null for a non-exemption comment line', () => {
    expect(parseExemption('// just a regular comment')).toBeNull();
    expect(parseExemption('const x = 1;')).toBeNull();
  });

  it('returns MALFORMED for wrong ID format', () => {
    // Non-ERR-XXX identifier — refuse, do not silently honor.
    expect(parseExemption('// runtime-contract-exempt: FOO-999 reason here')).toBe('MALFORMED');
  });
});

describe('runtime-contract-diff — parseDiffHunks', () => {
  it('#5 historical (unmodified) lines are NOT collected', () => {
    // Issue acceptance criterion — only NEW lines appear in newLines.
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      'index 111..222 100644',
      '--- a/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -10,3 +10,3 @@',
      ' const context = 1;',
      '-const removed = parsed as string;', // pre-existing violation, now removed — must NOT appear
      '+const fresh = Object.hasOwn(parsed, "x");',
    ].join('\n');

    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe('pkg/foo.ts');
    expect(hunks[0].newLines).toHaveLength(1);
    expect(hunks[0].newLines[0].text).toContain('Object.hasOwn');
    // Hunk header `@@ -10,3 +10,3 @@`: new file starts at line 10; the
    // context line consumes line 10, so the added line is at line 11.
    expect(hunks[0].newLines[0].lineNo).toBe(11);
  });

  it('#6 NEW violation in new code IS collected', () => {
    // Issue acceptance criterion — incremental gate must surface new violations.
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '--- a/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' const existing = 1;',
      '+const x = parsed as string;',
    ].join('\n');

    const hunks = parseDiffHunks(diff);
    expect(hunks[0].newLines).toHaveLength(1);
    expect(hunks[0].newLines[0].text).toBe('const x = parsed as string;');
    expect(hunks[0].newLines[0].lineNo).toBe(2);
  });

  it('handles multiple files and multiple hunks', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '+const a = 1;',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5,1 +5,2 @@',
      ' const ctx = 5;',
      '+const b = 2;',
      '+const c = 3;',
    ].join('\n');

    const hunks = parseDiffHunks(diff);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].file).toBe('a.ts');
    expect(hunks[0].newLines[0].lineNo).toBe(1);
    expect(hunks[1].file).toBe('b.ts');
    expect(hunks[1].newLines.map((nl) => nl.lineNo)).toEqual([6, 7]);
  });

  it('skips deleted files (+++ /dev/null)', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,1 +0,0 @@',
      '-const x = 1;',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual([]);
  });

  it('skips binary files', () => {
    const diff = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');
    expect(parseDiffHunks(diff)).toEqual([]);
  });

  it('returns [] for empty / non-string input', () => {
    expect(parseDiffHunks('')).toEqual([]);
    expect(parseDiffHunks(undefined as unknown as string)).toEqual([]);
  });
});

describe('runtime-contract-diff — resolveBaseRef', () => {
  it('prefers origin/main when present', () => {
    const probe = (ref: string) => ref === 'origin/main';
    const r = resolveBaseRef(undefined, probe);
    expect(r.kind).toBe('origin/main');
    expect(r.ref).toBe('origin/main...HEAD');
    expect(r.note).toBeUndefined();
  });

  it('falls back to local main with an explanatory note', () => {
    const probe = (ref: string) => ref === 'main';
    const r = resolveBaseRef(undefined, probe);
    expect(r.kind).toBe('main');
    expect(r.note).toMatch(/origin\/main not present/);
  });

  it('falls back to HEAD~1 when no main exists', () => {
    const probe = (ref: string) => ref === 'HEAD~1';
    const r = resolveBaseRef(undefined, probe);
    expect(r.kind).toBe('HEAD~1');
    expect(r.note).toMatch(/HEAD~1/);
  });

  it('#12 returns kind "none" when all candidates fail', () => {
    // Issue acceptance criterion — base-ref failure degrades gracefully (Rule 9).
    const r = resolveBaseRef(undefined, () => false);
    expect(r.kind).toBe('none');
    expect(r.ref).toBe('');
    expect(r.note).toMatch(/no base ref available/);
  });
});

describe('runtime-contract-diff — buildTrustContext', () => {
  it('collects identifiers from JSON.parse / fs / fetch / DB calls', () => {
    const lines = [
      "const parsed = JSON.parse(raw);",
      "const { a, b } = JSON.parse(raw2);",
      "const data = fs.readFileSync(path, 'utf8');",
      "const rows = db.all(sql);",
      "const safe = computeStuff(input);", // NOT untrusted
      "const items = await fetch(url);",
    ];
    const ctx = buildTrustContext(lines);
    expect(ctx.untrustedVars.has('parsed')).toBe(true);
    expect(ctx.untrustedVars.has('a')).toBe(true);
    expect(ctx.untrustedVars.has('b')).toBe(true);
    expect(ctx.untrustedVars.has('data')).toBe(true);
    expect(ctx.untrustedVars.has('rows')).toBe(true);
    expect(ctx.untrustedVars.has('items')).toBe(true);
    expect(ctx.untrustedVars.has('safe')).toBe(false);
  });

  it('returns empty set for non-array input', () => {
    expect(buildTrustContext(undefined as unknown as string[]).untrustedVars.size).toBe(0);
  });
});

describe('check-runtime-contract — scan (end-to-end with injected diff)', () => {
  /**
   * Build a fake scan with a known diff and trust context, bypassing real git.
   */
  function scanWith(diff: string, fileLines: string[]) {
    const hunks: FileHunks[] = parseDiffHunks(diff);
    return scan({
      resolveBase: () => ({ ref: 'main...HEAD', kind: 'main' }) as ResolvedBase,
      getHunks: () => hunks,
      readLines: () => fileLines,
    });
  }

  it('reports a new ERR-001 violation with file, line, snippet, reason, nextAction', () => {
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '--- a/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,1 +1,2 @@',
      ' const existing = 1;',
      '+const x = parsed as string;',
    ].join('\n');
    // Trust context: parsed originates from JSON.parse (defined on line 5 of file).
    const fileLines = [
      'export function f() {',
      '  const raw = readSome();',
      '  const parsed = JSON.parse(raw);',
      '  // ...',
      '  const x = parsed as string;', // line 5 — the violation
      '}',
    ];

    const { findings, base } = scanWith(diff, fileLines);
    expect(base.kind).toBe('main');
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.ruleId).toBe('ERR-001');
    expect(f.file).toBe('pkg/foo.ts');
    expect(f.line).toBe(2);
    expect(f.snippet).toContain('parsed as string');
    expect(f.reason.length).toBeGreaterThan(10);
    expect(f.nextAction.length).toBeGreaterThan(5);
  });

  it('honors a same-line exemption and suppresses the finding', () => {
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,1 +1,1 @@',
      "+const x = parsed as string; // runtime-contract-exempt: ERR-001 legacy adapter bridge, tracked in PRI-999",
    ].join('\n');
    const { findings } = scanWith(diff, [
      'const parsed = JSON.parse(raw);',
      'const x = parsed as string;',
    ]);
    expect(findings).toHaveLength(0);
  });

  it('honors a previous-line exemption (eslint-disable-next-line semantics)', () => {
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+// runtime-contract-exempt: ERR-001 legacy adapter bridge, tracked in PRI-999',
      '+const x = parsed as string;',
    ].join('\n');
    const { findings } = scanWith(diff, [
      '// runtime-contract-exempt: ERR-001 legacy adapter bridge',
      'const parsed = JSON.parse(raw);',
      'const x = parsed as string;',
    ]);
    expect(findings).toHaveLength(0);
  });

  it('reports a MALFORMED exemption as its own finding', () => {
    // A missing reason would silently mask the violation — surface it instead.
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,1 +1,2 @@',
      '+const x = parsed as string; // runtime-contract-exempt: ERR-001',
    ].join('\n');
    const { findings } = scanWith(diff, [
      'const parsed = JSON.parse(raw);',
      'const x = parsed as string;',
    ]);
    // The ERR-001 violation is NOT exempted (reason missing) → still reported,
    // AND the malformed exemption is itself reported.
    const ids = findings.map((f) => f.ruleId).sort();
    expect(ids).toEqual(['ERR-001', 'ERR-EXEMPTION']);
  });

  it('returns no findings when base ref is unavailable (graceful degradation)', () => {
    // Issue #996 / Runtime Contract Rule 9 — fresh shallow clones have no main;
    // the scanner must NOT block.
    const { findings, base } = scan({
      resolveBase: () => ({ ref: '', kind: 'none', note: 'fresh clone' }) as ResolvedBase,
      getHunks: () => [],
      readLines: () => [],
    });
    expect(findings).toEqual([]);
    expect(base.kind).toBe('none');
  });

  it('does not flag historical violations that this PR did not touch', () => {
    // The classic PR #991 failure mode: pre-existing `as` casts in unchanged
    // lines must NOT generate noise.
    const diff = [
      'diff --git a/pkg/foo.ts b/pkg/foo.ts',
      '+++ b/pkg/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' const legacy = parsed as string;', // context line — pre-existing, NOT in newLines
      ' const ctx = 1;',
      '+const clean = Object.hasOwn(parsed, "x");',
    ].join('\n');
    const { findings } = scanWith(diff, [
      'const legacy = parsed as string;',
      'const ctx = 1;',
      'const clean = Object.hasOwn(parsed, "x");',
    ]);
    expect(findings).toHaveLength(0);
  });
});

describe('check-runtime-contract — escape hatch (P1-5)', () => {
  // An operator under release pressure will try conventional falsy spellings.
  // Only accepting the literal '0' is a usability defect.
  it.each([
    ['0', true],
    ['false', true],
    ['no', true],
    ['off', true],
    ['OFF', true], // case-insensitive
    ['  false  ', true], // whitespace-trimmed
    ['', true], // empty string = explicit "off"
  ])('isEscapeHatchSet(%j) → %s', (input, expected) => {
    expect(isEscapeHatchSet(input)).toBe(expected);
  });

  it.each([
    ['1', false],
    ['true', false],
    ['yes', false],
    [undefined, false], // unset — scanner runs normally
  ])('isEscapeHatchSet(%j) → %s (scanner stays active)', (input, expected) => {
    expect(isEscapeHatchSet(input)).toBe(expected);
  });
});
