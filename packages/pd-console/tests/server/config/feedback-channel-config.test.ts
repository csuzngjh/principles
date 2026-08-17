import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getFeedbackChannelConfig } from '../../../src/server/config/pd-config-store.js';

let tmpDir: string;
let workspaceDir: string;

function writeConfig(yaml: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), yaml, 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fb-channel-config-test-'));
  workspaceDir = path.join(tmpDir, 'w');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getFeedbackChannelConfig', () => {
  it('returns all-empty when config is missing', () => {
    expect(getFeedbackChannelConfig(workspaceDir)).toEqual({ ingestUrl: '', ingestToken: '', githubRepo: '', githubProxy: '' });
  });

  it('reads the four channel keys from feedback section', () => {
    writeConfig(`
feedback:
  ingest_url: https://principles-website.pages.dev/api/feedback
  ingest_token: s3cr3t
  github_repo: csuzngjh/principles
  github_proxy: "http://127.0.0.1:7890"
`);
    expect(getFeedbackChannelConfig(workspaceDir)).toEqual({
      ingestUrl: 'https://principles-website.pages.dev/api/feedback',
      ingestToken: 's3cr3t',
      githubRepo: 'csuzngjh/principles',
      githubProxy: 'http://127.0.0.1:7890',
    });
  });

  it('treats present-but-wrong-typed keys as empty (unknown-first, no `as`)', () => {
    writeConfig('feedback:\n  ingest_url: 12345\n  github_repo: true\n');
    const cfg = getFeedbackChannelConfig(workspaceDir);
    expect(cfg.ingestUrl).toBe('');
    expect(cfg.githubRepo).toBe('');
    expect(cfg.ingestToken).toBe('');
  });
});