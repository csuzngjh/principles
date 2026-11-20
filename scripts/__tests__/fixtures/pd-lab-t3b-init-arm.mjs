#!/usr/bin/env node
/**
 * PD-Lab v0.3 T3b test fixture — initialize ONE synthetic arm worktree.
 *
 * Input: a single JSON line on stdin: {"armDir": "...", "stubCliSource": "..."}
 * Output: the fresh commit HEAD on stdout (the value the experiment config's
 * expectedHead pins).
 *
 * Creates <armDir>/packages/pd-cli/dist/index.js (a copy of the stub CLI
 * fixture) and commits everything on a fresh git branch. Git runs with
 * literal subcommands and the DIRECTORY as cwd (never as command text); no
 * shell, no network, nothing outside <armDir>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const stdin = fs.readFileSync(0, 'utf8');
let request;
try {
  request = JSON.parse(stdin);
} catch {
  request = null;
}
const armDir = request?.armDir;
const stubCliSource = request?.stubCliSource;
if (typeof armDir !== 'string' || typeof stubCliSource !== 'string' || armDir.trim() === '' || stubCliSource.trim() === '') {
  console.error('usage: echo {"armDir":"...","stubCliSource":"..."} | node pd-lab-t3b-init-arm.mjs');
  process.exit(2);
}
const distDir = path.join(armDir, 'packages', 'pd-cli', 'dist');
fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(stubCliSource, path.join(distDir, 'index.js'));
fs.writeFileSync(path.join(armDir, 'README.md'), `arm worktree ${path.basename(armDir)}\n`, 'utf8');
const git = (args) => execFileSync('git', args, { cwd: armDir, encoding: 'utf8' });
git(['init', '-q']);
git(['add', '-A']);
git(['-c', 'user.email=t3b@test.invalid', '-c', 'user.name=t3b', 'commit', '-qm', 'init']);
process.stdout.write(git(['rev-parse', 'HEAD']).trim() + '\n');
