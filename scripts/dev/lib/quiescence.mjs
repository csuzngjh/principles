// Quiescence proof for a quarantined worktree (PRI-1143, Owner review P1-1).
//
// A process that opened a file inside the worktree BEFORE the quarantine move
// keeps its handle across the rename and can keep writing. If the tree is then
// deleted, those writes land in an unlinked file and are lost silently —
// verified on Windows (libuv opens with FILE_SHARE_DELETE, so the unlink
// succeeds and writes through the old handle continue) and inherent on POSIX.
// A second `git status` cannot see a writer that has not written yet, so
// deletion is only allowed after a positive, point-in-time proof that NOTHING
// holds anything inside the quarantine:
//
//   linux   every /proc/<pid>/{fd,cwd,root,maps} entry is scanned for a path
//           inside the quarantine. Processes that cannot be inspected without
//           privileges are counted and reported as outside the proof boundary:
//           other users' processes, non-dumpable processes (systemd's
//           (sd-pam), ssh-agent, gpg-agent — detected from the root-owned fd
//           directory), and same-user processes whose own credentials explain
//           the denial (setgid, a different uid set, or permitted
//           capabilities). A dumpable same-user process denied for any reason
//           its credentials do NOT explain (e.g. LSM confinement, as with a
//           snap-packaged editor's terminal) fails the proof.
//   win32   the private quarantine parent is renamed out and back. Windows
//           refuses to rename a directory while ANY handle is open anywhere in
//           its subtree — file (read, write or append), directory handle, or
//           a process working directory, at any depth, from any process —
//           verified empirically, so a successful rename IS the proof.
//   other   no inspection mechanism: quiescence is never proven, and the
//           caller must refuse (fail-closed, git-14). No bypass exists.
//
// Both proofs are point-in-time. A process that opens a NEW handle after the
// proof would first have to discover the freshly created, private quarantine
// path; that window is part of the documented boundary in ERR-098.
//
// No background work: bounded retries use a synchronous sleep, never a timer.

import fs from 'node:fs';
import path from 'node:path';

export const QUIESCENCE_ATTEMPTS = 5;
export const QUIESCENCE_RETRY_MS = 100;

/** Windows rename failures that mean "a handle is open in this subtree". */
const HANDLE_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function message(err) {
  return String((err && err.code) || (err && err.message) || err);
}

/**
 * Linux grants /proc/<pid>/fd only when ptrace read access is allowed, which
 * also requires the target to hold no credentials the caller lacks. A process
 * of the same uid can therefore be uninspectable for a known reason: it runs
 * setgid (Debian/Ubuntu ship ssh-agent setgid), with a different uid set, or
 * with permitted capabilities. Those are reported as outside the proof
 * boundary, exactly like other users' processes. Any denial its credentials do
 * NOT explain stays a hard failure.
 *
 * @returns {string|null} the credential difference that explains the denial
 */
function credentialsExplainDenial(procDir, myUid, myGid) {
  let status;
  try {
    status = fs.readFileSync(path.posix.join(procDir, 'status'), 'utf8');
  } catch {
    return null;
  }
  const field = (name) => {
    const line = status.split('\n').find((entry) => entry.startsWith(name + ':'));
    return line ? line.slice(name.length + 1).trim() : '';
  };
  const ids = (name) => field(name).split(/\s+/).filter(Boolean).map(Number);
  const reasons = [];
  if (ids('Uid').some((id) => id !== myUid)) reasons.push('Uid ' + field('Uid'));
  if (myGid !== null && ids('Gid').some((id) => id !== myGid)) reasons.push('Gid ' + field('Gid'));
  const capPrm = field('CapPrm');
  if (capPrm !== '' && !/^0+$/.test(capPrm)) reasons.push('CapPrm ' + capPrm);
  return reasons.length > 0 ? reasons.join(', ') : null;
}

