import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

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

    // Run the actual built CLI command
    const cliBin = path.resolve(process.cwd(), 'packages/pd-cli/dist/index.js');
    const cmd = `node "${cliBin}" pain record --reason "Regression test frustration" --json --workspace "${tmpDir}"`;
    
    let stdoutStr: string;
    try {
      stdoutStr = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
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
    expect(parsed.reason).toBeDefined();
    expect(parsed.nextAction).toBeDefined();

    // Verify nextAction structure
    expect(parsed.nextAction).toContain('pd diagnose run');
    expect(parsed.nextAction).toContain('--task-id');
    expect(parsed.nextAction).toContain('--runtime pi-ai');
    expect(parsed.nextAction).toContain('--json');
  });
});
