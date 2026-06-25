import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IntentPageModel } from '../../src/server/models/IntentPageModel.js';

let workspaceDir: string;
let principlesDir: string;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-intent-model-'));
  principlesDir = path.join(workspaceDir, '.principles');
  fs.mkdirSync(principlesDir, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(workspaceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeIntent(content: string): void {
  fs.writeFileSync(path.join(principlesDir, 'INTENT.md'), content, 'utf8');
}

const VALID_INTENT = `# INTENT.md

## 1. Why

This project validates pain from repeatedly correcting Agents.

## 2. Desired Outcome

A new user understands PD within five minutes.

## 3. Non-negotiables

- Do not make PD a heavy Agent platform.
- Do not increase Owner attention burden.

## 4. Stop / Escalation

If a change expands PD into orchestration, stop and ask Owner.

## 5. Current Strategic Focus

Validate the smallest loop: Pain to Principle to Delta.
`;

describe('IntentPageModel — flag-off short-circuit', () => {
  it('returns flag_disabled without filesystem access', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(false);
    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.warnings).toEqual([]);
  });

  it('does not read INTENT.md when flag is off', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.found).toBe(false);
  });
});

describe('IntentPageModel — flag-on, file missing', () => {
  it('returns not_found when INTENT.md does not exist', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.nextAction).toBeDefined();
  });
});

describe('IntentPageModel — flag-on, file oversized', () => {
  it('returns oversized for file > 32KB', async () => {
    const big = '# INTENT.md\n\n## 1. Why\n\n' + 'x'.repeat(33 * 1024) + '\n';
    writeIntent(big);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.ok).toBe(false);
    expect(result.found).toBe(true);
    expect(result.reason).toBe('oversized');
  });
});

describe('IntentPageModel — flag-on, valid file', () => {
  it('parses sections and returns hash/mtime', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.path).toContain('INTENT.md');
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(result.lastEditedAt).toBeDefined();
    expect(result.sections).toBeDefined();
    expect(result.sections!.why).toContain('correcting Agents');
    expect(result.warnings).toEqual([]);
  });

  it('returns empty warnings for valid INTENT.md', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.warnings).toEqual([]);
  });
});

describe('IntentPageModel — missing sections', () => {
  it('emits missing_section warnings for partial INTENT.md', async () => {
    writeIntent(`# INTENT.md\n\n## 1. Why\n\nJust the why section.\n`);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(4);
    expect(result.warnings.every(w => w.code === 'missing_section')).toBe(true);
  });
});

describe('IntentPageModel — never-throws contract', () => {
  it('does not throw when workspaceDir does not exist', async () => {
    const model = new IntentPageModel('Z:/nonexistent/path/that/does/not/exist');
    const result = await model.getSummary(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('does not throw when .principles is a file instead of a directory', async () => {
    fs.rmSync(principlesDir, { recursive: true, force: true });
    fs.writeFileSync(principlesDir, 'not a directory');
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });
});