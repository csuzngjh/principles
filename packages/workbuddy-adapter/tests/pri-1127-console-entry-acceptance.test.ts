/**
 * PRI-1127 — WorkBuddy product entry acceptance.
 *
 * Deliberately NOT a cross-model / cross-task matrix: ONE same-turn append
 * positive and ONE off control, both on the EXISTING isolated WorkBuddy hook
 * path (real built entry process + real governance workspace + the local
 * decision-request receiver used by the production-path suite).
 *
 * What this proves:
 *  - the positive turn issues exactly ONE independent decision request, targets
 *    exactly one principle, keeps the Native items and their order, and records
 *    an `adaptive` fact on the SAME injection event the Console reads, keyed by
 *    the host-supplied generation_id (never a session id or turn ordinal);
 *  - the off control issues ZERO requests and its prompt body is BYTE-IDENTICAL
 *    to the Native baseline (no adaptive fact is fabricated for that turn).
 *
 * GUI delivery is intentionally NOT claimed here — it is confirmed by the
 * independent model-request evidence captured by the isolated engine run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { escapeXml } from '@principles/core/prompt-builder';
import { readPromptActivationCandidates } from '@principles/host-runtime';
import { getDefaultPdConfig, renderPrinciplesToDirectives } from '@principles/core/runtime';
import { runEntry } from './helpers/hook-runner.js';
import {
  activationArtifact,
  cleanupTempDirs,
  fixturePayload,
  makeGovernance,
  makeHome,
  makeProjectDir,
} from './helpers/workbench.js';

afterAll(() => { cleanupTempDirs(); });

const NATIVE_ID = 'WB_NATIVE_SCOPE';
const TARGET_ID = 'WB_GAP_DELIVERY';
/** Host-supplied current-turn identity, carried by UserPromptSubmit.generation_id. */
const GENERATION_ID = '01a1d4c0f7a54b0e9d2c8a6f3b5e7012';
const ENDPOINT = 'https://decisions.test/alpha/decisions';

interface Fixture { home: string; governance: string; project: string; config: ReturnType<typeof getDefaultPdConfig> }

async function prepare(): Promise<Fixture> {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: true });
  for (const [id, text] of [
    ['WB_SCOPE', NATIVE_ID],
    ['WB_BIG', 'Oversized context '.repeat(240)],
    ['WB_DELIVERY', TARGET_ID],
  ] as const) {
    await activationArtifact(governance, {
      id, kind: 'principle', principleId: id, content: { principleId: id, text },
      channel: 'prompt', action: 'prompt_activate', target: `ledger://${id}`,
    });
  }
  const snapshot = await readPromptActivationCandidates({ workspaceDir: governance, includeAuthority: true });
  const withoutBig = snapshot.principles.filter((p) => p.principleId !== 'WB_BIG');
  const charsWithoutBig = renderPrinciplesToDirectives(
    withoutBig,
    new Set(withoutBig.map((p) => p.principleId)),
    { escapeFn: escapeXml, selfReportInstruction: snapshot.selfReportEnabled },
  ).length;
  const config = getDefaultPdConfig();
  config.features['host.workbuddy'].enabled = true;
  config.promptBudget = { hosts: { workbuddy: (charsWithoutBig + 10) * 32 } };
  return { home, governance, project: makeProjectDir(home, 'pri1127'), config };
}

function writeConfig(fixture: Fixture, mutate: (config: Fixture['config']) => void): void {
  const config = JSON.parse(JSON.stringify(fixture.config)) as Fixture['config'];
  mutate(config);
  fs.writeFileSync(path.join(fixture.governance, '.pd', 'config.yaml'), JSON.stringify(config));
}

/** The local decision-request receiver: one line per REAL outbound request. */
const options = {
  env: { PD_WB_ADAPTIVE_TEST: 'fake' },
  childPrelude: `globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const state = JSON.parse(body.state);
    const candidate = state.candidates.find(item => item.text.includes('WB_GAP_DELIVERY'));
    if (url !== 'https://decisions.test/alpha/decisions' || !candidate
        || state.candidates.some(item => item.text.includes('WB_NATIVE_SCOPE'))) {
      throw new Error('wrong Native gap');
    }
    process.stderr.write('fixture-fetch-called\\n');
    const targetId = 'candidate_' + candidate.ref;
    return Response.json({model: 'fixture-model', answers: Object.fromEntries(
      Object.keys(body.questions).map(key => [key, {
        type: 'noul',
        noul: key === targetId || key === targetId + '_value' || key === targetId + '_safety' ? 0.97 : 0.01,
      }])
    )});
  };`,
};

