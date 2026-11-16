import fs from 'node:fs';

/**
 * Atomically create a file without replacing an existing record.
 * O_EXCL (the "wx" flag) makes the existence decision part of the open call,
 * avoiding a check-then-write race between experiment workers.
 *
 * @returns {boolean} true when created; false when another writer already won.
 */
export function writeFileIfAbsent(filePath, contents) {
  try {
    fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  }
}
