import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FeedbackChannelConfig } from '../../../src/server/config/pd-config-store.js';
import {
  probeChannels,
  clearProbeCache,
  type ChannelStatus,
} from '../../../src/server/feedback/channels.js';

const CONFIG: FeedbackChannelConfig = {
  ingestUrl: '',
  ingestToken: 'super-secret-token',
  githubRepo: '',
  githubProxy: '',
};

function byId(channels: ChannelStatus[], id: string): ChannelStatus | undefined {
  return channels.find((c) => c.id === id);
}

beforeEach(() => {
  clearProbeCache();
});

describe('probeChannels', () => {
  it('reports ingest unavailable with nextAction when ingest_url is unset', async () => {
    const r = await probeChannels(CONFIG, {});
    expect(r.ok).toBe(true);
    const ingest = byId(r.channels, 'ingest');
    expect(ingest?.available).toBe(false);
    expect(ingest?.nextAction).toContain('feedback.ingest_url');
  });

  it('reports ingest reachable when ingest_url set and /health responds', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const r = await probeChannels(
      { ...CONFIG, ingestUrl: 'https://example.com/api/feedback' },
      { fetchFn },
    );
    expect(byId(r.channels, 'ingest')?.available).toBe(true);
  });

  it('reports gh unavailable + guidance when repo unset', async () => {
    const r = await probeChannels(CONFIG, {});
    const gh = byId(r.channels, 'github');
    expect(gh?.available).toBe(false);
    expect(gh?.nextAction).toContain('feedback.github_repo');
  });

  it('reports gh available when repo set and gh authed', async () => {
    const execFile = vi.fn(
      (
        _c: string,
        _a: string[],
        _o: unknown,
        cb: (err: Error | null, stdout: string) => void,
      ) => setTimeout(() => cb(null, ''), 0),
    ) as unknown as typeof import('node:child_process').execFile;
    const r = await probeChannels(
      { ...CONFIG, githubRepo: 'x/y' },
      { execFile },
    );
    expect(byId(r.channels, 'github')?.available).toBe(true);
  });

  it('shows email available only for a real maintainer email', async () => {
    const placeholder = await probeChannels(CONFIG, {}, 'maintainer@example.com');
    expect(byId(placeholder.channels, 'email')?.available).toBe(false);

    const real = await probeChannels(CONFIG, {}, 'owner@example.com');
    expect(byId(real.channels, 'email')?.available).toBe(true);
  });

  it('file channel is always available (offline export)', async () => {
    const r = await probeChannels(CONFIG, {});
    expect(byId(r.channels, 'file')?.available).toBe(true);
  });

  it('never leaks the ingest token into the channels payload', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 }));
    const r = await probeChannels(
      { ...CONFIG, ingestUrl: 'https://x/api/feedback' },
      { fetchFn },
    );
    const serialized = JSON.stringify(r.channels);
    expect(serialized).not.toContain('super-secret-token');
  });
});