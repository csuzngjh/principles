// SPEC-PD-EXAMINER-001 v0.4 / PRI-1037 real-host probe + F2 (Owner S3, 2026-10-28)
// — the ZHIPU host-provider adapter for the Codex CLI host transport.
//
// What this module proves offline (zero spawns, zero model calls):
//   - the ONLY approved host channel is mapped in ONE place: Zhipu BigModel
//     Coding Plan, OpenAI-Chat wire (`wire_api = "chat"` → POST
//     {base_url}/chat/completions, Bearer env key) — the same endpoint/model/
//     key source the repo's F1-direct transport already exercised across
//     CEB-002 (298 real requests) and CEB-003-P (291 real requests), with
//     server-observed identity `glm-5.3-flash` every round;
//   - codex-cli 0.165.0 supports the required provider schema
//     (`model_providers.<id>` with base_url/env_key/wire_api — verified
//     against the installed binary, not assumed from docs);
//   - fail-closed key resolution: no key in env AND no key file ⇒ the probe
//     runner refuses BEFORE any transport construction (the CLI would fail
//     at its env_key lookup otherwise — we refuse earlier, loudly, and
//     without ever printing the key value).
//
// Honest boundary (NOT claimed offline): GLM-5.3-flash's runtime behavior
// inside the codex exec tool-loop (tool-call conformance, JSON discipline)
// is proven ONLY by the Owner-authorized real probe round — that is exactly
// what the probe exists to test. Identity evidence for the host path is the
// CLI's own event stream + rollout corroboration (the project's trusted
// sources per the PRI-1037 contract); unlike F1-direct there is no
// response-body model echo, and this module never claims server attestation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ZHIPU_HOST_PROVIDER_ID = 'zhipu-coding';
export const ZHIPU_CODING_PROVIDER = Object.freeze({
  id: ZHIPU_HOST_PROVIDER_ID,
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', // same endpoint the F1 transport proved (challenge-amd-transport.mjs BIGMODEL_CODING_*)
  modelId: 'glm-5.3-flash',
  envKey: 'BIGMODEL_CODING_API_KEY',
  wireApi: 'chat', // OpenAI Chat Completions — codex appends /chat/completions to base_url
  keyFile: path.join(os.homedir(), '.bigmodel_coding_api_key'), // same source as F1 (challenge-amd-transport.mjs)
});

/** Codex CLI `-c` overrides that define the provider (per-spawn; the owner's
 *  ~/.codex/config.toml is NOT modified). Order-stable for test pinning. */
export function buildZhipuCodexOverrides(p = ZHIPU_CODING_PROVIDER) {
  return [
    '-c', `model_provider=${p.id}`,
    '-c', `model_providers.${p.id}.name=Zhipu BigModel Coding Plan`,
    '-c', `model_providers.${p.id}.base_url=${p.baseUrl}`,
    '-c', `model_providers.${p.id}.env_key=${p.envKey}`,
    '-c', `model_providers.${p.id}.wire_api=${p.wireApi}`,
  ];
}

/** Resolve the API key WITHOUT ever returning or logging its value for
 *  non-spawn use: returns { ready: true } (caller injects process.env) or
 *  { ready: false, reason } for a fail-closed refusal. */
export function ensureZhipuProviderReady({ env = process.env, keyFile = ZHIPU_CODING_PROVIDER.keyFile } = {}) {
  if (typeof env[ZHIPU_CODING_PROVIDER.envKey] === 'string' && env[ZHIPU_CODING_PROVIDER.envKey].length > 0) {
    return { ready: true, source: `env:${ZHIPU_CODING_PROVIDER.envKey}` };
  }
  try {
    if (fs.existsSync(keyFile)) {
      const v = fs.readFileSync(keyFile, 'utf8').trim();
      if (v.length > 0) {
        // export into the runner env so the spawned codex CLI (which inherits
        // process.env) can resolve env_key — value never printed anywhere
        process.env[ZHIPU_CODING_PROVIDER.envKey] = v;
        return { ready: true, source: `file:${keyFile}` };
      }
      return { ready: false, reason: `key file exists but is empty: ${keyFile}` };
    }
  } catch (e) {
    return { ready: false, reason: `key file unreadable: ${e.message}` };
  }
  return { ready: false, reason: `no ${ZHIPU_CODING_PROVIDER.envKey} in env and no key file at ${keyFile} — refusing BEFORE transport construction (fail-closed; the approved channel's credential source is the F1 one)` };
}
