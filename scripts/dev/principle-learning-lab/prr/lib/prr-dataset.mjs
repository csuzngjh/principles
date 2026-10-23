// PRI-1002 — PRR A/C dataset loader + health check (B0 §3 / G1).
//
// Loads a PRR-specific task set (three task families AC-T1/T2/T3), a judge-only
// gold file, a scripted-behavior file (offline rehearsal actor) and a
// design-check battery. Everything is FIXTURE_ONLY research tooling inside the
// existing principle-learning-lab; no new platform, no model, no network.
//
// File layout of a dataset directory:
//   dataset-manifest.json  — identity, synthetic flag, caps, file list
//   principles.json        — synthetic principle texts (byte-frozen via hash)
//   tasks.json             — one task per AC-T1/T2/T3 family minimum
//   gold.json              — JUDGE-ONLY: accepted decisions, misapplication
//                            traps, citable evidence, canaries, pre-registered
//                            NOT_APPLICABLE markings. Never shown to the actor.
//   behaviors.json         — scripted actor outputs per `${group}:${taskId}`
//                            (offline rehearsal only; the real A/C runner will
//                            replace this layer with authorized transports)
//   design-checks.json     — calibration battery: adjudicator must reproduce
//                            the frozen expected verdicts exactly (EP-09:
//                            negative controls + production-boundary exercise)
//
// Discipline inherited from lib/fixture.mjs: canonical-JSON fixture hash,
// loud health checks, gold canaries must never appear in actor-visible text.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../../lib/fixture.mjs';

export const PRR_DATASET_SCHEMA = 'prr-ac-dataset.v0.1';
export const PRR_TASK_TYPES = ['AC-T1', 'AC-T2', 'AC-T3'];
export const PRR_GROUPS = ['A', 'C'];
export const BEHAVIOR_STATUS_VALUES = ['OK', 'INVALID_OUTPUT', 'TIMEOUT', 'NO_RESPONSE', 'INTERRUPTED'];
// NOT_APPLICABLE is only legitimate when pre-registered in gold BEFORE the
// freeze (B0 §4.1); the allowlist has exactly one reason.
export const PRR_NA_REASON_ALLOWLIST = ['pre_registered_group_exemption'];

const FILE_ORDER = [
  'dataset-manifest.json',
  'principles.json',
  'tasks.json',
  'gold.json',
  'behaviors.json',
  'design-checks.json',
];

function readJson(dir, rel) {
  const file = path.join(dir, rel);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read dataset file ${rel}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`dataset file ${rel} is not valid JSON: ${error.message}`);
  }
  return parsed;
}

export function computeDatasetHash(byFile) {
  return sha256(FILE_ORDER.map((rel) => sha256(canonicalJson(byFile[rel]))).join('\n'));
}

/**
 * A genuinely read-only Map view (owner review round 4, P1-4). The previous
 * instance-method pinning was bypassable via `Map.prototype.set.call(map,…)`;
 * a Proxy over a never-exposed inner Map closes that path:
 *   - `instanceof Map`, get/has/size/forEach/keys/values/entries all work;
 *   - `map.set/delete/clear` hit the get-trap thrower;
 *   - `Map.prototype.set.call(proxy,…)` cannot reach the inner [[MapData]]
 *     (a Proxy has no Map internal slot → incompatible-receiver TypeError);
 *   - property writes/deletes/defines are trapped, and the inner Map is
 *     never exposed (callbacks only receive values).
 */
