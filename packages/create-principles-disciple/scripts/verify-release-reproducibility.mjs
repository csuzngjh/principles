#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPONENTS = ['plugin', 'console', 'core', 'pd-cli', 'host-runtime', 'install-layout'];
const root = mkdtempSync(join(tmpdir(), 'pd-reproducibility-'));
const input = join(root, 'input');
const builder = fileURLToPath(new URL('./build-release-asset.mjs', import.meta.url));

function snapshot(directory) {
  const hash = createHash('sha256');
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = join(current, entry.name);
      hash.update(entry.name);
      if (entry.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(directory);
  return hash.digest('hex');
}

try {
  for (const component of COMPONENTS) {
    const dependency = join(input, component, 'node_modules', 'fixture-runtime');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(input, component, 'package.json'), JSON.stringify({ name: component, dependencies: { 'fixture-runtime': '1.0.0' } }));
    writeFileSync(join(dependency, 'index.js'), `export default ${JSON.stringify(component)};\n`);
  }
  const before = snapshot(input);
  const archives = [];
  for (const build of ['first', 'second']) {
    const output = join(root, build);
    const archive = `${output}.tar`;
    archives.push(archive);
    execFileSync(process.execPath, [builder, '--input', input, '--output', output, '--archive', archive, '--digest-output', `${archive}.sha256`, '--platform', 'linux', '--arch', 'x64', '--node-abi', '127'], {
      env: { ...process.env, SOURCE_DATE_EPOCH: '1700000000' },
      stdio: 'pipe',
    });
  }
  if (!readFileSync(archives[0]).equals(readFileSync(archives[1]))) throw new Error('Canonical release fixture did not rebuild byte-identically');
  if (before !== snapshot(input)) throw new Error('Release archive builder mutated its source directory');
  process.stdout.write(`${createHash('sha256').update(readFileSync(archives[0])).digest('hex')}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
