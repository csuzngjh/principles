import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadWorkspaceFeatureFlags,
  buildFeedbackChannelFlags,
} from '../../../src/server/config/feature-flags.js';

let workspaceDir: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ff-test-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadWorkspaceFeatureFlags
// ---------------------------------------------------------------------------

describe('loadWorkspaceFeatureFlags', () => {
  it('returns defaults when no config file exists', () => {
    const result = loadWorkspaceFeatureFlags(workspaceDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return; // type narrowing
    expect(result.flags.flags['feedback_channel']?.enabled).toBe(true);
    expect(result.flags.source).toBe('defaults');
  });

  it('reads a valid feature-flags.yaml and overrides feedback_channel to disabled', () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'feature-flags.yaml'),
      'feedback_channel:\n  enabled: false\n',
      'utf8',
    );
    const result = loadWorkspaceFeatureFlags(workspaceDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.flags['feedback_channel']?.enabled).toBe(false);
    expect(result.flags.source).toBe('workspace_file');
  });

  it('returns ok:false with reason and nextAction on malformed YAML', () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'feature-flags.yaml'),
      'feedback_channel: { enabled: "not-a-bool"',
      'utf8',
    );
    const result = loadWorkspaceFeatureFlags(workspaceDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('YAML');
    expect(result.nextAction).toBeTruthy();
  });

  it('returns ok:false when YAML contains array instead of mapping', () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'feature-flags.yaml'),
      '- item1\n- item2\n',
      'utf8',
    );
    const result = loadWorkspaceFeatureFlags(workspaceDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('mapping');
  });
});

// ---------------------------------------------------------------------------
// buildFeedbackChannelFlags
// ---------------------------------------------------------------------------

describe('buildFeedbackChannelFlags', () => {
  it('returns feedback_channel enabled=true when flags loaded successfully and default is enabled', () => {
    const loadResult = loadWorkspaceFeatureFlags(workspaceDir);
    const flags = buildFeedbackChannelFlags(loadResult);
    expect(flags.feedback_channel.enabled).toBe(true);
  });

  it('returns feedback_channel enabled=false when load failed (fail-closed)', () => {
    // Simulate load failure
    const flags = buildFeedbackChannelFlags({
      ok: false,
      reason: 'test failure',
      nextAction: 'fix it',
    });
    expect(flags.feedback_channel.enabled).toBe(false);
  });

  it('returns feedback_channel enabled=false when YAML sets it to false', () => {
    fs.writeFileSync(
      path.join(workspaceDir, '.pd', 'feature-flags.yaml'),
      'feedback_channel:\n  enabled: false\n',
      'utf8',
    );
    const loadResult = loadWorkspaceFeatureFlags(workspaceDir);
    const flags = buildFeedbackChannelFlags(loadResult);
    expect(flags.feedback_channel.enabled).toBe(false);
  });
});
