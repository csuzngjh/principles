#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkspace, SkillRenderError, writeWorkspace } from './index.js';

interface Options {
  readonly check: boolean;
  readonly root: string;
}

function parseArgs(argv: readonly string[]): Options {
  let check = false;
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      root = resolve(value);
      index += 1;
    } else if (arg === 'render') {
      // 默认动作，显式写出来也接受
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, root };
}

function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.check) {
    const problems = checkWorkspace(options.root);
    if (problems.length === 0) {
      process.stdout.write('pd-skills: rendered artifacts match the single source\n');
      return 0;
    }
    process.stderr.write(`pd-skills: ${problems.length} mismatch(es)\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    return 1;
  }
  const files = writeWorkspace(options.root);
  process.stdout.write(`pd-skills: wrote ${files.length} artifact(s)\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof SkillRenderError) {
    process.stderr.write(`pd-skills: ${error.problems.length} problem(s)\n`);
    for (const problem of error.problems) process.stderr.write(`  - ${problem}\n`);
  } else {
    process.stderr.write(`pd-skills: ${(error as Error).message}\n`);
  }
  process.exitCode = 1;
}
