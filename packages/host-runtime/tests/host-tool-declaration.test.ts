
/**
 * Host Tool Declaration Store tests — PRI-634-F R3 (SPEC P1-2)
 *
 * Per-host file layout: OpenClaw and Codex persist SEPARATE declaration
 * files so a shared workspace never hits last-writer-wins. Order
 * independence is a hard acceptance criterion (SPEC Test 2/3).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  saveHostToolDeclaration,
  loadHostToolDeclarations,
  HOST_TOOL_DECLARATION_DIRNAME,
  HOST_TOOL_DECLARATION_VERSION,
} from '../src/host-tool-declaration.js';

let ws: string;

beforeEach(() => {
  ws = mkdtempSync(path.join(tmpdir(), 'pd-decl-'));
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const OPENCLAW = {
  version: 1 as const,
  hostKind: 'openclaw',
  mappings: [
    { rawToolName: 'shell', canonicalKind: 'execute' as const },
    { rawToolName: 'write_file', canonicalKind: 'write' as const },
  ],
  declaredAt: '2026-09-04T00:00:00.000Z',
};

const CODEX = {
  version: 1 as const,
  hostKind: 'codex',
  mappings: [
    { rawToolName: 'Bash', canonicalKind: 'execute' as const },
    { rawToolName: 'apply_patch', canonicalKind: 'write' as const },
  ],
  declaredAt: '2026-09-04T00:00:00.000Z',
};

describe('saveHostToolDeclaration / loadHostToolDeclarations (per-host partition)', () => {
  it('round-trips one host declaration into <ws>/.pd/host-tool-semantics/<hostKind>.json', () => {
    expect(saveHostToolDeclaration(ws, OPENCLAW).ok).toBe(true);
    expect(existsSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'openclaw.json'))).toBe(true);

    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.declarations).toHaveLength(1);
    expect(loaded.declarations[0]?.hostKind).toBe('openclaw');
    expect(loaded.declarations[0]?.mappings).toHaveLength(2);
  });

  it('SPEC Test 2 (multi-host isolation) + Test 3 (order independence): both declarations survive either startup order', () => {
    // Order 1: openclaw then codex
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const afterOpenclawFirst = loadHostToolDeclarations(ws);
    rmSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true, force: true });

    // Order 2: codex then openclaw
    saveHostToolDeclaration(ws, CODEX);
    saveHostToolDeclaration(ws, OPENCLAW);
    const afterCodexFirst = loadHostToolDeclarations(ws);

    expect(afterOpenclawFirst.ok).toBe(true);
    expect(afterCodexFirst.ok).toBe(true);
    if (!afterOpenclawFirst.ok || !afterCodexFirst.ok) return;
    const kinds = (r: typeof afterOpenclawFirst & { ok: true }) =>
      r.declarations.map((d) => d.hostKind).sort();
    expect(kinds(afterOpenclawFirst)).toEqual(['codex', 'openclaw']);
    expect(kinds(afterCodexFirst)).toEqual(['codex', 'openclaw']);
    // Identical per-host mappings regardless of order
    const byHost = (r: typeof afterOpenclawFirst & { ok: true }) =>
      Object.fromEntries(r.declarations.map((d) => [d.hostKind, d.mappings]));
    expect(byHost(afterOpenclawFirst)).toEqual(byHost(afterCodexFirst));
  });

  it('same host re-declaring replaces only ITS file (isolation, no cross-host clobber)', () => {
    saveHostToolDeclaration(ws, OPENCLAW);
    saveHostToolDeclaration(ws, CODEX);
    const refreshed = { ...OPENCLAW, declaredAt: '2026-09-04T12:00:00.000Z' };
    saveHostToolDeclaration(ws, refreshed);

    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.declarations.map((d) => d.hostKind).sort()).toEqual(['codex', 'openclaw']);
    expect(loaded.declarations.find((d) => d.hostKind === 'openclaw')?.declaredAt).toBe('2026-09-04T12:00:00.000Z');
    expect(loaded.declarations.find((d) => d.hostKind === 'codex')?.declaredAt).toBe('2026-09-04T00:00:00.000Z');
  });

  it('missing declarations → typed host_tool_declaration_missing with nextAction (rc-9)', () => {
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_missing');
    expect(loaded.nextAction).toContain('host');
  });

  it('malformed JSON → host_tool_declaration_invalid naming the hostKind (untrusted input, fail loud)', () => {
    mkdirSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true });
    writeFileSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'codex.json'), '{oops', 'utf8');
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('host_tool_declaration_invalid (codex: not valid JSON)');
  });

  it('invalid mappings (bad canonicalKind) → host_tool_declaration_invalid naming the hostKind', () => {
    mkdirSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true });
    writeFileSync(
      path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'codex.json'),
      JSON.stringify({ version: 1, hostKind: 'codex', mappings: [{ rawToolName: 'a', canonicalKind: 'cron' }], declaredAt: 't' }),
      'utf8',
    );
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toContain('codex');
    expect(loaded.reason).toContain('mappings invalid');
  });

  it('hostKind must match the filename-safe pattern (rc: it doubles as a path segment)', () => {
    const bad = saveHostToolDeclaration(ws, { ...OPENCLAW, hostKind: '../evil' });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('hostKind');
  });
})

/**
 * ADR-0030 Owner safety premise: bumping the declaration contract to v2 MUST
 * NOT break a workspace that still holds a v1 file. A legacy file is read with
 * v1 semantics (`writePayloadFormat` unset) and produces a locatable warning —
 * it never blocks host loading. Genuinely corrupt declarations still fail loud.
 */
