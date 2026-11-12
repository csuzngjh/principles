// PRI-1182 preflight-only fake Decisions endpoint.
//
// Installed as a Node ESM preload (`node --import ...`), so the REAL compiled
// hook subprocess keeps its own config, transport and deadlines; only the
// network is replaced. Any request that is not the Decisions endpoint throws,
// which makes "preflight used zero real requests" a property of the harness
// rather than a promise.
import fs from 'node:fs';

const scores = JSON.parse(process.env.PD_FAKE_SCORES ?? '{}');
const countFile = process.env.PD_FAKE_COUNT_FILE;
const model = process.env.PD_FAKE_MODEL ?? 'respan/span-01-lite-20260925';
const provider = process.env.PD_FAKE_PROVIDER ?? 'Respan';
const bodyDelayMs = Number(process.env.PD_FAKE_BODY_DELAY_MS ?? '0');
const realFetch = globalThis.fetch;

const urlOf = (resource) => {
  if (typeof resource === 'string') return resource;
  if (resource instanceof URL) return resource.toString();
  return resource?.url ?? '';
};

globalThis.fetch = async (resource, init) => {
  const url = urlOf(resource);
  if (!url.includes('/decisions')) {
    throw new Error(`preflight fake endpoint refused a non-Decisions request: ${url}`);
  }
  if (countFile) fs.appendFileSync(countFile, `${Date.now()}\n`);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const ids = Object.keys(body.questions ?? {});
  if (process.env.PD_FAKE_QUESTION_LOG) {
    // Evidence for "one POST, and exactly which conditions went out".
    fs.appendFileSync(process.env.PD_FAKE_QUESTION_LOG, `${JSON.stringify({ids})}\n`);
  }
  const answers = {};
  for (const id of ids) {
    const key = id.startsWith('candidate_') ? id.slice('candidate_'.length) : id;
    // v3 replaceable candidates answer `<ref>_value` and `<ref>_safety`, and the
    // frozen manifest records both under one object. Append candidates and the
    // v1/v2 manifests keep a single numeric entry.
    const base = key.replace(/_(value|safety)$/u, '');
    const entry = scores[base];
    const noul = typeof entry === 'object' && entry !== null
      ? (key.endsWith('_safety') ? entry.safety : entry.value)
      : scores[key];
    answers[id] = {type: 'noul', noul: noul ?? 0.02};
  }
  const payload = JSON.stringify({model, ...(provider ? {provider} : {}), answers});
  if (bodyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, bodyDelayMs));
  return new Response(payload, {status: 200, headers: {'Content-Type': 'application/json'}});
};

void realFetch;
