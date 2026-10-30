// Regenerate every artifact whose bytes are bound to the frozen lib implementation.
//
// A branch refresh that touches any lib/*.mjs breaks OFFLINE_PACKAGE_DRIFT, because
// package-manifest.json hash-binds the whole implementation directory. Only the
// implementation binding and its derivatives may move; Owner-reviewed content hashes
// must not. This script recomputes exactly that closure, in dependency order, and fails
// closed if anything else moved.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashOfCanonical, offlinePackageManifest, offlineReviewSubjectHash, sha256 } from './lib/challenge-freeze.mjs';
import { replayExmPackage } from './run-exm-mvp-offline.mjs';

const labDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(labDir, '../../..');
const packageDir = path.join(labDir, 'challenge-studies', 'EXM-MVP-001-v4');
const researchDir = path.join(repoDir, 'docs/research/examiner-productization-20261029');
const ledgerDir = path.join(researchDir, 'owner-content-review');
const evidenceDir = path.join(researchDir, 'v4-evidence');
const acceptanceDoc = path.join(repoDir, 'docs/research/EXAMINER-v4-OFFLINE-ACCEPTANCE.md');
const instructionsDoc = path.join(repoDir, 'docs/research/EXAMINER-v4-HUMAN-REVIEW.md');
const zipPath = path.join(researchDir, 'GOLD-BLIND-REVIEW-v4.zip');

// Container properties are constants so a rebind changes entry content only. The review
// timeline lives in git and in the evidence log, not in the DOS timestamp.
const ZIP_DOS_DATE = 23_902; // 2026-10-30
const ZIP_DOS_TIME = 0;
const ZIP_VER_MADE_BY = 0x031e;
const ZIP_VER_NEEDED = 20;
const ZIP_FLAGS = 0x0800; // UTF-8 file names
const ZIP_DEFLATE_LEVEL = 9;

// The blind entry set is the reviewed contract: inputs.json, gold-review.json,
// expected-replay.json and revision.json stay out, so mechanical scores cannot leak
// to the reviewer before the independent ruling is sealed.
const BLIND_ZIP_ENTRIES = [
  'blind-review/cases.json',
  'blind-review/mapping.json',
  'blind-review/observed-traces.json',
  'blind-review/README.md',
  'blind-review/receipts.template.json',
  'blind-review/review-form.json',
  'real-source/assistant_turns.json',
  'real-source/dreamer.json',
  'real-source/pain44.json',
  'real-source/pain_diagnoses.json',
  'real-source/philosopher.json',
  'real-source/scribe.json',
  'real-source/tool_calls.json',
  'real-source/user_turns.json',
  'REVIEW-INSTRUCTIONS.md',
  'review-subject.json',
  'source-audit.json',
  'source-verification.json',
  'SHA256SUMS.json',
];

