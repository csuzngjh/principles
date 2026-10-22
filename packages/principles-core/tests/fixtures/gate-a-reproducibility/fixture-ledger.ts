/**
 * Gate A fixture — readLedgerFileState / parseHybridLedger / identity resolver.
 * Freshness replay (PRI-1000, 2026-10-18): verbatim copy of the 2026-10-17
 * Gate A fixture; only the mirror provenance below changed. Assertions unchanged.
 * Source of truth: git archive of origin/main f2539e07ee0f4d2353c5e3897da81b6ef3b787ca
 * under ../core-mirror/packages/principles-core/src. Synthetic data only.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLedgerFileState, loadLedger } from '../core-mirror/packages/principles-core/src/principle-tree-ledger.ts';
import {
  resolveLedgerActivationId,
  candidateIdFromDreamerTaskId,
} from '../core-mirror/packages/principles-core/src/runtime-v2/activation/ledger-identity.ts';

const results: { name: string; expect: string; actual: string; pass: boolean }[] = [];
function record(name: string, expect: string, actual: string) {
  results.push({ name, expect, actual, pass: expect === actual });
}

// ── readLedgerFileState availability semantics (SPEC F-03/F-04) ──
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-gate-a-ledger-'));
const ledgerPath = path.join(stateDir, 'principle_training_state.json');

// discover the real ledger filename used by getLedgerFilePath
// (call with stateDir and list what file appears after a write via loadLedger?)
// readLedgerFileState does not create files; probe both candidate names.
const probeMissing = readLedgerFileState(stateDir);
record('missing dir/missing file -> availability', 'empty', String(probeMissing.availability.status));

// valid, non-empty ledger
fs.mkdirSync(stateDir, { recursive: true });
const validLedger = JSON.stringify({
  tree: {
    principles: {
      'p-1': {
        id: 'p-1',
        title: 'T',
        status: 'active',
        derivedFromPainIds: ['cand-1'],
        reuseEvidence: [],
      },
    },
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: '2026-01-01T00:00:00.000Z',
  },
  trainingStore: {},
});
fs.writeFileSync(ledgerPath, validLedger, 'utf-8');
const probeOk = readLedgerFileState(stateDir);
record('valid JSON ledger -> availability', 'ok', String(probeOk.availability.status));
const viaLoad = loadLedger(stateDir);
record('loadLedger() drops availability (returns store regardless)', JSON.stringify(Object.hasOwn(probeOk, 'ledger')), String(Object.keys(viaLoad).includes('tree') || Object.keys(viaLoad).includes('trainingStore')));

// zero-byte / whitespace-only file -> empty (F-03: cannot distinguish from missing via this API alone)
fs.writeFileSync(ledgerPath, '', 'utf-8');
const probeBlank = readLedgerFileState(stateDir);
record('zero-byte file -> availability', 'empty', String(probeBlank.availability.status));
fs.writeFileSync(ledgerPath, '   \n  ', 'utf-8');
const probeWs = readLedgerFileState(stateDir);
record('whitespace-only file -> availability', 'empty', String(probeWs.availability.status));

// syntactically invalid JSON -> unreadable
fs.writeFileSync(ledgerPath, '{"tree": nope', 'utf-8');
const probeBad = readLedgerFileState(stateDir);
record('invalid JSON -> availability', 'unreadable', String(probeBad.availability.status));

// syntactically VALID but structurally wrong -> parseHybridLedger leniency (F-04)
const structurallyWrong = ['[]', '"just a string"', '12345', 'null'];
const wrongAsStatuses = structurallyWrong.map((content) => {
  fs.writeFileSync(ledgerPath, content, 'utf-8');
  return readLedgerFileState(stateDir).availability.status;
});
record('F-04 all structurally-wrong-but-valid JSON -> availability', JSON.stringify(['ok', 'ok', 'ok', 'ok']), JSON.stringify(wrongAsStatuses));

// dirs permission check skipped: unreadable covers parse error only on Windows; access-denied stays documented semantics.

(async () => {
// ── identity resolver ambiguity / refusal semantics ──
const artifact = {
  artifactId: 'art-1',
  artifactKind: 'dreamer',
  contentJson: '{}',
  validationStatus: 'approved',
} as never;

// 1: direct stamped UUID-shaped id present in ledger -> resolved
const PRINCIPLE_UUID = 'a1a1a1a1-1111-4222-8333-c44444444444';
const depsDirect = {
  ledger: { isAvailable: () => true, hasPrinciple: (id: string) => id === PRINCIPLE_UUID, listForCandidate: () => [] },
  getArtifactById: async () => null,
};
// direct stamped id field is `sourcePrincipleId` (low-risk-writers.ts:92)
const r1 = await resolveLedgerActivationId(
  { ...artifact, sourcePrincipleId: PRINCIPLE_UUID } as never,
  depsDirect as never,
);
record('direct stamped UUID + ledger member -> resolved', `resolved:${PRINCIPLE_UUID}`, `${r1.status}:${r1.status === 'resolved' ? r1.principleId : r1.reason}`);

// 2: direct stamped id NOT in ledger -> refused, no lineage guess
const r2 = await resolveLedgerActivationId({ ...artifact, sourcePrincipleId: 'a1a1a1a1-1111-4222-8333-cfffffffffff' } as never, depsDirect as never);
record('direct stamped absent in ledger -> unresolved:principle_not_in_ledger', 'unresolved:principle_not_in_ledger', `${r2.status}:${(r2.status === 'unresolved' ? r2.reason.split(':')[0].trim() : '')}`);
// note: actual reason carries the principle id suffix; behavior = refusal, no lineage fallback

// 3/4: the outer artifact must carry a dreamer lineage reference
// (readDreamerArtifactId: sourceTrace.dreamerArtifactId or lineageArtifactIds containing '-dreamer-')
const artifactWithLineage = {
  ...artifact,
  lineageArtifactIds: ['x-dreamer-dream-1'],
} as never;

// 3: candidate maps to 2 ledger principles -> refuse to guess
const depsAmbig = {
  ledger: {
    isAvailable: () => true,
    hasPrinciple: () => false,
    listForCandidate: () => [{ id: 'p-a' }, { id: 'p-b' }],
  },
  getArtifactById: async (id: string) => ({ artifactId: 'dream-1', artifactKind: 'dreamer', contentJson: '{}', validationStatus: 'approved', sourceTaskId: 'dreamer-11111111-2222-3333-4444-555555555555-codex' } as never),
  getTaskDiagnosticJson: async () => null,
};
const r3 = await resolveLedgerActivationId(artifactWithLineage, depsAmbig as never);
record('candidate maps to 2 ledger principles -> unresolved (no guess)', 'unresolved', String(r3.status));

// 4: candidate maps to exactly 1 -> resolved via lineage
const depsOne = { ...depsAmbig, ledger: { ...depsAmbig.ledger, listForCandidate: () => [{ id: 'p-only' }] } };
const r4 = await resolveLedgerActivationId(artifactWithLineage, depsOne as never);
record('candidate maps to 1 ledger principle -> resolved', 'resolved:p-only', `${r4.status}:${r4.status === 'resolved' ? r4.principleId : r4.reason}`);

// 5: ledger unavailable while stamped direct id -> ledger_unavailable
const depsUnavail = { ...depsDirect, ledger: { ...depsDirect.ledger, isAvailable: () => false } };
const r5 = await resolveLedgerActivationId({ ...artifact, sourcePrincipleId: PRINCIPLE_UUID } as never, depsUnavail as never);
const r5reason = r5.status === 'unresolved' ? r5.reason : '';
record('unreadable ledger + stamped id -> ledger_unavailable', 'ledger_unavailable', r5reason.startsWith('ledger_unavailable') ? 'ledger_unavailable' : r5reason);

// 6: dreamer task id spelling fallback
record('candidateIdFromDreamerTaskId legacy naming', '11111111-2222-3333-4444-555555555555', String(candidateIdFromDreamerTaskId('dreamer-11111111-2222-3333-4444-555555555555-codex')));

fs.rmSync(stateDir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2));
})();
