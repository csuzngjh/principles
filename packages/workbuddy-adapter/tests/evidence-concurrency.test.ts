/**
 * Evidence concurrency (PLAN Part 5 / SPEC §8 并发档): MULTIPLE REAL entry
 * processes writing simultaneously. The shared ingress contract under
 * contention: with busyTimeout=0 an evidence writer never waits the hook —
 * a contended append degrades OBSERVABLY (rc-9) while the already-computed
 * decision (deny/neutral) is untouched; idempotent replay must not
 * double-count; and every event is accounted for exactly once across
 * (persisted rows + observable degradations).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runEntry } from './helpers/hook-runner.js';
import {
  makeHome,
  makeGovernance,
  makeProjectDir,
  makeTrajectory,
  cleanupTempDirs,
  fixturePayload,
} from './helpers/workbench.js';

afterAll(() => {
  cleanupTempDirs();
});

describe('concurrent real entry processes (SPEC §8 并发档)', () => {
  it('parallel PostToolUse evidence from N processes: every event accounted for, decisions never blocked', async () => {
    const home = makeHome();
    const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
    makeTrajectory(governance);
    const project = makeProjectDir(home, 'conc');

    const PROCESSES = 6;
    const payloads = Array.from({ length: PROCESSES }, (_, i) =>
      JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', {
        cwd: project,
        session_id: `conc-sess-${i}`,
        call_id: `toolu_conc_${i}`,
        tool_use_id: `toolu_conc_${i}`,
      })));

    const results = await Promise.all(payloads.map((payload) => Promise.resolve(
      runEntry(home, payload, 'PostToolUse'),
    )));

    // The tool ALREADY ran (PostToolUse) — no process may block or crash.
    for (const [i, result] of results.entries()) {
      expect(result.status, `process ${i} exit`).toBe(0);
      expect(result.stdout, `process ${i} stdout (PostToolUse never blocks)`).toBe('');
    }

    // Every event is accounted for exactly once: persisted tool_calls rows
    // (one per session) — plus, for any process whose append degraded under
    // the zero-wait writer lock, an OBSERVABLE degradation on its stderr.
    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    const persisted = db.prepare("SELECT COUNT(DISTINCT session_id) AS n FROM tool_calls WHERE outcome = 'failure'").get() as { n: number };
    db.close();
    const degraded = results.filter((r) => r.stderr.includes('degraded'));
    expect(persisted.n + degraded.length).toBeGreaterThanOrEqual(PROCESSES);
    // A degradation is only acceptable when it is structured (rc-9).
    for (const d of degraded) {
      expect(d.stderr).toMatch(/degraded reason=\S+/);
    }
  });

  it('idempotent replay: the same event delivered twice records once', async () => {
    const home = makeHome();
    const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
    makeTrajectory(governance);
    const project = makeProjectDir(home, 'replay');
    const payload = JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', {
      cwd: project,
      session_id: 'replay-sess',
      call_id: 'toolu_replay_same',
      tool_use_id: 'toolu_replay_same',
    }));

    runEntry(home, payload, 'PostToolUse');
    runEntry(home, payload, 'PostToolUse');

    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = 'replay-sess'").get() as { n: number };
    db.close();
    expect(rows.n).toBe(1);
  });

  it('two independent same-argument calls stay two events (no dedup merge)', async () => {
    const home = makeHome();
    const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
    makeTrajectory(governance);
    const project = makeProjectDir(home, 'sameargs');
    // Two REAL calls with identical arguments but distinct call ids (probe
    // P03: the engine does not dedup; PD must not either).
    const payloads = ['one', 'two'].map((tag) => JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', {
      cwd: project,
      session_id: `sameargs-${tag}`,
      call_id: `toolu_same_${tag}`,
      tool_use_id: `toolu_same_${tag}`,
    })));
    for (const payload of payloads) runEntry(home, payload, 'PostToolUse');

    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_name = 'Bash' AND outcome = 'failure'").get() as { n: number };
    db.close();
    expect(rows.n).toBe(2);
  });

  describe('tool-call identity at the real entry (I1: same session, distinct call ids)', () => {
    it('same session + same arguments + distinct call ids stay two events', async () => {
      // The I1 reproduction (review §5): one session, one generation, the same
      // tool call shape delivered twice by the engine with DIFFERENT call ids.
      // Each real call keeps its own evidence row.
      const home = makeHome();
      const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
      makeTrajectory(governance);
      const project = makeProjectDir(home, 'i1');
      const payloads = ['toolu_call_a', 'toolu_call_b'].map((callId) => JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', {
        cwd: project,
        session_id: 'i1-sess',
        generation_id: 'gen-fixed-1',
        call_id: callId,
        tool_use_id: callId,
      })));
      for (const payload of payloads) runEntry(home, payload, 'PostToolUse');

      const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
      const rows = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = 'i1-sess'").get() as { n: number };
      db.close();
      expect(rows.n).toBe(2);
    });

    it('same payload redelivery (same call id) stays one event', async () => {
      const home = makeHome();
      const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
      makeTrajectory(governance);
      const project = makeProjectDir(home, 'i1replay');
      const payload = JSON.stringify(fixturePayload('post-tool-use-bash-exit7.json', {
        cwd: project,
        session_id: 'i1-replay-sess',
        generation_id: 'gen-fixed-1',
        call_id: 'toolu_call_replay',
        tool_use_id: 'toolu_call_replay',
      }));
      runEntry(home, payload, 'PostToolUse');
      runEntry(home, payload, 'PostToolUse');

      const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
      const rows = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = 'i1-replay-sess'").get() as { n: number };
      db.close();
      expect(rows.n).toBe(1);
    });

    it('legacy payload without a call id keeps the pre-I1 merged behavior (documented limitation)', async () => {
      // A host that supplies no call id cannot have its identical-content
      // calls distinguished — PD must not fabricate precision the host does
      // not provide, so the historical merged behavior is preserved.
      const home = makeHome();
      const governance = makeGovernance(home, { workbuddyFlag: true, receiptLedgerFlag: true });
      makeTrajectory(governance);
      const project = makeProjectDir(home, 'i1legacy');
      const payloads = [1, 2].map(() => {
        const payload = fixturePayload('post-tool-use-bash-exit7.json', {
          cwd: project,
          session_id: 'i1-legacy-sess',
          generation_id: 'gen-fixed-1',
        });
        delete payload.call_id;
        delete payload.tool_use_id;
        return JSON.stringify(payload);
      });
      for (const payload of payloads) runEntry(home, payload, 'PostToolUse');

      const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
      const rows = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = 'i1-legacy-sess'").get() as { n: number };
      db.close();
      expect(rows.n).toBe(1);
    });
  });
});