function createReadOnlyMapProxy(inner) {
  const MUTATORS = new Set(['set', 'delete', 'clear']);
  return new Proxy(inner, {
    get(target, prop) {
      if (MUTATORS.has(prop)) {
        return () => { throw new TypeError('dataset is frozen: derived index maps cannot be mutated'); };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
    set() { throw new TypeError('dataset is frozen: derived index maps cannot be mutated'); },
    deleteProperty() { throw new TypeError('dataset is frozen: derived index maps cannot be mutated'); },
    defineProperty() { throw new TypeError('dataset is frozen: derived index maps cannot be mutated'); },
  });
}

/**
 * Deeply freeze a loaded dataset (owner review round 3+4, P1-4). Plain
 * objects/arrays are rebuilt frozen; Maps are REBUILT into read-only proxies
 * (see createReadOnlyMapProxy) so no mutable inner Map ever escapes. The
 * WeakMap memo preserves SHARED OBJECT IDENTITY through the transformation —
 * `tasks` and `byFile['tasks.json']` stay the same frozen object, which the
 * integrity check depends on. Depth-bounded; cyclic structures are handled by
 * placeholder memoization.
 */
function freezeDeepAndWrap(value, depth, cache) {
  if (value === null || typeof value !== 'object' || depth > 32) return value;
  if (cache.has(value)) return cache.get(value);
  if (value instanceof Map) {
    const inner = new Map();
    cache.set(value, inner); // placeholder first, for cycle safety
    for (const [k, v] of value.entries()) inner.set(k, freezeDeepAndWrap(v, depth + 1, cache));
    const proxy = createReadOnlyMapProxy(inner);
    cache.set(value, proxy);
    return proxy;
  }
  if (Array.isArray(value)) {
    const arr = value.map((v) => freezeDeepAndWrap(v, depth + 1, cache));
    Object.freeze(arr);
    cache.set(value, arr);
    return arr;
  }
  const out = {};
  cache.set(value, out);
  for (const [k, v] of Object.entries(value)) out[k] = freezeDeepAndWrap(v, depth + 1, cache);
  Object.freeze(out);
  return out;
}

/**
 * Recompute the dataset's canonical hash from its CURRENT contents AND verify
 * that every structure a run actually CONSUMES is the same object as the
 * hashed byFile snapshot (owner review round 3, P1-4).
 *
 * Hashing byFile alone is not sufficient: a cloned/rebuilt dataset (JSON
 * round-trip, structuredClone) breaks the shared references, so mutations to
 * the consumed `tasks`/`gold`/`behaviors` structures would be invisible to a
 * byFile-only hash. The identity checks close that path; the real-run gate
 * refuses unless BOTH the recomputed hash matches the cached one AND every
 * consumed structure is the verified snapshot itself.
 */
const CONSUMED_FILE_FIELDS = [
  ['manifest', 'dataset-manifest.json'],
  ['principles', 'principles.json'],
  ['tasks', 'tasks.json'],
  ['gold', 'gold.json'],
  ['behaviors', 'behaviors.json'],
  ['designChecks', 'design-checks.json'],
];

/**
 * Exact integrity check for one derived index map against its source array:
 * the Map must have EXACTLY the source ids as keys (no missing, no extra, no
 * duplicates via the size check) and every key must map to THE SAME object as
 * in the verified source array (no wrong-value mapping).
 */
function derivedMapMatchesSource(map, sourceArray, idField) {
  if (!(map instanceof Map)) return false;
  if (map.size !== sourceArray.length) return false;
  const ids = new Set();
  for (const entry of sourceArray) {
    const id = entry?.[idField];
    if (typeof id !== 'string' || id === '' || ids.has(id)) return false; // duplicate ids are ambiguous
    ids.add(id);
    if (map.get(id) !== entry) return false;
  }
  for (const key of map.keys()) {
    if (!ids.has(key)) return false; // extra/foreign key
  }
  return true;
}

export function verifyDatasetIntegrity(dataset) {
  const currentHash = computeDatasetHash(dataset.byFile);
  const hashUnchanged = currentHash === dataset.fixtureHash;
  const consumedIdentityShared = CONSUMED_FILE_FIELDS.every(([field, file]) => dataset[field] === dataset.byFile[file]);
  // Owner review round 4, P1-4: the derived indexes must be EXACTLY consistent
  // with the frozen sources — full key coverage, no extra keys, correct size,
  // and per-key object identity. "Every value belongs to the source array" was
  // not sufficient: it tolerated missing keys, swapped mappings and extras.
  const derivedIndexesBound = derivedMapMatchesSource(dataset.tasksById, dataset.tasks?.tasks ?? [], 'taskId')
    && derivedMapMatchesSource(dataset.principlesById, dataset.principles?.principles ?? [], 'principleId')
    && (() => {
      const goldKeys = Object.keys(dataset.gold?.gold ?? {});
      if (goldKeys.length !== Object.keys(dataset.goldByTask ?? {}).length) return false;
      for (const k of goldKeys) {
        if (!Object.hasOwn(dataset.goldByTask, k)) return false; // missing key
        if (dataset.goldByTask[k] !== dataset.gold.gold[k]) return false; // wrong mapping
      }
      for (const k of Object.keys(dataset.goldByTask)) {
        if (!Object.hasOwn(dataset.gold.gold, k)) return false; // extra key
      }
      return true;
    })();
  return {
    ok: hashUnchanged && consumedIdentityShared && derivedIndexesBound,
    cachedHash: dataset.fixtureHash,
    currentHash,
    hashUnchanged,
    consumedIdentityShared,
    derivedIndexesBound,
  };
}

/**
 * Load and lightly structure a PRR A/C dataset directory.
 * Throws loudly on unreadable/malformed files (rc-3); semantic checks live in
 * healthCheck() so callers get one complete problem list.
 */
export function loadPrrDataset(dir) {
  const byFile = {};
  for (const rel of FILE_ORDER) byFile[rel] = readJson(dir, rel);
  const manifest = byFile['dataset-manifest.json'];
  const principles = byFile['principles.json'];
  const tasks = byFile['tasks.json'];
  const gold = byFile['gold.json'];
  const behaviors = byFile['behaviors.json'];
  const designChecks = byFile['design-checks.json'];

  const tasksById = new Map((tasks.tasks ?? []).map((t) => [t.taskId, t]));
  const principlesById = new Map((principles.principles ?? []).map((p) => [p.principleId, p]));
  const goldByTask = gold.gold ?? {};

  // P1-4 (rounds 3+4): the returned structure is deeply frozen AND derived
  // indexes become genuinely read-only proxies — raw file data and derived
  // indexes alike cannot be mutated after loading (directly OR through
  // Map.prototype.*.call), so the hashed snapshot and the consumed data
  // cannot silently diverge.
  return freezeDeepAndWrap({
    dir,
    manifest,
    principles,
    tasks,
    gold,
    behaviors,
    designChecks,
    byFile,
    tasksById,
    principlesById,
    goldByTask,
    fixtureHash: computeDatasetHash(byFile),
  }, 0, new WeakMap());
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Semantic health check. Returns problems[]; empty = the dataset can enter a
 * rehearsal run. Mirrors healthCheck() discipline from lib/fixture.mjs.
 */
export function healthCheckPrrDataset(dataset) {
  const problems = [];
  const p = (msg) => problems.push(msg);
  const { manifest, tasks, principles, gold, behaviors, designChecks } = dataset;

  if (manifest.schemaVersion !== PRR_DATASET_SCHEMA) {
    p(`dataset-manifest.schemaVersion must be ${PRR_DATASET_SCHEMA}`);
  }
  if (manifest.synthetic !== true) p('dataset-manifest must mark synthetic=true (real Owner-frozen task sets are FZ-01 gated, never loaded here)');
  if (typeof manifest.datasetId !== 'string' || manifest.datasetId === '') p('datasetId must be a non-empty string');
  if (typeof manifest.datasetVersion !== 'string' || manifest.datasetVersion === '') p('datasetVersion must be a non-empty string');
  if (!Number.isSafeInteger(manifest.maxRequestsPerTask) || manifest.maxRequestsPerTask < 1) {
    p('manifest.maxRequestsPerTask must be a positive integer (synthetic request cap for AC-S4 rehearsal)');
  }
  if (typeof manifest.cMaterialBudgetChars !== 'number' || manifest.cMaterialBudgetChars < 1) {
    p('manifest.cMaterialBudgetChars must be a positive number (same-channel budget)');
  }

  // Principles: byte-frozen synthetic identity only (NT-06 analog — no
  // fabricated real Ledger identity).
  if (!Array.isArray(principles.principles) || principles.principles.length === 0) {
    p('principles.json must carry a non-empty principles array');
  }
  const seenPrincipleIds = new Set();
  for (const principle of principles.principles ?? []) {
    if (!isPlainObject(principle)) { p('principles entries must be objects'); continue; }
    if (typeof principle.principleId !== 'string' || principle.principleId === '') p('principle.principleId must be a non-empty string');
    if (seenPrincipleIds.has(principle.principleId)) p(`duplicate principleId ${principle.principleId}`);
    seenPrincipleIds.add(principle.principleId);
    if (typeof principle.text !== 'string' || principle.text.length === 0) p(`principle ${principle.principleId} must carry non-empty text`);
    if (principle.principleIdStatus !== 'SYNTHETIC_FIXTURE') {
      p(`principle ${principle.principleId} must carry principleIdStatus=SYNTHETIC_FIXTURE (no fabricated real identity)`);
    }
  }

  // Tasks: three families, independent, decidable, not recycled verbatim from
  // PRI-904/PRI-966 (design-checks encode the discrimination expectations).
  if (!Array.isArray(tasks.tasks) || tasks.tasks.length === 0) p('tasks.json must carry a non-empty tasks array');
  const seenTaskIds = new Set();
  const typeCounts = { 'AC-T1': 0, 'AC-T2': 0, 'AC-T3': 0 };
  for (const task of tasks.tasks ?? []) {
    if (!isPlainObject(task)) { p('tasks entries must be objects'); continue; }
    if (typeof task.taskId !== 'string' || task.taskId === '') p('task.taskId must be a non-empty string');
    if (seenTaskIds.has(task.taskId)) p(`duplicate taskId ${task.taskId}`);
    seenTaskIds.add(task.taskId);
    if (!PRR_TASK_TYPES.includes(task.taskType)) p(`task ${task.taskId} taskType must be one of ${PRR_TASK_TYPES.join('|')}`);
    else typeCounts[task.taskType] += 1;
    if (typeof task.taskText !== 'string' || task.taskText.length === 0) p(`task ${task.taskId} must carry non-empty taskText`);
    if (!seenPrincipleIds.has(task.principleId)) p(`task ${task.taskId} references unknown principle ${task.principleId}`);
    const material = task.historyMaterial;
    if (!isPlainObject(material)) {
      p(`task ${task.taskId} must carry historyMaterial (C-group content)`);
    } else {
      if (typeof material.text !== 'string' || material.text.length === 0) p(`task ${task.taskId} historyMaterial.text must be non-empty`);
      if (material.disclosureStatus !== 'authorized_synthetic' && material.disclosureStatus !== 'unauthorized') {
        p(`task ${task.taskId} historyMaterial.disclosureStatus must be authorized_synthetic|unauthorized`);
      }
      if (typeof material.sourceId !== 'string' || material.sourceId === '') p(`task ${task.taskId} historyMaterial.sourceId must be non-empty`);
    }
    if (Array.isArray(task.dependsOnTaskIds) && task.dependsOnTaskIds.length > 0) {
      p(`task ${task.taskId} declares dependsOnTaskIds — tasks must be independent (B0 §3.2 rule 5)`);
    }
  }
  for (const type of PRR_TASK_TYPES) {
    if (typeCounts[type] < 1) p(`task set must include at least one ${type} task (B0 §3.1 — three families are all mandatory)`);
  }

  // Gold: judge-only; canaries must not leak into any actor-visible text.
  for (const task of tasks.tasks ?? []) {
    const g = dataset.goldByTask[task.taskId];
    if (!isPlainObject(g)) { p(`gold missing for task ${task.taskId}`); continue; }
    for (const field of ['acceptedDecisionIds', 'misapplicationDecisionIds', 'citableEvidenceIds', 'canaryStrings']) {
      if (!Array.isArray(g[field])) p(`gold ${task.taskId}.${field} must be an array`);
      else if (g[field].some((v) => typeof v !== 'string')) p(`gold ${task.taskId}.${field} entries must be strings`);
    }
    if (!Array.isArray(g.acceptableDecisionIds)) p(`gold ${task.taskId}.acceptableDecisionIds must be an array`);
    const overlap = (g.acceptedDecisionIds ?? []).filter((d) => (g.acceptableDecisionIds ?? []).includes(d));
    if (overlap.length > 0) p(`gold ${task.taskId}: ${overlap.join(',')} appear in both accepted and acceptable tiers (ambiguous gold)`);
    if ((g.acceptedDecisionIds ?? []).length === 0 && (g.acceptableDecisionIds ?? []).length === 0) {
      p(`gold ${task.taskId} has no accepted nor acceptable decisions — task is not decidable (B0 §3.2 rule 3)`);
    }
    if (isPlainObject(g.notApplicable)) {
      if (!Array.isArray(g.notApplicable.groups) || g.notApplicable.groups.length === 0) {
        p(`gold ${task.taskId}.notApplicable.groups must be a non-empty array when present`);
      } else {
        for (const grp of g.notApplicable.groups) {
          if (!PRR_GROUPS.includes(grp)) p(`gold ${task.taskId}.notApplicable.groups contains unknown group ${grp}`);
        }
      }
      if (!PRR_NA_REASON_ALLOWLIST.includes(g.notApplicable.reason)) {
        p(`gold ${task.taskId}.notApplicable.reason must be one of ${PRR_NA_REASON_ALLOWLIST.join('|')}`);
      }
    }
    // NT-01 analog: gold canaries must never appear in actor-visible text.
    for (const canary of g.canaryStrings ?? []) {
      const visible = [task.taskText, dataset.principlesById.get(task.principleId)?.text ?? '', task.historyMaterial?.text ?? ''];
      if (visible.some((text) => text.includes(canary))) {
        p(`gold canary '${canary}' leaked into actor-visible text of task ${task.taskId} (NT-01 analog)`);
      }
    }
  }
  for (const taskId of Object.keys(dataset.goldByTask)) {
    if (!dataset.tasksById.has(taskId)) p(`gold carries unknown task ${taskId}`);
  }

  // Behaviors: every (group × task) exactly once; unauthorized C-material
  // tasks must NOT carry a C behavior (they are excluded before exposure).
  if (!isPlainObject(behaviors.behaviors)) p('behaviors.json must carry a behaviors object');
  const expectedKeys = new Set();
  for (const task of tasks.tasks ?? []) {
    expectedKeys.add(`A:${task.taskId}`);
    if (task.historyMaterial?.disclosureStatus === 'unauthorized') continue;
    expectedKeys.add(`C:${task.taskId}`);
  }
  const actualKeys = new Set(Object.keys(behaviors.behaviors ?? {}));
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) p(`behaviors missing entry for ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) p(`behaviors carries unexpected entry ${key}`);
  }
  for (const [key, behavior] of Object.entries(behaviors.behaviors ?? {})) {
    if (!isPlainObject(behavior)) { p(`behavior ${key} must be an object`); continue; }
    if (!BEHAVIOR_STATUS_VALUES.includes(behavior.status)) p(`behavior ${key}.status must be one of ${BEHAVIOR_STATUS_VALUES.join('|')}`);
    if (!isPlainObject(behavior.usage)) p(`behavior ${key} must carry usage (AC-M5/AC-M6 cost layer)`);
    if (behavior.status === 'OK' && !isPlainObject(behavior.output)) {
      p(`behavior ${key} with status OK must carry output (decisionId/evidenceRefs/...)`);
    }
  }

  // Design checks: calibration battery must exist and reference known tasks.
  if (!Array.isArray(designChecks.cases) || designChecks.cases.length === 0) {
    p('design-checks.json must carry a non-empty cases array');
  }
  for (const c of designChecks.cases ?? []) {
    if (!isPlainObject(c)) { p('design-checks entries must be objects'); continue; }
    if (!dataset.tasksById.has(c.taskId)) p(`design-check ${c.caseId} references unknown task ${c.taskId}`);
    if (!PRR_GROUPS.includes(c.group)) p(`design-check ${c.caseId} references unknown group ${c.group}`);
    if (!isPlainObject(c.expect)) p(`design-check ${c.caseId} must carry expect`);
  }

  return problems;
}

/** Actor-visible text for one (group, task) — used for leak scans. */
export function actorVisibleText(dataset, group, taskId) {
  const task = dataset.tasksById.get(taskId);
  if (!task) throw new Error(`actorVisibleText: unknown task ${taskId}`);
  const principle = dataset.principlesById.get(task.principleId);
  const parts = [task.taskText, principle?.text ?? ''];
  if (group === 'C' && task.historyMaterial?.disclosureStatus === 'authorized_synthetic') {
    parts.push(task.historyMaterial.text);
  }
  return parts.join('\n');
}
