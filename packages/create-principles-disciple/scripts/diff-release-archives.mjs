import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extract as extractTar } from 'tar';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('Usage: diff-release-archives <archive1> <archive2>');
  process.exit(2);
}

function hashTree(base) {
  const map = new Map();
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(base, p).split(path.sep).join('/');
      if (e.isDirectory()) visit(p);
      else map.set(rel, createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  visit(base);
  return map;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-archive-diff-'));
try {
  for (const [tag, archive] of [['A', a], ['B', b]]) {
    const dir = path.join(root, tag);
    fs.mkdirSync(dir);
    extractTar({ cwd: dir, file: archive, sync: true });
  }
  const mA = hashTree(path.join(root, 'A'));
  const mB = hashTree(path.join(root, 'B'));
  let shown = 0;
  for (const [rel, h] of mA) {
    const hb = mB.get(rel);
    if (hb === undefined) { console.log(`ONLY-IN-A: ${rel}`); shown++; }
    else if (hb !== h) { console.log(`DIFF: ${rel}`); shown++; }
    if (shown >= 60) { console.log('…truncated at 60'); break; }
  }
  for (const rel of mB.keys()) {
    if (!mA.has(rel)) { console.log(`ONLY-IN-B: ${rel}`); shown++; if (shown >= 60) break; }
  }
  if (shown === 0) console.log('trees identical — nondeterminism is in tar metadata');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