// The only blind entries whose bytes are expected to move with the implementation binding.
const BLIND_ZIP_DERIVED = new Set(['review-subject.json', 'blind-review/receipts.template.json', 'SHA256SUMS.json']);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function readZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x0605_4b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`ZIP_EOCD_MISSING ${file}`);
  const entries = [];
  let cursor = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x0201_4b50) throw new Error(`ZIP_CENTRAL_DIRECTORY_INVALID ${file}`);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const bytes = buf.subarray(dataStart, dataStart + compressedSize);
    entries.push({ name, bytes: method === 8 ? zlib.inflateRawSync(bytes) : bytes });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function crc32(bytes) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZipBuffer(contents) {
  const parts = [];
  const records = [];
  let offset = 0;
  for (const { name, bytes } of contents) {
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(bytes, { level: ZIP_DEFLATE_LEVEL });
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x0403_4b50, 0);
    header.writeUInt16LE(ZIP_VER_NEEDED, 4);
    header.writeUInt16LE(ZIP_FLAGS, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(ZIP_DOS_TIME, 10);
    header.writeUInt16LE(ZIP_DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    parts.push(header, nameBytes, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x0201_4b50, 0);
    record.writeUInt16LE(ZIP_VER_MADE_BY, 4);
    record.writeUInt16LE(ZIP_VER_NEEDED, 6);
    record.writeUInt16LE(ZIP_FLAGS, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(ZIP_DOS_TIME, 12);
    record.writeUInt16LE(ZIP_DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    records.push(record, nameBytes);
    offset += header.length + nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50, 0);
  end.writeUInt16LE(contents.length, 8);
  end.writeUInt16LE(contents.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

function collectBlindZipContents() {
  const contents = BLIND_ZIP_ENTRIES.filter((name) => name !== 'SHA256SUMS.json').map((name) => {
    const file = name === 'REVIEW-INSTRUCTIONS.md' ? instructionsDoc : path.join(packageDir, name);
    if (!fs.existsSync(file)) throw new Error(`BLIND_ZIP_SOURCE_MISSING ${name}`);
    return { name, bytes: fs.readFileSync(file) };
  });
  contents.push({
    name: 'SHA256SUMS.json',
    bytes: Buffer.from(`${JSON.stringify(contents.map(({ name, bytes }) => ({ path: name, sha256: sha256(bytes) })), null, 2)}\n`, 'utf8'),
  });
  return contents;
}

// The reviewer payload, not the container, is what must be reproduced: the committed
// bundle is checked entry by entry against the repository before anything is rewritten.
// Its own manifest is verified against its own bytes, because the derived entries
// legitimately differ from the repository while a rebind is in progress.
function assertBlindZipPayloadReproduced(previousEntries) {
  const contents = collectBlindZipContents();
  if (contents.length !== previousEntries.length) throw new Error(`BLIND_ZIP_ENTRY_COUNT ${previousEntries.length}->${contents.length}`);
  for (const [index, { name, bytes }] of contents.entries()) {
    const previous = previousEntries[index];
    if (previous.name !== name) throw new Error(`BLIND_ZIP_ENTRY_ORDER ${index}: ${previous.name} != ${name}`);
    if (BLIND_ZIP_DERIVED.has(name)) continue;
    if (!previous.bytes.equals(bytes)) throw new Error(`BLIND_ZIP_CONTENT_MOVED ${name}`);
  }
  const sums = new Map(JSON.parse(readZipSums(previousEntries)).map((row) => [row.path, row.sha256]));
  for (const { name, bytes } of previousEntries) {
    if (name !== 'SHA256SUMS.json' && sums.get(name) !== sha256(bytes)) throw new Error(`BLIND_ZIP_SUMS_MISMATCH ${name}`);
  }
}

function readZipSums(entries) {
  const entry = entries.find((row) => row.name === 'SHA256SUMS.json');
  if (!entry) throw new Error('BLIND_ZIP_SUMS_MISSING');
  return entry.bytes.toString('utf8');
}

// Contents are re-collected so the bundle carries the freshly written derived bindings.
function writeBlindReviewZip() {
  const contents = collectBlindZipContents();
  fs.writeFileSync(zipPath, buildZipBuffer(contents));
  return contents.length;
}

function refreshAcceptanceDoc(summary) {
  const lines = fs.readFileSync(acceptanceDoc, 'utf8').split('\n');
  const replace = (label, value) => {
    const index = lines.findIndex((line) => line.startsWith(`- ${label}\uFF1A`) || line.startsWith(`- ${label}:`));
    if (index < 0) throw new Error(`ACCEPTANCE_DOC_LINE_MISSING ${label}`);
    lines[index] = lines[index].replace(/`[0-9a-f]{64}`/, `\`${value}\``);
  };
  replace('v4 packageHash', summary.packageHash);
  replace('review subjectHash', summary.subjectHash);
  replace('reportHash', summary.reportHash);
  replace('盲审 ZIP SHA-256', summary.zipSha256);
  fs.writeFileSync(acceptanceDoc, lines.join('\n'));
}

function refreshDirectorySums(dir, fileNames) {
  // The ledger README documents SHA256SUMS.json as the hash of the ledger file
  // alone, so callers must name that file explicitly rather than widen it.
  const names = fileNames ?? fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS.json')
    .map((entry) => entry.name);
  const rows = names.sort((a, b) => a.localeCompare(b))
    .map((name) => ({ path: name, sha256: sha256(fs.readFileSync(path.join(dir, name))) }));
  writeJson(path.join(dir, 'SHA256SUMS.json'), rows);
}

function capture(command, args, cwd = repoDir) {
  try {
    return { exitCode: 0, stdout: execFileSync(command, args, { cwd, encoding: 'utf8' }) };
  } catch (error) {
    return { exitCode: error.status, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function writeEvidenceLog(summary, previousExpected) {
  const lab = path.join('scripts', 'dev', 'principle-learning-lab');
  const replay = capture(process.execPath, [path.join(lab, 'run-exm-mvp-offline.mjs')]);
  const gate = capture(process.execPath, [path.join(lab, 'verify-exm-human-review.mjs'), '--package', path.join(lab, 'challenge-studies', 'EXM-MVP-001-v4')]);
  // Same entry point and working directory as `npm run test:scripts`.
  const tests = capture(process.execPath, [path.join(repoDir, 'node_modules', 'vitest', 'vitest.mjs'), 'run',
    '__tests__/principle-learning-lab-examiner-productization-entry.test.ts',
    '__tests__/principle-learning-lab-frozen-package.test.ts',
    '__tests__/principle-learning-lab-human-review-intake.test.ts',
    '__tests__/principle-learning-lab-owner-content-review.test.ts'], path.join(repoDir, 'scripts'));
  if (replay.exitCode !== 0 || gate.exitCode !== 1 || tests.exitCode !== 0) {
    throw new Error(`EVIDENCE_GATE_FAILED replay=${replay.exitCode} human-gate=${gate.exitCode} tests=${tests.exitCode}`);
  }
  const reportRows = (report) => hashOfCanonical({ ...report, implementationHash: null });
  const lines = [
    replay.stdout.trimEnd(),
    'replay exit=0',
    gate.stdout.trimEnd(),
    'human-gate exit=1',
    tests.stdout.trimEnd(),
    `executions identical to the previous freeze: ${summary.executionsHash === previousExpected.executionsHash}`,
    `report rows identical to the previous freeze (only implementationHash moved): ${reportRows(summary.report) === reportRows(previousExpected.report)}`,
    `zip subjectHash ${summary.subjectHash} matches receipts.template.json`,
    `GOLD-BLIND-REVIEW-v4.zip sha256 ${summary.zipSha256} (${summary.zipEntries} entries)`,
    '',
  ];
  fs.writeFileSync(path.join(evidenceDir, 'post-review-fix-freeze.txt'), lines.join('\n'));
  refreshDirectorySums(evidenceDir);
}

export async function rebindExmV4Freeze({ recordEvidence = false } = {}) {
  const previousManifest = readJson(path.join(packageDir, 'package-manifest.json'));
  const previousExpected = readJson(path.join(packageDir, 'expected-replay.json'));
  const previousReceipts = readJson(path.join(packageDir, 'blind-review/receipts.template.json'));
  const previousEntries = readZipEntries(zipPath);
  assertBlindZipPayloadReproduced(previousEntries);

  // The frozen package self-verifies, so it must match disk before any committed producer
  // can be called. This provisional manifest is replaced once the derived files are written.
  writeJson(path.join(packageDir, 'package-manifest.json'), offlinePackageManifest(packageDir));

  const replay = await replayExmPackage(packageDir);
  const subjectHash = offlineReviewSubjectHash(packageDir);
  const executionsHash = hashOfCanonical(replay.executions);

  writeJson(path.join(packageDir, 'expected-replay.json'), {
    reportHash: replay.reportHash,
    executionsHash,
    executions: replay.executions,
    report: replay.report,
  });
  writeJson(path.join(packageDir, 'review-subject.json'), {
    schema: 'examiner-review-subject.v1',
    subjectHash,
    status: 'PENDING',
  });
  const receipts = previousReceipts;
  receipts.mappingReview.subjectHash = subjectHash;
  for (const review of receipts.goldReviews) review.subjectHash = subjectHash;
  writeJson(path.join(packageDir, 'blind-review/receipts.template.json'), receipts);

  // The Owner content-review ledger keeps its decisions, comments and dates; only the
  // recorded package environment is re-pointed, as its own bindingNote declares. The
  // manifest is computed here because replay.packageHash still describes the
  // pre-derived intermediate state of the package directory.
  const manifest = offlinePackageManifest(packageDir);
  writeJson(path.join(packageDir, 'package-manifest.json'), manifest);

  const ledger = readJson(path.join(ledgerDir, 'records.v1.json'));
  ledger.bindingContext.packageHash = manifest.packageHash;
  ledger.bindingContext.subjectHash = subjectHash;
  ledger.bindingContext.baseCommit = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const record of ledger.records) record.subjectHash = subjectHash;
  writeJson(path.join(ledgerDir, 'records.v1.json'), ledger);
  refreshDirectorySums(ledgerDir, ['records.v1.json']);

  const zipEntries = writeBlindReviewZip();
  const summary = { status: replay.status, packageHash: manifest.packageHash, reportHash: replay.reportHash,
    executions: replay.executions.length, executionsHash, subjectHash, report: replay.report,
    zipSha256: sha256(fs.readFileSync(zipPath)), zipEntries, observedNodeVersion: process.versions.node };

  const reportRows = (report) => hashOfCanonical({ ...report, implementationHash: null });
  const derivedFiles = new Set(['blind-review/receipts.template.json', 'expected-replay.json', 'review-subject.json']);
  if (manifest.files.length !== previousManifest.files.length) throw new Error('PACKAGE_FILE_SET_CHANGED');
  // Manifest entries are sorted by path, so index alignment identifies what moved.
  const moved = manifest.files.filter((entry, index) => entry.sha256 !== previousManifest.files[index]?.sha256).map((entry) => entry.path);
  // Re-running on an already-rebound branch legitimately moves nothing.
  if (moved.some((name) => !derivedFiles.has(name))) throw new Error(`UNEXPECTED_PACKAGE_MOVEMENT ${moved.join()}`);
  if (executionsHash !== previousExpected.executionsHash) throw new Error('EXECUTIONS_CONTENT_MOVED');
  if (reportRows(replay.report) !== reportRows(previousExpected.report)) throw new Error('REPORT_ROWS_MOVED');
  if (receipts.mappingReview.mappingHash !== previousReceipts.mappingReview.mappingHash) throw new Error('MAPPING_HASH_MOVED');
  const goldHash = (rows) => rows.map((row) => row.goldHash).join();
  if (goldHash(receipts.goldReviews) !== goldHash(previousReceipts.goldReviews)) throw new Error('GOLD_HASH_MOVED');

  refreshAcceptanceDoc(summary);
  if (recordEvidence) writeEvidenceLog(summary, previousExpected);
  delete summary.report;
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await rebindExmV4Freeze({ recordEvidence: process.argv.includes('--record-evidence') })));
}
