import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IntentPageModel } from '../../src/server/models/IntentPageModel.js';

// Cross-platform path that genuinely cannot be created:
// - Linux: /dev/null is a char device, mkdir under it fails with ENOTDIR
// - Windows: Z: drive typically doesn't exist, fails with ENOENT
// Using a Windows-style "Z:" path on Linux is treated as a relative path and
// CAN be created by mkdir({ recursive: true }), causing tests to falsely pass.
const INVALID_PATH = process.platform === 'win32'
  ? 'Z:/nonexistent/path/that/does/not/exist'
  : '/dev/null/cannot-create-subdir-here';

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
  fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), content, 'utf8');
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
    const result = await model.getSummary(false, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.warnings).toEqual([]);
  });

  it('does not read INTENT.md when flag is off', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(false, 'zh-CN');
    expect(result.reason).toBe('flag_disabled');
    expect(result.found).toBe(false);
  });
});

describe('IntentPageModel — flag-on, file missing', () => {
  it('returns not_found when INTENT.md does not exist', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
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
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.found).toBe(true);
    expect(result.reason).toBe('oversized');
  });
});

describe('IntentPageModel — flag-on, valid file', () => {
  it('parses sections and returns hash/mtime', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.found).toBe(true);
    expect(result.flagEnabled).toBe(true);
    expect(result.path).toContain('INTENT.zh-CN.md');
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(result.lastEditedAt).toBeDefined();
    expect(result.sections).toBeDefined();
    expect(result.sections!.why).toContain('correcting Agents');
    expect(result.warnings).toEqual([]);
  });

  it('returns empty warnings for valid INTENT.md', async () => {
    writeIntent(VALID_INTENT);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.warnings).toEqual([]);
  });
});

describe('IntentPageModel — missing sections', () => {
  it('emits missing_section warnings for partial INTENT.md', async () => {
    writeIntent(`# INTENT.md\n\n## 1. Why\n\nJust the why section.\n`);
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.warnings.length).toBe(4);
    expect(result.warnings.every(w => w.code === 'missing_section')).toBe(true);
  });
});

describe('IntentPageModel — never-throws contract', () => {
  it('does not throw when workspaceDir does not exist', async () => {
    const model = new IntentPageModel(INVALID_PATH);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('does not throw when .principles is a file instead of a directory', async () => {
    fs.rmSync(principlesDir, { recursive: true, force: true });
    fs.writeFileSync(principlesDir, 'not a directory');
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('returns read_error when INTENT.md is a directory (readFileSync throws EISDIR)', async () => {
    // Create a directory at the INTENT.md path: existsSync returns true,
    // statSync succeeds (small size), but readFileSync throws EISDIR.
    // This triggers the catch block in getSummary().
    fs.mkdirSync(path.join(principlesDir, 'INTENT.zh-CN.md'), { recursive: true });
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getSummary(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.found).toBe(false);
    expect(result.flagEnabled).toBe(true);
    expect(result.reason).toBe('read_error');
    expect(result.nextAction).toBeDefined();
  });
});

// ── createTemplate (PRI-477) ─────────────────────────────────────────────────

describe('IntentPageModel — createTemplate', () => {
  it('creates INTENT.md from template when file does not exist', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.createTemplate(true, false, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    expect(result.path).toContain('INTENT.zh-CN.md');

    // Verify file exists and contains template content
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).toContain('## 1. Why');
  });

  it('returns already_exists without overwriting when file exists and force=false', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'existing content', 'utf8');

    const model = new IntentPageModel(workspaceDir);
    const result = await model.createTemplate(true, false, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('already_exists');
    expect(result.nextAction).toBeDefined();

    // File was NOT overwritten
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('existing content');
  });

  it('overwrites existing file when force=true', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'old content', 'utf8');

    const model = new IntentPageModel(workspaceDir);
    const result = await model.createTemplate(true, true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);

    // File WAS overwritten with template
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toContain('# INTENT.md');
    expect(content).not.toContain('old content');
  });

  it('creates .principles directory if it does not exist', async () => {
    // Remove the .principles directory
    fs.rmSync(principlesDir, { recursive: true, force: true });
    expect(fs.existsSync(principlesDir)).toBe(false);

    const model = new IntentPageModel(workspaceDir);
    const result = await model.createTemplate(true, false, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);

    // Directory and file should now exist
    expect(fs.existsSync(principlesDir)).toBe(true);
    expect(fs.existsSync(path.join(principlesDir, 'INTENT.zh-CN.md'))).toBe(true);
  });

  it('returns flag_disabled when flag is off', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.createTemplate(false, false, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.nextAction).toBeDefined();
  });

  it('returns write_error when workspaceDir does not exist', async () => {
    const model = new IntentPageModel(INVALID_PATH);
    const result = await model.createTemplate(true, false, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.created).toBe(false);
    expect(result.reason).toBe('write_error');
  });
});

