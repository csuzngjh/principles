/**
 * pd pain recall CLI golden equivalence tests — SPEC-PD-AGENT-CAPABILITY-API-001
 * v0.5 §9.2 / READINESS §9.
 *
 * The golden fixtures (`tests/commands/__golden__/`) were generated with the
 * PRE-migration implementation (old service path) inside this PR, BEFORE the
 * old service file was deleted — see MANIFEST.json for the generation
 * record, the recorded argv, and the SHA-256 anchors. Payload artifacts are
 * stored under a `.fixture` suffix (no runtime DB/state name is ever
 * committed); tests/helpers/golden-replay.ts materializes them byte-identically
 * into a private temp workspace and replays the recorded command with the
 * BUILT CLI (real child process), demanding byte-exact stdout, identical exit
 * codes, and a byte-identical workspace afterwards. Stored bytes are
 * hash-verified against the manifest first, so a mutated fixture cannot
 * masquerade as equivalence, and the helper's literal command table is
 * cross-checked against each case file's recorded argv so it cannot drift.
 *
 * Never regenerate the golden outputs from the migrated implementation — that
 * would erase the equivalence anchor this file exists to prove.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { replayGoldenCase, goldenCommandFor, listGoldenCaseNames } from '../helpers/golden-replay.js';

const GOLDEN_ROOT = path.join(process.cwd(), 'tests', 'commands', '__golden__');

interface GoldenCase {
  name: string;
  argvRecorded: string[];
  exitCode: number;
  stdout: string;
}

interface GoldenManifest {
  schema: string;
  cases: Record<string, { workspace: string; argvRecorded: string[]; exitCode: number; stdoutSha256: string; caseFileSha256: string }>;
  workspaces: Record<string, Record<string, string>>;
}

function readManifest(): GoldenManifest {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(GOLDEN_ROOT, 'MANIFEST.json'), 'utf-8'));
  if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'cases') || !Object.hasOwn(raw, 'workspaces')) {
    throw new Error('golden MANIFEST.json is malformed');
  }
  return raw as GoldenManifest;
}

function listGoldenCases(): GoldenCase[] {
  const casesDir = path.join(GOLDEN_ROOT, 'cases');
  return fs.readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(casesDir, f), 'utf-8')) as GoldenCase)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

describe('pd pain recall: golden equivalence (pre-migration outputs, migrated CLI)', () => {
  const manifest = readManifest();
  const cases = listGoldenCases();

  it('golden corpus is intact: every case file and workspace byte-hash matches the manifest', () => {
    expect(Object.keys(manifest.cases).length).toBeGreaterThanOrEqual(6); // READINESS §9 coverage floor
    for (const [name, entry] of Object.entries(manifest.cases)) {
      const caseFile = path.join(GOLDEN_ROOT, 'cases', `${name}.json`);
      expect(sha256File(caseFile), `case file drifted: ${name}`).toBe(entry.caseFileSha256);
    }
    for (const [wsName, files] of Object.entries(manifest.workspaces)) {
      for (const [rel, expected] of Object.entries(files)) {
        const p = path.join(GOLDEN_ROOT, 'workspaces', wsName, ...rel.split('/'));
        expect(sha256File(p), `fixture drifted: ${wsName}/${rel}`).toBe(expected);
      }
    }
  });

  it('golden corpus covers the required scenario classes (ok/no-matches/partial/not-found/param-error/truncation)', () => {
    const names = Object.keys(manifest.cases);
    for (const required of ['ok', 'no-matches', 'partial', 'principle-not-found', 'param-error', 'truncation']) {
      expect(names.some((n) => n.includes(required)), `missing scenario class: ${required}`).toBe(true);
    }
  });

  it('the replay helper literal table matches every recorded argv in the corpus (no drift)', () => {
    expect(cases.length).toBe(listGoldenCaseNames().length);
    for (const golden of cases) {
      const command = goldenCommandFor(golden.name);
      expect(command.workspace, `${golden.name}: workspace`).toBe(manifest.cases[golden.name]!.workspace);
      expect([...golden.argvRecorded].slice(2), `${golden.name}: argv (after "pain recall")`).toEqual([...command.elements]);
    }
  });

  it.each(cases.map((golden) => [golden.name, golden] as const))(
    '%s: stdout byte-identical, exit code preserved, workspace untouched',
    { timeout: 60_000 },
    async (_name, golden) => {
      const entry = manifest.cases[golden.name];
      expect(entry, `manifest entry for ${golden.name}`).toBeDefined();
      const { stdout, exitCode, workspaceIntact } = await replayGoldenCase(golden.name);
      expect(workspaceIntact, `${golden.name}: replay mutated the materialized workspace`).toBe(true);

      if (stdout !== golden.stdout) {
        let i = 0;
        while (i < golden.stdout.length && i < stdout.length && golden.stdout[i] === stdout[i]) i++;
        expect.fail(
          `stdout diverged at byte ${i}:\n` +
          `  golden: ${JSON.stringify(golden.stdout.slice(Math.max(0, i - 60), i + 120))}\n` +
          `  actual: ${JSON.stringify(stdout.slice(Math.max(0, i - 60), i + 120))}`,
        );
      }
      expect(exitCode).toBe(golden.exitCode);
      expect(crypto.createHash('sha256').update(stdout, 'utf8').digest('hex')).toBe(entry!.stdoutSha256);
      if (golden.argvRecorded.includes('--json') && exitCode === 0) {
        // The CLI must keep emitting the RAW pd.pain-recall.v1 contract —
        // never the pd.capability.v1 envelope (Owner decision 2).
        expect(stdout.includes('pd.pain-recall.v1')).toBe(true);
        expect(stdout.includes('pd.capability.v1')).toBe(false);
      }
    },
  );

  it('replaying the whole corpus again leaves every materialized workspace byte-identical (strict read-only)', { timeout: 120_000 }, async () => {
    for (const golden of cases) {
      const { workspaceIntact } = await replayGoldenCase(golden.name);
      expect(workspaceIntact, `${golden.name}: second replay mutated the workspace`).toBe(true);
    }
    // The stored corpus itself is never touched by replays (materialization
    // copies into temp) — the corpus-integrity test above re-proves this on
    // the next run; here the per-case workspaceIntact verdicts above carry
    // the read-only proof for this run.
    expect(true).toBe(true);
  });
});
