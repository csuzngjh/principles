/**
 * Deterministic SHA-256 identity of a package's dist/ tree (G3.2 build-once).
 *
 * Every regular file, in sorted POSIX-relative order, framed as
 * `<rel>\0<size>\0<bytes>` — so renames, additions, deletions and byte
 * changes all move the digest.
 *
 * Symlinks and other special entries are NOT tolerated: they are not hashed
 * (following them could read outside dist and would make the digest depend on
 * a file the build did not produce), and ignoring them would let a symlink
 * appear/disappear/retarget without moving the digest — i.e. a false reuse.
 * No build script in this repository emits them, so encountering one means the
 * tree is not a trustworthy build result: fail closed (throw), never skip.
 *
 * Returns null when dist/ is missing or holds no regular file: an empty
 * dist is never a reusable build result.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function digestDist(root) {
  if (!existsSync(root)) return null;
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
      else {
        throw new Error(
          `dist contains a non-regular entry (symlink or special file): ${child} — refusing to treat this tree as a reusable build result`
        );
      }
    }
  };
  visit(root);
  if (files.length === 0) return null;
  const ordered = files
    .map((abs) => ({ abs, rel: relative(root, abs).split(sep).join('/') }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of ordered) {
    const bytes = readFileSync(file.abs);
    hash.update(`${file.rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}