// ── getRawContent (PRI-477) ──────────────────────────────────────────────────

describe('IntentPageModel — getRawContent', () => {
  it('returns raw content when file exists', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), '# My Intent\n\ntest', 'utf8');

    const model = new IntentPageModel(workspaceDir);
    const result = await model.getRawContent(true, 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.content).toBe('# My Intent\n\ntest');
    expect(result.path).toContain('INTENT.zh-CN.md');
  });

  it('returns not_found when file does not exist', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getRawContent(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.nextAction).toBeDefined();
  });

  it('returns oversized when file > 32KB (stat-first guard)', async () => {
    const big = '# INTENT.md\n\n## 1. Why\n\n' + 'x'.repeat(33 * 1024) + '\n';
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), big, 'utf8');

    const model = new IntentPageModel(workspaceDir);
    const result = await model.getRawContent(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('oversized');
    expect(result.nextAction).toContain('32768');
  });

  it('returns flag_disabled when flag is off', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.getRawContent(false, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.nextAction).toBeDefined();
  });

  it('returns not_found when workspaceDir does not exist (existsSync=false)', async () => {
    // When the workspace directory doesn't exist, existsSync(filePath) returns
    // false, so the model returns not_found (not read_error). This is correct:
    // the file genuinely doesn't exist.
    const model = new IntentPageModel(INVALID_PATH);
    const result = await model.getRawContent(true, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
    expect(result.nextAction).toBeDefined();
  });
});

// ── saveContent (PRI-477) ────────────────────────────────────────────────────

describe('IntentPageModel — saveContent', () => {
  it('saves valid content and returns updated metadata', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, '# INTENT.md\n\nnew content', 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.saved).toBe(true);
    expect(result.path).toContain('INTENT.zh-CN.md');
    expect(result.contentHash).toMatch(/^sha256:/);
    expect(result.lastEditedAt).toBeDefined();

    // Verify file was written
    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('# INTENT.md\n\nnew content');
  });

  it('overwrites existing file', async () => {
    fs.writeFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'old content', 'utf8');

    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, 'new content', 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.saved).toBe(true);

    const content = fs.readFileSync(path.join(principlesDir, 'INTENT.zh-CN.md'), 'utf8');
    expect(content).toBe('new content');
  });

  it('creates .principles directory if it does not exist', async () => {
    fs.rmSync(principlesDir, { recursive: true, force: true });

    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, 'content', 'zh-CN');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(principlesDir)).toBe(true);
    expect(fs.existsSync(path.join(principlesDir, 'INTENT.zh-CN.md'))).toBe(true);
  });

  it('returns invalid_content when content is not a string', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, 123, 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('invalid_content');
  });

  it('returns empty_content when content is empty string', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, '', 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('empty_content');
  });

  it('returns oversized when content > 32KB', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, 'x'.repeat(33 * 1024), 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('oversized');
    expect(result.nextAction).toContain('32768');
  });

  it('returns flag_disabled when flag is off', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(false, 'content', 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('flag_disabled');
    expect(result.nextAction).toBeDefined();
  });

  it('returns write_error when workspaceDir does not exist', async () => {
    const model = new IntentPageModel(INVALID_PATH);
    const result = await model.saveContent(true, 'content', 'zh-CN');
    expect(result.ok).toBe(false);
    expect(result.saved).toBe(false);
    expect(result.reason).toBe('write_error');
  });

  it('returns warnings for content with missing sections', async () => {
    const model = new IntentPageModel(workspaceDir);
    const result = await model.saveContent(true, '# INTENT.md\n\n## 1. Why\n\nOnly why section.\n', 'zh-CN');
    expect(result.ok).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings!.every(w => w.code === 'missing_section')).toBe(true);
  });
});