describe('ADR-0030 — v1 declaration read by the v2 loader', () => {
  const V1_FILE = {
    version: 1,
    hostKind: 'codex',
    mappings: [
      { rawToolName: 'Bash', canonicalKind: 'execute' },
      { rawToolName: 'apply_patch', canonicalKind: 'write' },
    ],
    declaredAt: '2026-09-04T00:00:00.000Z',
  };

  function writeDeclaration(hostKind: string, payload: unknown): void {
    const dir = path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${hostKind}.json`), JSON.stringify(payload), 'utf8');
  }

  it('Evidence 1: v2 loader reads a v1 file without throwing, degrades to default semantics, and warns', () => {
    expect(HOST_TOOL_DECLARATION_VERSION).toBe(2);
    writeDeclaration('codex', V1_FILE);

    let loaded: ReturnType<typeof loadHostToolDeclarations> | undefined;
    expect(() => {
      loaded = loadHostToolDeclarations(ws);
    }).not.toThrow();
    if (loaded === undefined) throw new Error('loader threw instead of returning a typed result');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Default semantics: exactly the v1 mappings, no writePayloadFormat.
    expect(loaded.declarations).toHaveLength(1);
    expect(loaded.declarations[0]?.version).toBe(1);
    expect(loaded.declarations[0]?.mappings).toEqual(V1_FILE.mappings);
    expect(loaded.declarations[0]?.mappings.every((m) => m.writePayloadFormat === undefined)).toBe(true);

    // The degradation is observable and locatable: which host, which version,
    // what was defaulted, and how to refresh.
    expect(loaded.warnings).toHaveLength(1);
    const warning = loaded.warnings[0] ?? '';
    expect(warning).toContain('host_tool_declaration_version_legacy');
    expect(warning).toContain('codex');
    expect(warning).toContain('declared version 1');
    expect(warning).toContain('supported 2');
    expect(warning).toContain('writePayloadFormat is treated as unset');
    expect(warning).toContain('.pd/host-tool-semantics/codex.json');
  });

  it('Evidence 2: v1 file and an equivalent v2 file (same mappings, no format) resolve to identical semantics', () => {
    const semantics = (declarations: readonly { hostKind: string; mappings: readonly { rawToolName: string; canonicalKind: string; writePayloadFormat?: string }[] }[]) =>
      declarations.map((d) => ({
        hostKind: d.hostKind,
        mappings: d.mappings
          .map((m) => `${m.rawToolName}=${m.canonicalKind}:${m.writePayloadFormat ?? 'unset'}`)
          .sort(),
      }));

    writeDeclaration('codex', V1_FILE);
    const fromV1 = loadHostToolDeclarations(ws);
    if (!fromV1.ok) throw new Error(`v1 load failed: ${fromV1.reason}`);

    // The v1 loader never knew the field: its semantics are the same mappings
    // projected without writePayloadFormat, i.e. exactly what the v2 loader
    // produced above. Byte-equality is not the contract; semantics are.
    const v1SemanticBaseline = semantics([{
      hostKind: V1_FILE.hostKind,
      mappings: V1_FILE.mappings,
    }]);
    expect(semantics(fromV1.declarations)).toEqual(v1SemanticBaseline);
    expect(fromV1.warnings).toHaveLength(1);

    // Same file re-persisted by a v2 host (still no format) is the control.
    writeDeclaration('codex', { ...V1_FILE, version: 2 });
    const fromV2 = loadHostToolDeclarations(ws);
    if (!fromV2.ok) throw new Error(`v2 load failed: ${fromV2.reason}`);
    expect(semantics(fromV2.declarations)).toEqual(semantics(fromV1.declarations));
    // Only the diagnostic differs — that is the whole point of the degrade.
    expect(fromV2.warnings).toEqual([]);
  });

  it('Evidence 3: genuinely corrupt declarations still fail loud (degrade is not a blanket pass)', () => {
    const cases: { label: string; payload: string; expected: string }[] = [
      { label: 'malformed JSON', payload: '{oops', expected: 'not valid JSON' },
      {
        label: 'missing version',
        payload: JSON.stringify({ ...V1_FILE, version: undefined }),
        expected: 'version must be a positive integer',
      },
      {
        label: 'non-integer version',
        payload: JSON.stringify({ ...V1_FILE, version: 1.5 }),
        expected: 'version must be a positive integer',
      },
      {
        label: 'newer-than-supported version',
        payload: JSON.stringify({ ...V1_FILE, version: 3 }),
        expected: 'newer than supported version 2',
      },
      {
        label: 'legacy file with a corrupt mapping',
        payload: JSON.stringify({ ...V1_FILE, mappings: [{ rawToolName: 'a', canonicalKind: 'cron' }] }),
        expected: 'mappings invalid',
      },
      {
        label: 'v2 file with writePayloadFormat on a non-write tool',
        payload: JSON.stringify({
          ...V1_FILE,
          version: 2,
          mappings: [{ rawToolName: 'Bash', canonicalKind: 'execute', writePayloadFormat: 'file-header-patch' }],
        }),
        expected: "only valid for canonicalKind 'write'",
      },
      {
        label: 'v2 file with an unknown writePayloadFormat',
        payload: JSON.stringify({
          ...V1_FILE,
          version: 2,
          mappings: [{ rawToolName: 'apply_patch', canonicalKind: 'write', writePayloadFormat: 'xml' }],
        }),
        expected: 'writePayloadFormat must be one of',
      },
      {
        label: 'missing declaredAt',
        payload: JSON.stringify({ version: 1, hostKind: 'codex', mappings: V1_FILE.mappings }),
        expected: 'declaredAt must be a non-empty string',
      },
    ];

    for (const testCase of cases) {
      rmSync(path.join(ws, '.pd'), { recursive: true, force: true });
      mkdirSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME), { recursive: true });
      writeFileSync(path.join(ws, '.pd', HOST_TOOL_DECLARATION_DIRNAME, 'codex.json'), testCase.payload, 'utf8');
      const loaded = loadHostToolDeclarations(ws);
      expect(loaded.ok, `${testCase.label} must fail loud`).toBe(false);
      if (loaded.ok) continue;
      expect(loaded.reason).toContain('host_tool_declaration_invalid (codex:');
      expect(loaded.reason, testCase.label).toContain(testCase.expected);
    }
  });

  it('a v2 declaration round-trips writePayloadFormat and produces no warning', () => {
    const v2 = {
      version: 2 as const,
      hostKind: 'codex',
      mappings: [
        { rawToolName: 'Bash', canonicalKind: 'execute' as const },
        { rawToolName: 'apply_patch', canonicalKind: 'write' as const, writePayloadFormat: 'file-header-patch' as const },
      ],
      declaredAt: '2026-11-11T00:00:00.000Z',
    };
    expect(saveHostToolDeclaration(ws, v2).ok).toBe(true);
    const loaded = loadHostToolDeclarations(ws);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.warnings).toEqual([]);
    expect(loaded.declarations[0]?.version).toBe(2);
    expect(loaded.declarations[0]?.mappings.find((m) => m.rawToolName === 'apply_patch')?.writePayloadFormat)
      .toBe('file-header-patch');
  });
});