/**
 * Linux: one pass over /proc. Returns the holders found, the number of
 * processes outside the inspectable boundary, or an `unprovable` reason.
 */
function scanProcFs(quarantineRoot) {
  const inside = (target) => {
    const cleaned = target.endsWith(' (deleted)') ? target.slice(0, -' (deleted)'.length) : target;
    return cleaned === quarantineRoot || cleaned.startsWith(quarantineRoot + '/');
  };
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (err) {
    return { unprovable: '/proc is not readable (' + message(err) + ')' };
  }
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const myGid = typeof process.getgid === 'function' ? process.getgid() : null;
  const holders = [];
  const elevated = [];
  let uninspected = 0;
  for (const pid of pids) {
    const procDir = path.posix.join('/proc', pid);
    let ownerUid;
    try {
      ownerUid = fs.statSync(procDir).uid;
    } catch {
      continue; // exited between the listing and this read
    }
    let fdNames;
    try {
      fdNames = fs.readdirSync(path.posix.join(procDir, 'fd'));
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ESRCH')) continue;
      if (myUid !== null && ownerUid === myUid) {
        let explanation = credentialsExplainDenial(procDir, myUid, myGid);
        if (explanation === null) {
          // A NON-DUMPABLE process (prctl PR_SET_DUMPABLE 0: systemd's
          // (sd-pam), ssh-agent, gpg-agent) also refuses ptrace reads. The
          // kernel (task_dump_owner) then gives its /proc/<pid> entries to
          // root — except world-readable directories such as /proc/<pid>
          // itself, which is why it looked like ours. stat (not readdir) of
          // the fd directory is permitted and shows that owner.
          try {
            const fdOwnerUid = fs.statSync(path.posix.join(procDir, 'fd')).uid;
            if (fdOwnerUid !== myUid) explanation = 'non-dumpable (its fd directory is owned by uid ' + fdOwnerUid + ')';
          } catch {
            /* exited mid-scan */
          }
        }
        let command = '?';
        try {
          command = fs.readFileSync(path.posix.join(procDir, 'comm'), 'utf8').trim();
        } catch {
          /* exited mid-scan */
        }
        if (explanation === null) {
          return {
            unprovable: 'process ' + pid + ' (' + command + ') belongs to this user and is dumpable, its descriptors are ' +
              'unreadable (' + message(err) + ') and its credentials do not explain the denial (an LSM-confined process?)',
          };
        }
        elevated.push({ pid: Number(pid), command, credentials: explanation });
      }
      uninspected += 1;
      continue;
    }
    let command = null;
    const note = (kind, target) => {
      if (command === null) {
        try {
          command = fs.readFileSync(path.posix.join(procDir, 'comm'), 'utf8').trim();
        } catch {
          command = '?';
        }
      }
      holders.push({ pid: Number(pid), command, kind, path: target });
    };
    const links = [
      { kind: 'cwd', link: path.posix.join(procDir, 'cwd') },
      { kind: 'root', link: path.posix.join(procDir, 'root') },
      ...fdNames.map((fd) => ({ kind: 'fd', link: path.posix.join(procDir, 'fd', fd) })),
    ];
    for (const { kind, link } of links) {
      let target;
      try {
        target = fs.readlinkSync(link);
      } catch {
        continue; // closed or exited mid-scan
      }
      if (inside(target)) note(kind, target);
    }
    try {
      for (const line of fs.readFileSync(path.posix.join(procDir, 'maps'), 'utf8').split('\n')) {
        const mapped = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\d+\s+(\/.*)$/);
        if (mapped && inside(mapped[1])) {
          note('mmap', mapped[1]);
          break;
        }
      }
    } catch {
      /* exited mid-scan: its descriptors were already checked */
    }
  }
  return { holders, elevated, uninspected };
}

