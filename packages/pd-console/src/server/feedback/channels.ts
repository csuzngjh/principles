// channels.ts
// Channel-ladder availability probing for feedback submission (PRI-543).
//
// Spec §4 / §8.1: the UI orders channels by ladder position and disables
// unavailable ones, showing reason + nextAction (rc-9). Probing is fail-open:
// inability to probe is reported as available so a transient probe failure
// never hides a channel; the submit path then fails loudly and surfaces a
// structured reason + downgrade hint.
//
// Probing results are cached per (channel,url-or-repo) for 60s to avoid
// hammering the relay /shelling out to gh on every list/via fetch.
import type { FeedbackChannelStatus } from '../../shared/feedback-contract.js';

import type * as childProcessNS from 'node:child_process';
import type * as fsNS from 'node:fs';
import type * as osNS from 'node:os';
import type * as pathNS from 'node:path';
import type { FeedbackChannelConfig } from '../config/pd-config-store.js';
import { probeIngestHealth } from './ingest-adapter.js';
import { detectGithubCli } from './github-adapter.js';

type ExecFileFn = typeof childProcessNS.execFile;

// PRI-613: the channel-status wire contract derives from the shared
// Schema→Static authority (src/shared/feedback-contract.ts). The server builds
// it; the UI validates against the same schema — drift is CI-detectable.
export type ChannelStatus = FeedbackChannelStatus;

export interface ChannelsResult {
  ok: true;
  channels: ChannelStatus[];
}

const PROBE_CACHE_TTL_MS = 60_000;

interface ProbeCacheEntry {
  available: boolean;
  reason?: string;
  nextAction?: string;
  at: number;
}

const probeCache = new Map<string, ProbeCacheEntry>();

function cachedOrCompute(key: string, compute: () => Promise<ProbeCacheEntry>): Promise<ProbeCacheEntry> {
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) {
    return Promise.resolve(hit);
  }
  return compute().then((entry) => {
    probeCache.set(key, entry);
    return entry;
  });
}

export function clearProbeCache(): void {
  probeCache.clear();
}

export type ChannelDeps = {
  fs?: typeof fsNS;
  os?: typeof osNS;
  path?: typeof pathNS;
  execFile?: ExecFileFn;
  fetchFn?: typeof fetch;
  probeTimeoutMs?: number;
};

/**
 * Build the full channel ladder status for a workspace.
 * `maintainerEmail` is supplied by the caller (already computed from config).
 * `featureFlagEnabled` gates the whole submit area (spec §12: flag off hides it
 * and the endpoint 403s); channels still probe but the caller may drop the
 * area entirely when the flag is off.
 */
export async function probeChannels(
  config: FeedbackChannelConfig,
  deps: ChannelDeps,
  maintainerEmail = '',
): Promise<ChannelsResult> {
  const channels: ChannelStatus[] = [];

  // 1. ingest — present iff ingest_url is configured; live-probed against /health.
  if (config.ingestUrl.length === 0) {
    channels.push({
      id: 'ingest',
      available: false,
      reason: 'ingest 通道未配置',
      nextAction: '在 .pd/config.yaml 配置 feedback.ingest_url 后重启 console',
    });
  } else {
    const entry = await cachedOrCompute(`ingest:${config.ingestUrl}`, () =>
      probeIngestHealth(config.ingestUrl, { fetchFn: deps.fetchFn, timeoutMs: deps.probeTimeoutMs }).then((r) => ({
        available: r.available,
        reason: r.reason,
        nextAction: r.nextAction,
        at: Date.now(),
      })),
    );
    channels.push({ id: 'ingest', available: entry.available, reason: entry.reason, nextAction: entry.nextAction });
  }

  // 2. github — present iff github_repo configured; gh CLI must exist + be authed.
  if (config.githubRepo.length === 0) {
    channels.push({
      id: 'github',
      available: false,
      reason: 'gh 通道未配置',
      nextAction: '在 .pd/config.yaml 配置 feedback.github_repo 后重启 console',
    });
  } else {
    const entry = await cachedOrCompute(`github:${config.githubRepo}`, () =>
      detectGithubCli(deps).then((r) => ({
        available: r.available,
        reason: r.reason,
        nextAction: r.nextAction,
        at: Date.now(),
      })),
    );
    channels.push({ id: 'github', available: entry.available, reason: entry.reason, nextAction: entry.nextAction });
  }

  // 3. email — always depends on a real maintainer email (never the placeholder).
  if (maintainerEmail.length === 0 || maintainerEmail === 'maintainer@example.com') {
    channels.push({
      id: 'email',
      available: false,
      reason: '维护者邮箱未配置',
      nextAction: '在 .pd/config.yaml 设置 feedback.maintainer_email 后重启 console',
    });
  } else {
    channels.push({ id: 'email', available: true });
  }

  // 4. file — always available (offline export).
  channels.push({ id: 'file', available: true });

  return { ok: true, channels };
}