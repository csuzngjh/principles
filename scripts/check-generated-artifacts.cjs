#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

const forbidden = [
  {
    pattern: /^packages\/[^/]+\/src\/.*\.d\.ts$/,
    reason: 'generated declaration files must stay out of src',
    allow: new Set(['packages/openclaw-plugin/src/openclaw-sdk.d.ts']),
  },
  {
    pattern: /^packages\/[^/]+\/src\/.*\.js$/,
    reason: 'compiled JavaScript must stay out of src',
  },
  {
    pattern: /^packages\/[^/]+\/src\/.*\.js\.map$/,
    reason: 'compiled source maps must stay out of src',
  },
  {
    pattern: /(^|\/)\.pd\//,
    reason: 'runtime PD state databases must not be committed',
  },
];

function gitLines(args) {
  const output = execFileSync('git', args, { encoding: 'utf8' }).trim();
  return output.length === 0 ? [] : output.split(/\r?\n/u);
}

const tracked = gitLines(['ls-files']);
const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
const files = [...new Set([...tracked, ...untracked])].map((file) => file.replace(/\\/gu, '/'));

const violations = [];

for (const file of files) {
  for (const rule of forbidden) {
    if (rule.allow?.has(file)) {
      continue;
    }
    if (rule.pattern.test(file)) {
      violations.push({ file, reason: rule.reason });
    }
  }
}

if (violations.length > 0) {
  console.error('Generated artifact gate failed. Remove these files from source control/worktree:');
  for (const violation of violations) {
    console.error(`- ${violation.file} (${violation.reason})`);
  }
  process.exit(1);
}

console.log('Generated artifact gate passed.');
