/**
 * Process-entry contract tests (SPEC §4.4 / OD-01, frozen by probe P02):
 * REAL spawned entry processes with real stdin/stdout/exit codes.
 *
 * P02-verified exit-code semantics asserted here:
 *   - exit 2 on the PreToolUse channel BLOCKS the tool (even with an empty
 *     stdout / closed pipe) → used ONLY for decode/dispatch failures inside
 *     the supported governance path;
 *   - exit 2 on UserPromptSubmit CLEARS the user's prompt → NEVER used there;
 *   - any stdout text is context-injected → neutral means EMPTY stdout;
 *   - flag-off / uninitialized / degraded never escalate to blocking.
 *
 * Belt cases reproduce both stdout-broken-pipe modes (ERR-156): a write that
 * throws synchronously and the host closing the pipe (async 'error' event).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runEntry, runWrapper, PACKAGE_ENTRY } from './helpers/hook-runner.js';
import { cleanupTempDirs, fixturePayload, makeGovernance, makeHome, makeProjectDir } from './helpers/workbench.js';
import { getWorkbuddyWorkspaceDir } from '@principles/install-layout';

afterAll(() => { cleanupTempDirs(); });

const FIXTURE_BY_EVENT: Record<string, string> = {
  SessionStart: 'session-start-startup.json',
  UserPromptSubmit: 'user-prompt-submit.json',
  PreToolUse: 'pre-tool-use-write.json',
  PostToolUse: 'post-tool-use-bash-exit7.json',
};

describe('flag-off (host.workbuddy default OFF, OD-03): neutral + observable skip + zero side effects', () => {
  for (const [event, fixture] of Object.entries(FIXTURE_BY_EVENT)) {
    it(`${event}: EMPTY stdout, exit 0, observable skip record, no workspace state created`, () => {
      const home = makeHome();
      const governance = makeGovernance(home, { workbuddyFlag: false });
      const project = makeProjectDir(home, 'flagoff');
      const payload = fixturePayload(fixture, { cwd: project });
      const result = runEntry(home, JSON.stringify(payload), event);
      expect(result.status).toBe(0);
      // Neutral on WorkBuddy is EMPTY stdout — `{}` would be context-injected (P04).
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('host.workbuddy_disabled');
      expect(result.stderr).toContain('nextAction=');
      // mvp-q-3 rollback evidence: flag-off dispatches nothing, creates nothing.
      expect(fs.existsSync(path.join(governance, '.pd', 'state.db'))).toBe(false);
      expect(fs.existsSync(path.join(governance, '.state'))).toBe(false);
    });
  }
});

describe('uninitialized governance workspace (OD-07/P06): actionable, never blocking, never auto-created', () => {
  for (const [event, fixture] of Object.entries(FIXTURE_BY_EVENT)) {
    it(`${event}: EMPTY stdout, exit 0, setup nextAction, no directory auto-created`, () => {
      const home = makeHome();
      const project = makeProjectDir(home, 'uninit');
      const payload = fixturePayload(fixture, { cwd: project });
      const result = runEntry(home, JSON.stringify(payload), event);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('workbuddy_workspace_not_initialized');
      expect(result.stderr).toContain('Run the PD WorkBuddy setup');
      expect(fs.existsSync(getWorkbuddyWorkspaceDir(home))).toBe(false);
    });
  }

  it('UserPromptSubmit NEVER exits 2 on uninitialized workspace (P02: exit 2 would clear the prompt)', () => {
    const home = makeHome();
    const project = makeProjectDir(home, 'uninit2');
    const payload = fixturePayload('user-prompt-submit.json', { cwd: project });
    const result = runEntry(home, JSON.stringify(payload), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('decode failures route per REGISTRATION channel (P02 exit-code effects)', () => {
  const BAD_JSON = '{"hook_event_name":"PreToolUse"';

  it('bad stdin JSON on the PreToolUse channel: exit 2 + bounded stderr + EMPTY stdout (P02: blocks the tool)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runEntry(home, BAD_JSON, 'PreToolUse');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^\[PD\] status=degraded reason=stdin_json_invalid:[^\r\n]+ nextAction=[^\r\n]+/);
    expect(result.stderr.length).toBeLessThan(1200);
  });

  it('bad stdin JSON on the UserPromptSubmit channel: exit 0 (P02: exit 2 clears the user prompt — protect it)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runEntry(home, BAD_JSON, 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin_json_invalid');
  });

  it('bad stdin JSON on PostToolUse/SessionStart channels: exit 0 (nothing blockable exists there)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    for (const channel of ['PostToolUse', 'SessionStart']) {
      const result = runEntry(home, BAD_JSON, channel);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
  });

  it('bad stdin JSON with NO channel argument: exit 0 neutral (cannot trust the channel)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runEntry(home, BAD_JSON);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin_json_invalid');
  });

  it('unknown hook_event_name in payload on the PreToolUse channel: exit 2 fail-loud', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'unknown');
    const payload = { session_id: 's', transcript_path: null, cwd: project, hook_event_name: 'Notification' };
    const result = runEntry(home, JSON.stringify(payload), 'PreToolUse');
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown hook_event_name');
  });

  it('missing required field on the PreToolUse channel: exit 2 fail-loud (rc-3)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'missing');
    const payload = fixturePayload('pre-tool-use-write.json', { cwd: project, tool_name: '' });
    const result = runEntry(home, JSON.stringify(payload), 'PreToolUse');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"tool_name"');
  });

  it('missing required field on the UserPromptSubmit channel: exit 0 neutral (prompt protected)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'missing2');
    const payload = fixturePayload('user-prompt-submit.json', { cwd: project, prompt: '' });
    const result = runEntry(home, JSON.stringify(payload), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('"prompt"');
  });
});

describe('healthy flag-on invocations without activations stay completely silent', () => {
  it('SessionStart: EMPTY stdout, exit 0, silent stderr (no body injected, SPEC §4.2)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const payload = fixturePayload('session-start-startup.json');
    const result = runEntry(home, JSON.stringify(payload), 'SessionStart');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('');
  });

  it('UserPromptSubmit without activations: EMPTY stdout (no injection, no noise)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'silent');
    const payload = fixturePayload('user-prompt-submit.json', { cwd: project });
    const result = runEntry(home, JSON.stringify(payload), 'UserPromptSubmit');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('');
  });

  it('PreToolUse without rules: EMPTY stdout (allow is NEVER emitted — P02 bypass risk), exit 0', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'silentpre');
    const payload = fixturePayload('pre-tool-use-write.json', { cwd: project });
    const result = runEntry(home, JSON.stringify(payload), 'PreToolUse');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('process-boundary belt (ERR-156: both broken-pipe modes)', () => {
  const epipeDetail = (stream: 'stdout' | 'stderr', syscall: string): string =>
    `Object.assign(new Error('EPIPE: broken pipe, ${syscall}'), { code: 'EPIPE', syscall: '${syscall}' })`;

  it('a stdout write that THROWS synchronously keeps the exit-2 contract intact (status is the blocker)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runEntry(home, '{"hook_event_name":"PreToolUse"', 'PreToolUse', {
      childPrelude: `process.stdout.write = () => { throw ${epipeDetail('stdout', 'write')}; };`,
    });
    // P02: exit 2 blocks even when stdout is dead — the code is the contract.
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
  });

  it('a stderr write that THROWS synchronously does not corrupt a neutral exit 0', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runEntry(home, '{"hook_event_name":"SessionStart"', 'SessionStart', {
      childPrelude: `process.stderr.write = () => { throw ${epipeDetail('stderr', 'write')}; };`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  for (const broken of ['stdout', 'stderr'] as const) {
    it(`the host closing the pipe (async EPIPE 'error' event on ${broken}) never crashes the process`, () => {
      const home = makeHome();
      makeGovernance(home, { workbuddyFlag: true });
      // A pending 0ms timer keeps the child alive until it fires, so the
      // async 'error' event deterministically reaches the belt listener that
      // was armed when the entry module imported (ERR-156: try/catch around
      // the write can never see this path — without the listener Node dies
      // with "Unhandled 'error' event" and a WRONG exit code).
      const result = runEntry(home, '{"hook_event_name":"PreToolUse"', 'PreToolUse', {
        childPostlude: `setTimeout(() => process.${broken}.emit('error', ${epipeDetail(broken, 'write')}), 0);`,
      });
      expect(result.stderr).not.toMatch(/Unhandled 'error' event/);
      // The P02 blocking contract survives the damaged stream.
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
    });
  }
});

describe('plugin wrapper transport (the command the WorkBuddy host actually runs)', () => {
  it('forwards stdin/stdout/exit code through PD_WORKBUDDY_ADAPTER_ENTRY', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const project = makeProjectDir(home, 'wrapper');
    const payload = fixturePayload('pre-tool-use-write.json', { cwd: project });
    const result = runWrapper(home, JSON.stringify(payload), 'PreToolUse', {
      env: { PD_WORKBUDDY_ADAPTER_ENTRY: PACKAGE_ENTRY },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('forwards the exit code 2 unchanged (the blocking contract survives the wrapper)', () => {
    const home = makeHome();
    makeGovernance(home, { workbuddyFlag: true });
    const result = runWrapper(home, '{"hook_event_name":"PreToolUse"', 'PreToolUse', {
      env: { PD_WORKBUDDY_ADAPTER_ENTRY: PACKAGE_ENTRY },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('stdin_json_invalid');
  });

  it('missing adapter entry degrades visibly and NON-blocking (exit 1, P02 startup-failure boundary)', () => {
    const home = makeHome();
    const result = runWrapper(home, '{}', 'PreToolUse', {
      env: { PD_WORKBUDDY_ADAPTER_ENTRY: path.join(home, 'definitely-missing-entry.js') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workbuddy_wrapper:entry_not_found');
    expect(result.stderr).toContain('nextAction=');
  });

  it('without an override, resolves the install-layout canonical runtime dir (OD-04)', () => {
    const home = makeHome();
    // Canonical path exists in the fake home but only as far as the dir — no
    // built entry — proving the wrapper targets install-layout's
    // workbuddyAdapterDir (<home>/.pd/runtime/workbuddy-adapter), not the repo.
    fs.mkdirSync(path.join(home, '.pd', 'runtime', 'workbuddy-adapter', 'dist'), { recursive: true });
    const result = runWrapper(home, '{}', 'PreToolUse');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workbuddy_wrapper:entry_not_found');
  });

  it('missing event argument fails fast (exit 1, bounded diagnostic)', () => {
    const home = makeHome();
    const result = runWrapper(home, '{}', '');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('workbuddy_wrapper:missing_event_argument');
  });
});