function requestCount(stderr: string): number {
  return stderr.split(/\r?\n/).filter((line) => line === 'fixture-fetch-called').length;
}

function contextOf(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

interface InjectedLine {
  ts?: string;
  type?: string;
  data: {
    hostKind?: string;
    workspaceDir?: string;
    runId?: string;
    activationIds?: string[];
    adaptive?: { resultCode?: string; scored?: boolean; appendedActivationId?: string };
  };
}

function injectedLines(governance: string): InjectedLine[] {
  const logs = path.join(governance, '.state', 'logs');
  if (!fs.existsSync(logs)) return [];
  const lines: InjectedLine[] = [];
  for (const name of fs.readdirSync(logs).filter((n) => n.startsWith('events_') && n.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(logs, name), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as InjectedLine;
      if (parsed.type === 'runtime_v2_prompt_activations_injected') lines.push(parsed);
    }
  }
  return lines;
}

describe('PRI-1127 WorkBuddy product entry — one append positive + one off control', () => {
  it('appends exactly once in the same turn and keeps Native byte-identical when off', async () => {
    const fixture = await prepare();
    const payload = fixturePayload('user-prompt-submit.json', {
      cwd: fixture.project,
      generation_id: GENERATION_ID,
      prompt: 'Please verify delivery',
    });
    const stdin = JSON.stringify(payload);
    const service = {
      endpoint: ENDPOINT,
      model: 'fixture-model',
      apiKeyEnv: 'PD_WB_ADAPTIVE_TEST',
    };

    // 0) Native reference: no Adaptive section at all. This is the byte-level
    //    baseline, not an experiment arm.
    writeConfig(fixture, (config) => { Reflect.deleteProperty(config, 'adaptiveActivation'); });
    const native = runEntry(fixture.home, stdin, 'UserPromptSubmit', options);

    // 1) Off control: the SAME service config, but the WorkBuddy AA switch off.
    writeConfig(fixture, (config) => {
      config.features['host.workbuddy.adaptive_activation'].enabled = false;
      config.adaptiveActivation = { ...service };
    });
    const off = runEntry(fixture.home, stdin, 'UserPromptSubmit', options);

    // 2) Append positive: the same turn, switch on, host-supplied generation_id.
    writeConfig(fixture, (config) => {
      config.features['host.workbuddy.adaptive_activation'].enabled = true;
      config.adaptiveActivation = { ...service };
    });
    const on = runEntry(fixture.home, stdin, 'UserPromptSubmit', options);

    // ── Off control ────────────────────────────────────────────────────────
    expect(requestCount(off.stderr)).toBe(0);
    expect(requestCount(native.stderr)).toBe(0);
    expect(off.stdout).toBe(native.stdout); // byte-identical to Native
    expect(contextOf(off.stdout)).not.toContain(TARGET_ID);
    expect(contextOf(off.stdout)).toContain(NATIVE_ID);

    // ── Append positive ────────────────────────────────────────────────────
    expect(requestCount(on.stderr)).toBe(1);
    const onContext = contextOf(on.stdout);
    const nativeContext = contextOf(native.stdout);
    const directiveIds = (context: string): string[] =>
      [...context.matchAll(/<directive id="([^"]+)"/g)].map((match) => match[1]!);
    const nativeIds = directiveIds(nativeContext);
    const onIds = directiveIds(onContext);
    expect(onContext.split(TARGET_ID).length - 1).toBe(1);   // target exactly once
    expect(nativeIds).toEqual(['WB_SCOPE']);
    expect(onIds).toEqual([...nativeIds, 'WB_DELIVERY']);    // original order kept, one append
    expect(onContext.indexOf(NATIVE_ID)).toBeLessThan(onContext.indexOf(TARGET_ID));
    expect(onContext).not.toContain('Oversized context');    // budget-filtered candidate

    // ── Same injection event the Console reads ─────────────────────────────
    const lines = injectedLines(fixture.governance);
    const withFact = lines.filter((line) => line.data.adaptive !== undefined);
    expect(withFact).toHaveLength(1); // off/native turns fabricate NO adaptive fact
    const fact = withFact[0]!.data;
    expect(fact.hostKind).toBe('workbuddy');
    expect(fact.workspaceDir).toBe(fixture.governance);
    expect(fact.runId).toBe(GENERATION_ID);               // same-turn identity
    expect(fact.adaptive?.scored).toBe(true);             // independent request evidence
    expect(fact.adaptive?.appendedActivationId).toBe('act-WB_DELIVERY');
    expect(fact.activationIds?.filter((id) => id === 'act-WB_DELIVERY')).toHaveLength(1);
    expect(fact.activationIds?.[0]).toBe('act-WB_SCOPE'); // original item stays first
  }, 60000);
});
