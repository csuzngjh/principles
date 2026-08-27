import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// Real-command JSON contract test for the Node-version gate (cli-1): spawn
// the production CLI entry with a PATH whose `node` reports an unsupported
// version, then require stdout to be exactly one parseable JSON object with
// the stable reason code, the detected version, and no install side effects.

const INSTALLER_DIR = path.resolve(__dirname, '..');
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pd-node-gate-'));

// Boundary guard: every path this file reads, writes, or passes to a child
// process must resolve inside one of the two declared roots.
function assertWithinRoot(candidate: string, rootDirectory: string): string {
  const resolved = path.resolve(candidate);
  if (resolved !== rootDirectory && !resolved.startsWith(rootDirectory + path.sep)) {
    throw new Error(`Path escapes the allowed root ${rootDirectory}: ${resolved}`);
  }
  return resolved;
}

const CLI_ENTRY = assertWithinRoot(path.join(INSTALLER_DIR, 'dist', 'index.js'), INSTALLER_DIR);
const fakeBinDir = assertWithinRoot(path.join(root, 'bin'), root);
const workspaceDir = assertWithinRoot(path.join(root, 'workspace'), root);
const homeDir = assertWithinRoot(path.join(root, 'home'), root);
const unsupportedNodeVersion = 'v20.19.0';

fs.mkdirSync(fakeBinDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });
fs.mkdirSync(homeDir, { recursive: true });
const fakeNode = assertWithinRoot(path.join(fakeBinDir, process.platform === 'win32' ? 'node.cmd' : 'node'), root);
fs.writeFileSync(fakeNode, process.platform === 'win32'
  ? `@echo off\r\necho ${unsupportedNodeVersion}\r\n`
  : `#!/bin/sh\necho ${unsupportedNodeVersion}\n`);
if (process.platform !== 'win32') {
  fs.chmodSync(fakeNode, 0o755);
}

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('install CLI Node-version gate (real --json subprocess, cli-1/cli-2/cli-5)', () => {
  it('reports node_version_unsupported as one JSON object with no side effects', async () => {
    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(`CLI build output is missing: ${CLI_ENTRY}. Run "npm run build" before this test.`);
    }
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const workspaceBefore = fs.readdirSync(workspaceDir);
    const error: unknown = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, '--lang', 'en', '--json', '--yes', '--workspace', workspaceDir],
      {
        env: {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
        },
        timeout: 120_000,
      },
    ).then(() => undefined, (failure: unknown) => failure);

    expect(error).toBeDefined();
    if (typeof error !== 'object' || error === null) throw new Error('expected a failed child process result');
    const exitCode: unknown = Reflect.get(error, 'code');
    const stdoutValue: unknown = Reflect.get(error, 'stdout');
    expect(exitCode).toBe(1);
    if (typeof stdoutValue !== 'string') throw new Error('expected stdout from the failed CLI run');

    const trimmed = stdoutValue.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    const parsed: unknown = JSON.parse(trimmed);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
    const record = parsed as Record<string, unknown>;
    expect(record['reason']).toBe('node_version_unsupported');
    expect(record['detectedVersion']).toBe(unsupportedNodeVersion);
    const nextAction: unknown = record['nextAction'];
    expect(typeof nextAction).toBe('string');
    expect(nextAction).toMatch(/Node\.js >= 22/);

    // cli-5: a refused install must not mutate the workspace.
    expect(fs.readdirSync(workspaceDir)).toEqual(workspaceBefore);
  }, 180_000);
});
