/**
 * HOME-first unification regression (Round 3 §5 / review N2- + N27).
 *
 * The single authority for the real user home is install-layout's
 * HOME-first precedence (explicit HOME wins, os.homedir() is the fallback).
 * On Windows os.homedir() reads USERPROFILE and IGNORES a sandboxed HOME, so
 * any module that pins `os.homedir()` as its default splits the install:
 * the config check inspects one tree while the installer writes another.
 * Each test below sets HOME ≠ os.homedir() (via USERPROFILE) and pins ONE
 * module's default-resolution entry point to the shared verdict.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { detectWorkspace, getOpenClawConfigDir, getPluginExtDir } from '../src/utils/env.js';
import { resolveMcpRegistrationConfigPath } from '../src/installers/mcp-registration-conflict.js';

const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['HOME', 'USERPROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_HOME', 'CODEX_HOME', 'WORKBUDDY_CONFIG_DIR', 'PD_WORKSPACE_DIR', 'PD_EXPERIMENT_ROOT'] as const;
let homeSandbox = '';
let otherHome = '';

beforeEach(() => {
  for (const key of KEYS) savedEnv[key] = process.env[key];
  homeSandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-first-sandbox-')));
  // The decoy home: os.homedir() (USERPROFILE on win32) resolves here — a
  // module still pinning os.homedir() computes paths under decoyHome and
  // FAILS the assertions below.
  otherHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-home-first-decoy-')));
  process.env.HOME = homeSandbox;
  process.env.USERPROFILE = otherHome;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.WORKBUDDY_CONFIG_DIR;
  delete process.env.PD_WORKSPACE_DIR;
  delete process.env.PD_EXPERIMENT_ROOT;
  fs.mkdirSync(path.join(homeSandbox, '.openclaw'), { recursive: true });
  fs.mkdirSync(path.join(otherHome, '.openclaw'), { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(homeSandbox, { recursive: true, force: true });
  fs.rmSync(otherHome, { recursive: true, force: true });
});

describe('HOME-first default resolution (HOME ≠ os.homedir())', () => {
  it('getOpenClawConfigDir() with no arguments resolves under HOME, not os.homedir()', () => {
    expect(getOpenClawConfigDir()).toBe(path.join(homeSandbox, '.openclaw'));
    expect(getOpenClawConfigDir()).not.toBe(path.join(otherHome, '.openclaw'));
  });

  it('getPluginExtDir() with no arguments resolves under HOME, not os.homedir()', () => {
    expect(getPluginExtDir()).toBe(path.join(homeSandbox, '.openclaw', 'extensions', 'principles-disciple'));
  });

  it('detectWorkspace() with no homeDir injection uses the shared HOME-first default', () => {
    // No workspace exists in either home: the FIRST-INSTALL default for the
    // openclaw host is <resolvedHome>/clawd — under the HOME sandbox, not the
    // decoy (an os.homedir()-pinned default would land in otherHome/clawd).
    const detected = detectWorkspace({ host: 'openclaw' });
    expect(detected.exists).toBe(false);
    expect(detected.detectedPath).toBe(path.join(homeSandbox, 'clawd'));
  });

  it('MCP registration conflict check inspects the HOME-resolved config, not the os.homedir one', () => {
    // An OpenClaw config exists ONLY under the HOME sandbox: the conflict
    // verdict must be computed from THAT file (a module still pinning
    // os.homedir() would report a different configPath).
    const configPath = path.join(homeSandbox, '.openclaw', 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({ mcp: { servers: { 'other-server': { command: 'node' } } } }), 'utf8');

    expect(resolveMcpRegistrationConfigPath('openclaw')).toBe(configPath);
  });

  it('an explicit homeDir injection still wins over the env (contract preserved)', () => {
    expect(getOpenClawConfigDir(otherHome)).toBe(path.join(otherHome, '.openclaw'));
  });
});
