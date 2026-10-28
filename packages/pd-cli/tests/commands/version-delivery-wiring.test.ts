/**
 * cli-7 test-wiring: prove the real `registerVersionCommand` (used by the CLI
 * entrypoint) parses `--delivery`, reaches the delivery builder, emits one
 * JSON object (cli-1), and turns an incomplete delivery into a non-zero exit.
 *
 * Judgement coverage lives in src/services/__tests__/delivery-surfaces.test.ts;
 * this file only proves the production command wiring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerVersionCommand } from '../../src/commands/version.js';

const temporaryDirectories: string[] = [];
const ORIGINAL_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
const originalExitCode = process.exitCode;

function tempHome(): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-version-delivery-'));
  temporaryDirectories.push(root);
  return root;
}

function writePackageVersion(filePath: string, version: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ name: '@principles/fixture', version }));
}

const RELEASE_ID = 'b'.repeat(64);
const RELEASE_DIGEST = '2'.repeat(64);

/** Minimal canonical install: active.json + release metadata + live runtime manifests. */
function writeCanonicalHome(home: string): void {
  const pdHome = path.join(home, '.pd');
  fs.mkdirSync(pdHome, { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'active.json'), JSON.stringify({
    schemaVersion: 1,
    generation: 53,
    releaseId: RELEASE_ID,
    releaseMetadataDigest: RELEASE_DIGEST,
    transactionId: 'update-fixture',
    productVersion: '2.3.14',
  }));
  // Without this the canonical install is `health: 'degraded'` (release record
  // unreadable) and a "complete" delivery verdict would be a lie.
  fs.mkdirSync(path.join(pdHome, 'releases', RELEASE_ID), { recursive: true });
  fs.writeFileSync(path.join(pdHome, 'releases', RELEASE_ID, 'metadata.json'), JSON.stringify({
    productVersion: '2.3.14',
    releaseId: RELEASE_ID,
    metadataDigest: RELEASE_DIGEST,
  }));
  for (const [component, version] of Object.entries({ core: '1.297.2', plugin: '2.2.4', 'pd-cli': '1.160.1' })) {
    writePackageVersion(path.join(pdHome, 'runtime', component, 'package.json'), version);
  }
}

function useFixtureHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = path.join(home, '.codex');
}

/** ERR-001: no `as` casts on unparsed JSON — validate shape, read via Reflect.get. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function requireRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}

function buildProgram(): Command {
  const program = new Command();
  registerVersionCommand(program);
  return program;
}

/** `mockRestore()` also clears recorded calls, so the capture happens here. */
async function runAndCapture(args: string[]): Promise<{ logCalls: number; firstLine: unknown }> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await buildProgram().parseAsync(args);
    return { logCalls: logSpy.mock.calls.length, firstLine: logSpy.mock.calls[0]?.[0] };
  } finally {
    logSpy.mockRestore();
  }
}

describe('cli-7: pd version --delivery wiring (production registration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = originalExitCode;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('emits one JSON object carrying the four-surface delivery verdict', async () => {
    const home = tempHome();
    writeCanonicalHome(home);
    useFixtureHome(home);
    const { logCalls, firstLine } = await runAndCapture(['node', 'pd', 'version', '--delivery', '--json']);
    expect(logCalls).toBe(1);
    const payload = requireRecord(JSON.parse(String(firstLine)), 'version --delivery --json');
    expect(payload).toMatchObject({ productVersion: '2.3.14' });
    const delivery = requireRecord(payload.delivery, 'delivery');
    expect(delivery).toMatchObject({ ok: true });
    expect(requireRecords(delivery.surfaces, 'delivery.surfaces')).toHaveLength(4);
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('exits non-zero when a required surface is stale', async () => {
    const home = tempHome();
    writeCanonicalHome(home);
    // OpenClaw is installed but its extension shell lags the canonical runtime.
    writePackageVersion(path.join(home, '.openclaw', 'extensions', 'principles-disciple', 'package.json'), '2.2.3');
    useFixtureHome(home);
    const { firstLine } = await runAndCapture(['node', 'pd', 'version', '--delivery', '--json']);
    const payload = requireRecord(JSON.parse(String(firstLine)), 'version --delivery --json');
    const delivery = requireRecord(payload.delivery, 'delivery');
    expect(delivery).toMatchObject({ ok: false });
    const openclaw = requireRecords(delivery.surfaces, 'delivery.surfaces')
      .find((surface) => surface.id === 'openclaw-extension');
    expect(openclaw).toMatchObject({ status: 'stale', reason: 'extension_version_mismatch' });
    expect(process.exitCode).toBe(1);
  });

  it('keeps the default output unchanged (no delivery section without the flag)', async () => {
    const home = tempHome();
    writeCanonicalHome(home);
    useFixtureHome(home);
    const { logCalls, firstLine } = await runAndCapture(['node', 'pd', 'version', '--json']);
    expect(logCalls).toBe(1);
    const payload = requireRecord(JSON.parse(String(firstLine)), 'version --json');
    expect(Object.hasOwn(payload, 'delivery')).toBe(false);
    expect(process.exitCode).toBe(originalExitCode);
  });
});
