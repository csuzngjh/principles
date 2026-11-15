/**
 * Sync the canonical agent guides into the website's static public/ dir.
 *
 * EP-06 (source of truth): the canonical guides live at the REPO ROOT
 * (README_AGENT.md / README_AGENT_EN.md). This script is the only producer of
 * the published copies (public/install-agent.zh.md / .en.md) and llms.txt —
 * generated at build time (wired into `prebake`), never hand-edited, never
 * committed. Editing a published copy would be silently overwritten.
 *
 * Usage:
 *   node scripts/sync-agent-guides.mjs [--out <dir>]   (default: ./public)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEBSITE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(WEBSITE_ROOT, '..', '..');

const GUIDES = [
  { source: 'README_AGENT.md', output: 'install-agent.zh.md' },
  { source: 'README_AGENT_EN.md', output: 'install-agent.en.md' },
];

const LLMS_TXT = `# Principles Disciple (PD)

> Owner-governed behavior internalization system for AI agents: capture pain
> signals (errors, corrections, blocked edits), distill owner-reviewed
> principles, activate them reversibly through prompt injection or hard tool
> hooks, and observe behavior change.

## Install (for agents)

- [Install & Acceptance Guide (中文)](install-agent.zh.md): the canonical agent guide — host detection (OpenClaw / Codex / WorkBuddy), install commands, restart semantics, the pd health / pd mcp probe acceptance loop, common-failure fixes.
- [Install & Acceptance Guide (English)](install-agent.en.md): the same canonical guide in English.

## Site

- [Install page (human-facing)](/install): per-host install walkthroughs.
- [Home](/): product overview.
`;

const REPO_BLOB_BASE = 'https://github.com/csuzngjh/principles/blob/main';

/**
 * Rewrite repo-relative markdown links into GitHub blob URLs for the PUBLISHED
 * copy. The canonical repo files keep working relative links (correct on
 * GitHub); on the website those same targets do not exist, so the published
 * copy points at the repository. Absolute URLs, anchors and site-absolute
 * paths are left untouched; fenced code blocks are skipped line-by-line.
 */
export function canonicalToPublished(content) {
  const lines = content.split('\n');
  let inFence = false;
  const linkPattern = /(\]\()([^)\s]+)(\))/g;
  return lines.map((line) => {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line.replace(linkPattern, (match, open, href, close) => {
      if (/^(https?:|mailto:|#|\/)/i.test(href)) return match;
      const clean = href.replace(/^\.\//, '');
      return `${open}${REPO_BLOB_BASE}/${clean}${close}`;
    });
  }).join('\n');
}

export function syncAgentGuides(outDir) {
  const resolvedOut = path.resolve(outDir);
  fs.mkdirSync(resolvedOut, { recursive: true });
  const written = [];
  for (const { source, output } of GUIDES) {
    const sourcePath = path.join(REPO_ROOT, source);
    const content = fs.readFileSync(sourcePath, 'utf8');
    if (content.trim().length === 0) {
      throw new Error(`canonical guide is empty: ${sourcePath}`);
    }
    const outPath = path.join(resolvedOut, output);
    fs.writeFileSync(outPath, canonicalToPublished(content), 'utf8');
    written.push(outPath);
  }
  const llmsPath = path.join(resolvedOut, 'llms.txt');
  fs.writeFileSync(llmsPath, LLMS_TXT, 'utf8');
  written.push(llmsPath);
  return written;
}

// CLI entry (test imports the module function instead). Windows-safe module
// detection via the real pathToFileURL (pd-mcp-server/src/index.ts pattern).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outFlagIndex = process.argv.indexOf('--out');
  const outDir = outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : path.join(WEBSITE_ROOT, 'public');
  const files = syncAgentGuides(outDir);
  for (const file of files) console.log(`[sync-agent-guides] wrote ${path.relative(REPO_ROOT, file)}`);
}
