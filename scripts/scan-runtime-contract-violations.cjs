#!/usr/bin/env node
/**
 * Runtime Contract Violation Scanner
 *
 * Scans for patterns that map to high-recurrence ERR entries:
 * - ERR-001: `as` type assertions bypassing runtime validation
 * - ERR-002: empty catch blocks silently swallowing errors
 * - ERR-013: `in` operator on untrusted objects (matches inherited props)
 *
 * Usage: node scripts/scan-runtime-contract-violations.cjs
 * Exit code 0 = no violations (or warning mode), 1 = violations found in strict mode
 *
 * Default: warning mode (exit 0, violations printed to stderr).
 * Set PD_STRICT_SCAN=1 to fail the process on any violation.
 *
 * Exemption: append `// runtime-contract:exempt ERR-XXX <reason>` to the line.
 * The exemption is ERR-specific: only violations matching the specified ERR-XXX
 * are skipped. A reason after the ERR ID is required.
 * Example: `// runtime-contract:exempt ERR-001 deliberate type violation to test runtime contract enforcement`
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = [
  'packages/principles-core/src',
  'packages/openclaw-plugin/src',
  'packages/pd-cli/src',
  'packages/pd-console/src',
  'packages/create-principles-disciple/src',
];
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// Patterns: [regex, ERR ID, description]
const PATTERNS = [
  // ERR-001: `as` assertions on untrusted/unknown types at boundaries
  {
    regex: /\bas\s+(Record<string,\s*unknown>|unknown\s+as|never\b|TOutput|RuleHostResult|DiagnosticianOutput)/g,
    errId: 'ERR-001',
    description: '`as` type assertion bypassing runtime validation',
  },
  // ERR-002: empty catch blocks
  {
    regex: /catch\s*\([^)]*\)\s*\{\s*\}/g,
    errId: 'ERR-002',
    description: 'empty catch block silently swallowing errors',
  },
  // ERR-002: .catch(() => {}) with empty arrow body
  {
    regex: /\.catch\(\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)/g,
    errId: 'ERR-002',
    description: '.catch(() => {}) silently swallowing errors',
  },
  // ERR-013: `in` operator on potentially untrusted objects
  {
    regex: /(?:['"`][^'"`]+['"`]|\b[A-Za-z_$][\w$]*)\s+in\s+(?:raw|obj|value|entry|data|result|parsed|fixture|output|response)\b/g,
    errId: 'ERR-013',
    description: '`in` operator on potentially untrusted object (use Object.hasOwn())',
  },
];

function walkDir(dir, results) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
    } else if (SCAN_EXTENSIONS.includes(path.extname(entry.name))) {
      results.push(fullPath);
    }
  }
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of PATTERNS) {
      const matches = line.matchAll(pattern.regex);
      for (const match of matches) {
        // Check for ERR-specific exemption: runtime-contract:exempt ERR-XXX <reason>
        const exemptMatch = line.match(/runtime-contract:exempt\s+ERR-(\d+)\s+(\S.*)$/);
        if (exemptMatch && `ERR-${exemptMatch[1]}` === pattern.errId) continue;

        violations.push({
          file: path.relative(ROOT, filePath),
          line: i + 1,
          column: match.index + 1,
          errId: pattern.errId,
          description: pattern.description,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }
  return violations;
}

function main() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    walkDir(path.join(ROOT, dir), files);
  }

  const allViolations = [];
  for (const file of files) {
    allViolations.push(...scanFile(file));
  }

  const strict = process.env.PD_STRICT_SCAN === '1';

  if (allViolations.length === 0) {
    console.log('✓ No runtime contract violations found');
    process.exit(0);
  }

  console.error(`✗ Found ${allViolations.length} runtime contract violation(s):\n`);
  for (const v of allViolations) {
    console.error(`  [${v.errId}] ${v.file}:${v.line}:${v.column}`);
    console.error(`    ${v.description}`);
    console.error(`    ${v.snippet}`);
    console.error(`    To exempt: append // runtime-contract:exempt ${v.errId} <reason>`);
    console.error('');
  }

  if (strict) {
    process.exit(1);
  } else {
    console.error(`(Warning mode: ${allViolations.length} violation(s) found. Set PD_STRICT_SCAN=1 to fail.)`);
    process.exit(0);
  }
}

main();
