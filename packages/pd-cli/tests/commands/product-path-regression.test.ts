import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Real CLI JSON product-path regression test (PRI-376)', () => {
  it('outputs exactly one parseable JSON object on async pain record', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-regression-'));
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });

    // Write a config to enable async mode
    const configContent = `
version: 1
features:
  diagnostician_async_cli:
    category: quiet
    enabled: true
runtimeProfiles:
  openclaw.default:
    type: openclaw
    source: default
internalAgents:
  defaultRuntime: openclaw.default
  agents:
    diagnostician:
      enabled: true
      runtimeProfile: openclaw.default
ui:
  diagnostics:
    mode: simple
`;
    fs.writeFileSync(path.join(pdDir, 'config.yaml'), configContent.trim(), 'utf8');

    // Resolve CLI binary path relative to this file to be workspace-independent
    const cliBin = path.resolve(__dirname, '../../dist/index.js');
    // Parameterized exec (no shell): tmpDir and reason are passed as separate
    // argv entries, so shell metacharacters in them cannot be interpreted as
    // commands (CWE-78 mitigation).
    let stdoutStr: string;
    try {
      stdoutStr = execFileSync(
        process.execPath,
        [cliBin, 'pain', 'record', '--reason', 'Regression test frustration', '--json', '--workspace', tmpDir],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // Ensure output is non-empty
    expect(stdoutStr.trim()).not.toBe('');

    // Ensure it's exactly one parseable JSON object
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdoutStr.trim()) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Stdout was not a single parseable JSON object:\n${stdoutStr}`, {
        cause: err,
      });
    }

    // Ensure required fields
    expect(parsed).toBeDefined();
    expect(parsed.status).toBe('submitted');
    expect(parsed.taskId).toMatch(/^diagnosis_/);
    expect(parsed.message).toBeDefined();
    expect(parsed.reason).toBeTypeOf('string');
    expect(parsed.nextAction).toBeTypeOf('string');

    // Verify nextAction structure: pd diagnose run --task-id ... --runtime pi-ai --json
    const nextAction = parsed.nextAction as string;
    expect(nextAction).toContain('pd diagnose run');
    expect(nextAction).toContain(`--task-id ${parsed.taskId}`);
    expect(nextAction).toContain('--runtime pi-ai');
    expect(nextAction).toContain('--json');
  }, 20000);
});

