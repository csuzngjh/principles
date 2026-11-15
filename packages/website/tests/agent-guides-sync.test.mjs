/**
 * Contract test: the published agent guide copies and llms.txt are GENERATED
 * from the repo-root canonical guides (EP-06 — source of truth edited, the
 * artifact rebuilt). Pins:
 *   1. sync-agent-guides.mjs produces both language copies + llms.txt;
 *   2. the copies are byte-identical to the canonical sources (no hand edits
 *      can survive a rebuild);
 *   3. the canonical guides carry the acceptance-loop contract (install,
 *      restart, pd health, pd mcp probe) in BOTH languages;
 *   4. the sync is wired into the build (prebake) so a deployed site can
 *      never serve a stale copy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAgentGuides, canonicalToPublished } from '../scripts/sync-agent-guides.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEBSITE_ROOT, '..', '..');

test('syncAgentGuides writes both language copies and llms.txt', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-agent-guides-'));
  try {
    const written = syncAgentGuides(outDir);
    assert.equal(written.length, 3);
    for (const file of written) assert.ok(fs.existsSync(file), `missing ${file}`);
    assert.ok(fs.readFileSync(path.join(outDir, 'llms.txt'), 'utf8').includes('install-agent.zh.md'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('published copies are the deterministic transform of the canonical guides (no hand edits survive)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-agent-guides-'));
  try {
    syncAgentGuides(outDir);
    assert.equal(
      fs.readFileSync(path.join(outDir, 'install-agent.zh.md'), 'utf8'),
      canonicalToPublished(fs.readFileSync(path.join(REPO_ROOT, 'README_AGENT.md'), 'utf8')),
    );
    assert.equal(
      fs.readFileSync(path.join(outDir, 'install-agent.en.md'), 'utf8'),
      canonicalToPublished(fs.readFileSync(path.join(REPO_ROOT, 'README_AGENT_EN.md'), 'utf8')),
    );
    // The transform actually points repo-relative links at GitHub blobs…
    assert.ok(fs.readFileSync(path.join(outDir, 'install-agent.zh.md'), 'utf8')
      .includes('https://github.com/csuzngjh/principles/blob/main/README_AGENT_EN.md'));
    // …and leaves absolute URLs untouched.
    const en = fs.readFileSync(path.join(outDir, 'install-agent.en.md'), 'utf8');
    assert.ok(en.includes('https://principles-website.pages.dev/install-agent.en.md'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('canonicalToPublished skips fenced code blocks', () => {
  const input = [
    'text [guide](docs/foo.md) and [site](https://example.com/x) and [anchor](#sec)',
    '```bash',
    'echo [not-a-link](README.md)',
    '```',
    'after [ok](./docs/bar.md)',
  ].join('\n');
  const out = canonicalToPublished(input);
  assert.ok(out.includes('](https://github.com/csuzngjh/principles/blob/main/docs/foo.md)'));
  assert.ok(out.includes('](https://example.com/x)'));
  assert.ok(out.includes('](#sec)'));
  assert.ok(out.includes('echo [not-a-link](README.md)'), 'code fence content untouched');
  assert.ok(out.includes('](https://github.com/csuzngjh/principles/blob/main/docs/bar.md)'));
});

test('the canonical guides carry the install/restart/acceptance contract in both languages', () => {
  const zh = fs.readFileSync(path.join(REPO_ROOT, 'README_AGENT.md'), 'utf8');
  const en = fs.readFileSync(path.join(REPO_ROOT, 'README_AGENT_EN.md'), 'utf8');
  for (const guide of [zh, en]) {
    assert.ok(guide.includes('npx create-principles-disciple'), 'installer command present');
    assert.ok(guide.includes('--host codex'), 'codex path present');
    assert.ok(guide.includes('--host workbuddy'), 'workbuddy path present');
    assert.ok(guide.includes('pd health'), 'acceptance health command present');
    assert.ok(guide.includes('pd mcp probe'), 'acceptance MCP probe present');
    assert.ok(guide.includes('pd console open'), 'console open present');
    assert.ok(guide.includes('hostLoaded'), 'host-loaded witness explained');
  }
});

test('the sync is wired into the site build (prebake) — a deploy can never serve stale copies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WEBSITE_ROOT, 'package.json'), 'utf8'));
  assert.ok(
    String(pkg.scripts?.prebake ?? '').includes('sync-agent-guides.mjs'),
    'prebake must run scripts/sync-agent-guides.mjs',
  );
});
