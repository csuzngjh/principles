/**
 * P1-1 negative tests — the writable/historical separation must survive
 * symlink and Windows-junction aliases, not just lexical path spellings.
 *
 * Every refusal is asserted twice where it matters: at the boundary helper
 * AND through the real route (POST /studies, POST /run, POST /report) against
 * the repository's committed historical studies, with a full-directory
 * fingerprint proving nothing was written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { handleExaminerRoute } from '../../../src/server/routes/examiner.js';
import {
  canonicalPathSync,
  isPathInside,
  isSamePath,
  verifyConsoleOwnership,
  writableRootProblem,
  writableStudyDirProblem,
  STUDY_PATH_PROBLEM,
  type StudyRoots,
} from '../../../src/server/routes/examiner-executor.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const historicalStudiesRoot = path.join(repoRoot, 'scripts', 'dev', 'principle-learning-lab', 'examiner-studies');

const linkDir = (target: string, link: string): void => {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
};

/** Full-directory fingerprint (relative path → type/content/link-target hash). */
function fingerprintTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        entries[relPath] = `link:${fs.readlinkSync(abs)}`;
      } else if (entry.isDirectory()) {
        entries[relPath] = 'dir';
        walk(abs, relPath);
      } else {
        entries[relPath] = `file:${createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`;
      }
    }
  };
  walk(root, '');
  return entries;
}

function createMockRequest(method: string, body?: unknown): IncomingMessage {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req = {
    method,
    url: 'http://localhost',
    on(event: string, handler: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
  };
  setTimeout(() => {
    if (body !== undefined) for (const handler of listeners.data ?? []) handler(Buffer.from(JSON.stringify(body)));
    for (const handler of listeners.end ?? []) handler();
  }, 0);
  return req as unknown as IncomingMessage;
}

function createMockResponse(): ServerResponse {
  const res = {
    headersSent: false,
    statusCode: 200,
    _body: '',
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(data?: string) {
      if (data !== undefined) res._body = data;
      return res;
    },
  };
  return res as unknown as ServerResponse;
}

async function call(method: string, subPath: string, body?: unknown) {
  const res = createMockResponse();
  await handleExaminerRoute(createMockRequest(method, body), res, path.join(os.tmpdir(), 'pd-examiner-path-workspace'), subPath);
  const mock = res as unknown as { statusCode: number; _body: string };
  let parsed: any = null;
  if (mock._body) {
    try {
      parsed = JSON.parse(mock._body);
    } catch {
      parsed = mock._body;
    }
  }
  return { statusCode: mock.statusCode, body: parsed };
}

/** Unlink every link/junction first, then delete — a recursive delete must
 *  never be trusted to be junction-safe on a tree this test builds. */
function removeTreeSafely(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fs.unlinkSync(abs);
    else if (entry.isDirectory()) removeTreeSafely(abs);
  }
  fs.rmSync(root, { recursive: true, force: true });
}

let tempDir: string;
let historical: string;
let historicalStudy: string;

const rootsOf = (writable: string, historicalRoot: string = historical): StudyRoots => ({ writable, historical: historicalRoot });

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-examiner-boundary-'));
  historical = path.join(tempDir, 'historical');
  historicalStudy = path.join(historical, 'EXM-HIST-01');
  fs.mkdirSync(historicalStudy, { recursive: true });
  fs.writeFileSync(path.join(historicalStudy, 'examiner-manifest.json'), JSON.stringify({ studyId: 'EXM-HIST-01' }));
});

afterEach(() => {
  delete process.env.PD_EXAMINER_STUDIES_ROOT;
  removeTreeSafely(tempDir);
});

