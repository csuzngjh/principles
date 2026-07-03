#!/usr/bin/env node
/**
 * Security Baseline Guard — SEC-BASE
 *
 * Static scan of repository to verify supply-chain baseline controls exist.
 * Does NOT do runtime checks (those live in architecture-regression.test.ts).
 *
 * Output (cli-1 compliant strict JSON):
 *   success: {"ok":true,"checked":N} on stdout, exit 0
 *   failure: {"ok":false,"failures":[{check,reason,fix}],"nextAction":...} on stdout, exit 1
 *
 * ERR-009: fail loud on missing required file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const failures = [];
let checked = 0;

function check(name, condition, reason, fix) {
  checked++;
  if (!condition) {
    failures.push({ check: name, reason, fix });
  }
}

function readText(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

// 1. SECURITY.md exists and contains "Vulnerability Disclosure"
{
  const content = readText('.github/SECURITY.md');
  check(
    'SECURITY.md exists',
    content !== null,
    '.github/SECURITY.md not found',
    'Create .github/SECURITY.md using the template in Task 1 of security baseline plan',
  );
  if (content !== null) {
    check(
      'SECURITY.md has disclosure section',
      /Vulnerability/i.test(content) && /disclos/i.test(content),
      '.github/SECURITY.md missing vulnerability disclosure language',
      'Ensure SECURITY.md contains "Vulnerability" and "disclosure" keywords',
    );
  }
}

// 2. CodeQL workflow exists
{
  const content = readText('.github/workflows/codeql.yml');
  check(
    'CodeQL workflow exists',
    content !== null,
    '.github/workflows/codeql.yml not found',
    'Create CodeQL workflow per Task 4 of security baseline plan',
  );
  if (content !== null) {
    check(
      'CodeQL targets javascript-typescript',
      /javascript-typescript/.test(content),
      'CodeQL workflow does not target javascript-typescript',
      'Add language: javascript-typescript to codeql.yml',
    );
  }
}

// 3. publish-npm.yml uses --provenance and --ignore-scripts
{
  const content = readText('.github/workflows/publish-npm.yml');
  check(
    'publish-npm.yml exists',
    content !== null,
    '.github/workflows/publish-npm.yml not found',
    'publish workflow should exist — verify repository layout',
  );
  if (content !== null) {
    check(
      'npm publish uses --provenance',
      /npm\s+publish\s+--provenance/.test(content),
      'publish-npm.yml missing `npm publish --provenance`',
      'Add --provenance flag to npm publish step',
    );
    check(
      'npm ci uses --ignore-scripts',
      /npm\s+ci\s+--ignore-scripts/.test(content),
      'publish-npm.yml missing `npm ci --ignore-scripts`',
      'Add --ignore-scripts flag to npm ci step to block install scripts',
    );
  }
}

// 4. package-lock.json exists at root
{
  const content = readText('package-lock.json');
  check(
    'root package-lock.json exists',
    content !== null,
    'package-lock.json not found at repository root',
    'Run `npm install` to generate package-lock.json and commit it',
  );
}

// 5. dependabot.yml covers npm + github-actions
{
  const content = readText('.github/dependabot.yml');
  check(
    'dependabot.yml exists',
    content !== null,
    '.github/dependabot.yml not found',
    'Create .github/dependabot.yml per GitHub supply chain security best practice',
  );
  if (content !== null) {
    check(
      'dependabot covers npm',
      /package-ecosystem:\s*['"]?npm['"]?/m.test(content),
      'dependabot.yml missing npm ecosystem',
      'Add package-ecosystem: npm entry',
    );
    check(
      'dependabot covers github-actions',
      /package-ecosystem:\s*['"]?github-actions['"]?/m.test(content),
      'dependabot.yml missing github-actions ecosystem',
      'Add package-ecosystem: github-actions entry',
    );
  }
}

// 6. lefthook config includes gitleaks
{
  const content = readText('lefthook.yml');
  check(
    'lefthook.yml exists',
    content !== null,
    'lefthook.yml not found',
    'lefthook is required for pre-push gitleaks hook',
  );
  if (content !== null) {
    check(
      'lefthook has gitleaks command',
      /gitleaks/.test(content),
      'lefthook.yml missing gitleaks command',
      'Add gitleaks command under pre-push in lefthook.yml',
    );
  }
}

// 7. PR-checks workflow includes npm audit
{
  const prChecks = readText('.github/workflows/pr-checks.yml');
  const ci = readText('.github/workflows/ci.yml');
  const content = prChecks ?? ci;
  check(
    'PR check workflow exists',
    content !== null,
    'Neither .github/workflows/pr-checks.yml nor ci.yml found',
    'Create a PR check workflow',
  );
  if (content !== null) {
    check(
      'PR checks include npm audit',
      /npm\s+audit/.test(content),
      'PR check workflow missing `npm audit` step',
      'Add `npm audit --audit-level=high` step to pr-checks.yml',
    );
  }
}

// Output
if (failures.length === 0) {
  process.stdout.write(JSON.stringify({ ok: true, checked }) + '\n');
  process.exit(0);
} else {
  const nextAction = failures.length === 1
    ? `Fix: ${failures[0]?.fix ?? 'see failure details'}`
    : `Fix ${failures.length} baseline failures — see "failures" array for per-item fixes`;
  process.stdout.write(JSON.stringify({ ok: false, checked, failures, nextAction }) + '\n');
  process.exit(1);
}
