'use strict';
/**
 * PRI-1257 r3 P2-01 — fault injection preload for the REAL admission-probe
 * CLI subprocess.
 *
 * Loaded via NODE_OPTIONS=--require, which executes BEFORE the ESM module
 * graph exists — patches applied to the CJS builtin exports here are what
 * the CLI's `import { fstatSync } from 'node:fs'` bindings then resolve to
 * (verified empirically: a --require preload patch is visible to ESM builtin
 * named imports). This injects a deterministic fstatSync failure at the
 * blob-read path and counts closeSync calls for the faulted descriptor, so
 * the test can prove the fd lifecycle closes exactly once without adding any
 * debug interface to the probe itself.
 *
 * Modes:
 *   PRI1257_FAULT=fstat — the FIRST fstatSync call in the process throws
 *     deterministically. In the probe's execution order the first fstatSync
 *     is the blob-read descriptor (planReadonlyOpen/fingerprints use
 *     statSync, the database is a native addon outside Node's fs), so this
 *     deterministically faults open-success → fstat-throw inside
 *     readBlobFileSafely.
 *   PRI1257_FAULT_LOG=<file> — every closeSync of the faulted fd appends
 *     `FAULT_FD_CLOSE=<n>`; the test asserts exactly one line.
 */
const fs = require('node:fs');

const mode = process.env.PRI1257_FAULT || '';
const logFile = process.env.PRI1257_FAULT_LOG || '';

if (mode === 'fstat' && logFile) {
  let faultedFd = null;
  let closesOfFaultedFd = 0;
  const origFstat = fs.fstatSync;
  fs.fstatSync = function faultInjectedFstat(fd, ...rest) {
    if (faultedFd === null) {
      faultedFd = fd;
      throw new Error('PRI1257_FAULT_INJECTED_FSTAT');
    }
    return origFstat.call(fs, fd, ...rest);
  };
  const origClose = fs.closeSync;
  fs.closeSync = function countedClose(fd) {
    if (fd === faultedFd) {
      closesOfFaultedFd += 1;
      try {
        fs.appendFileSync(logFile, `FAULT_FD_CLOSE=${closesOfFaultedFd}\n`);
      } catch {
        // logging must never mask the probe's own outcome
      }
    }
    return origClose.call(fs, fd);
  };
}