function proveLinux(quarantinePath) {
  const mechanism = 'linux-procfs';
  let quarantineRoot;
  try {
    quarantineRoot = fs.realpathSync.native(quarantinePath);
  } catch (err) {
    return { proven: false, mechanism, reason: 'the quarantine path cannot be resolved (' + message(err) + ')' };
  }
  let last = null;
  for (let attempt = 0; attempt < QUIESCENCE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(QUIESCENCE_RETRY_MS);
    last = scanProcFs(quarantineRoot);
    if (last.unprovable) return { proven: false, mechanism, reason: last.unprovable };
    // A transient reader (an indexer, a watcher reading one file) disappears
    // between passes; a real holder is seen on every pass.
    if (last.holders.length === 0) {
      return { proven: true, mechanism, uninspectedProcesses: last.uninspected, uninspectedDetail: last.elevated };
    }
  }
  const shown = last.holders.slice(0, 5)
    .map((h) => h.command + ' (pid ' + h.pid + ', ' + h.kind + ': ' + h.path + ')')
    .join('; ');
  return {
    proven: false,
    mechanism,
    holders: last.holders,
    uninspectedProcesses: last.uninspected,
    uninspectedDetail: last.elevated,
    reason: last.holders.length + ' handle(s) inside the quarantine are still held: ' + shown +
      (last.holders.length > 5 ? '; …' : ''),
  };
}

function proveWindows(quarantineParent) {
  const mechanism = 'win32-rename-probe';
  const probe = quarantineParent + '.quiescence-probe';
  let outError = null;
  for (let attempt = 0; attempt < QUIESCENCE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(QUIESCENCE_RETRY_MS);
    try {
      fs.renameSync(quarantineParent, probe);
      outError = null;
      break;
    } catch (err) {
      outError = err;
      if (!err || !HANDLE_BUSY_CODES.has(err.code)) break;
    }
  }
  if (outError) {
    return {
      proven: false,
      mechanism,
      reason: HANDLE_BUSY_CODES.has(outError.code)
        ? 'a process still holds a file, directory or working-directory handle inside the quarantine ' +
          '(Windows refuses to rename a tree with open handles: ' + outError.code + ')'
        : 'the quiescence rename probe failed (' + message(outError) + ')',
    };
  }
  // The probe name is brand new and private; only a scanner can touch it in
  // this window, so a short bounded retry is enough to rename it back.
  let backError = null;
  for (let attempt = 0; attempt < QUIESCENCE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) sleepSync(QUIESCENCE_RETRY_MS);
    try {
      fs.renameSync(probe, quarantineParent);
      return { proven: true, mechanism };
    } catch (err) {
      backError = err;
    }
  }
  return {
    proven: false,
    mechanism,
    reason: 'the quarantine could not be renamed back after the quiescence probe (' + message(backError) + ')',
    displacedTo: probe,
  };
}

/**
 * Prove that no process holds a file, directory, working directory or mapping
 * inside the quarantined tree, immediately before it is deleted.
 *
 * @param {{quarantinePath: string, quarantineParent: string, platform?: string}} opts
 * @returns {{proven: boolean, mechanism: string, reason?: string,
 *            holders?: Array<{pid: number, command: string, kind: string, path: string}>,
 *            uninspectedProcesses?: number,
 *            uninspectedDetail?: Array<{pid: number, command: string, credentials: string}>,
 *            displacedTo?: string}}
 *          `uninspectedDetail` names the same-user processes that could not be
 *          inspected and the credentials that explain why.
 *          `displacedTo` is set only when a Windows probe moved the quarantine
 *          parent and could not move it back: the tree is then under that path.
 */
export function proveQuarantineQuiescent({ quarantinePath, quarantineParent, platform = process.platform }) {
  if (platform === 'linux') return proveLinux(quarantinePath);
  if (platform === 'win32') return proveWindows(quarantineParent);
  return {
    proven: false,
    mechanism: 'unsupported',
    reason: 'no open-handle inspection mechanism exists for ' + platform + ', so it cannot be proven that no ' +
      'process still holds a file inside the quarantine',
  };
}