describe('P1-1 canonical writable/historical separation', () => {
  it('rejects a writable root that IS a symlink/junction to the historical root', () => {
    const link = path.join(tempDir, 'writable-link');
    linkDir(historical, link);
    expect(canonicalPathSync(link)).toBe(fs.realpathSync.native(historical));
    expect(writableRootProblem(rootsOf(link))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('rejects a writable root whose parent is a symlink/junction to the historical root', () => {
    const bridge = path.join(tempDir, 'bridge');
    linkDir(historical, bridge);
    expect(writableRootProblem(rootsOf(path.join(bridge, 'console-studies')))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('rejects the historical root reached through a symlink alias while writable uses the real path', () => {
    const alias = path.join(tempDir, 'historical-alias');
    linkDir(historical, alias);
    expect(writableRootProblem(rootsOf(historical, alias))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('rejects a writable root nested INSIDE the historical root', () => {
    expect(writableRootProblem(rootsOf(path.join(historical, 'console-studies')))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('rejects a historical root nested INSIDE the writable root', () => {
    const writable = path.join(tempDir, 'writable');
    fs.mkdirSync(writable, { recursive: true });
    expect(writableRootProblem(rootsOf(writable, path.join(writable, 'studies')))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('resolves a not-yet-existing directory through its nearest existing (symlinked) parent', () => {
    const safe = path.join(tempDir, 'safe');
    fs.mkdirSync(safe, { recursive: true });
    const bridge = path.join(tempDir, 'safe-bridge');
    linkDir(safe, bridge);
    const resolved = canonicalPathSync(path.join(bridge, 'future', 'studies'));
    expect(resolved).toBe(path.join(fs.realpathSync.native(safe), 'future', 'studies'));
    // And with a parent that aliases the historical root, the gate refuses.
    const evilBridge = path.join(tempDir, 'evil-bridge');
    linkDir(historical, evilBridge);
    expect(writableRootProblem(rootsOf(path.join(evilBridge, 'future')))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it.runIf(process.platform === 'win32')('detects a Windows junction (not only a symlink)', () => {
    const junction = path.join(tempDir, 'writable-junction');
    fs.symlinkSync(historical, junction, 'junction');
    expect(canonicalPathSync(junction)).toBe(fs.realpathSync.native(historical));
    expect(writableRootProblem(rootsOf(junction))).toBe(STUDY_PATH_PROBLEM.rootNotIsolated);
  });

  it('evaluates the FINAL study directory canonically — a junction swapped in after creation is refused', () => {
    const writable = path.join(tempDir, 'writable');
    const studyId = 'EXM-C-SWAPPED01';
    const studyDir = path.join(writable, studyId);
    fs.mkdirSync(studyDir, { recursive: true });
    fs.rmdirSync(studyDir);
    linkDir(historicalStudy, studyDir);
    expect(writableStudyDirProblem(rootsOf(writable), studyDir)).toBe(STUDY_PATH_PROBLEM.historical);
    expect(verifyConsoleOwnership(writable, studyDir).ok).toBe(false);
  });

  it('fails closed when a path cannot be resolved', () => {
    expect(writableRootProblem(rootsOf(`${tempDir}\u0000bad`))).toBe(STUDY_PATH_PROBLEM.unresolved);
  });

  it('refuses an ownership marker that is a symlink (the trust anchor must be a regular file)', () => {
    const writable = path.join(tempDir, 'writable');
    const studyId = 'EXM-C-MARKERLINK';
    const studyDir = path.join(writable, studyId);
    fs.mkdirSync(studyDir, { recursive: true });
    fs.writeFileSync(path.join(studyDir, 'examiner-manifest.json'), JSON.stringify({ studyId }));
    const outside = path.join(tempDir, 'outside-marker.json');
    fs.writeFileSync(outside, JSON.stringify({
      schema: 'examiner-console-ownership.v1',
      origin: 'pd-console',
      studyId,
      writableRoot: fs.realpathSync.native(writable),
    }));
    let linked = true;
    try {
      fs.symlinkSync(outside, path.join(studyDir, '.console-study-owner.json'), 'file');
    } catch {
      linked = false; // file symlinks need privileges on some platforms
    }
    if (!linked) return;
    const check = verifyConsoleOwnership(writable, studyDir);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('regular file');
  });

  it('canonical containment is case- and separator-safe (no string-prefix artefacts)', () => {
    expect(isSamePath(path.join(tempDir, 'A'), path.join(tempDir, 'a'))).toBe(process.platform === 'win32');
    expect(isPathInside(path.join(tempDir, 'ab'), path.join(tempDir, 'abc'))).toBe(false);
    expect(isPathInside(tempDir, tempDir)).toBe(false);
  });
});

describe('P1-1 route-level refusals (real historical assets untouched)', () => {
  it('POST /studies refuses a symlinked writable root and writes nothing into the historical area', async () => {
    const link = path.join(tempDir, 'studies-link');
    linkDir(historicalStudiesRoot, link);
    const before = fingerprintTree(historicalStudiesRoot);
    process.env.PD_EXAMINER_STUDIES_ROOT = link;
    const res = await call('POST', '/studies', { targetPrincipleId: 'pri-target' });
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('writable_root_not_isolated');
    expect(fingerprintTree(historicalStudiesRoot)).toEqual(before);
  });

  it('a writable entry that aliases a historical study is refused for run and report', async () => {
    const writable = path.join(tempDir, 'writable');
    fs.mkdirSync(writable, { recursive: true });
    const studyId = 'EXM-C-ALIAS00001';
    linkDir(path.join(historicalStudiesRoot, 'EXM-V09-ACC-FULL'), path.join(writable, studyId));
    process.env.PD_EXAMINER_STUDIES_ROOT = writable;
    const before = fingerprintTree(path.join(historicalStudiesRoot, 'EXM-V09-ACC-FULL'));

    const run = await call('POST', `/studies/${studyId}/run`);
    // 404 when the directory read classifies the entry as a link (it is not
    // enumerated); 403 when it is enumerated and the boundary marks it
    // read-only. Both are refusals — never a write.
    expect([403, 404]).toContain(run.statusCode);

    const write = await call('POST', `/studies/${studyId}/report`);
    expect([403, 404]).toContain(write.statusCode);

    expect(fingerprintTree(path.join(historicalStudiesRoot, 'EXM-V09-ACC-FULL'))).toEqual(before);
  });

  it('historical studies remain readable through the canonical path', async () => {
    process.env.PD_EXAMINER_STUDIES_ROOT = path.join(tempDir, 'unused');
    const res = await call('GET', '/studies/EXM-V09-ACC-FULL');
    expect(res.statusCode).toBe(200);
    expect(res.body.data.readOnly).toBe(true);
  });
});
