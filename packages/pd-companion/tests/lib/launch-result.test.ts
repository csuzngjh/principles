import { describe, it, expect } from 'vitest';
import {
  tryParseConsoleOpenOutput,
  parsePluginVersion,
  getAuthenticationMismatchCleanupPid,
  LaunchResultError,
} from '../../src/lib/launch-result.js';

describe('tryParseConsoleOpenOutput', () => {
  it('parses a complete started result with serverPid', () => {
    const raw = JSON.stringify({
      status: 'started', url: 'http://127.0.0.1:3100', port: 3100, host: '127.0.0.1',
      workspaceDir: 'D:\\ws', reused: false, browserOpened: false, serverPid: 4242,
      authenticationMode: 'authenticated',
    });
    const result = tryParseConsoleOpenOutput(raw);
    expect(result?.status).toBe('started');
    expect(result?.port).toBe(3100);
    expect(result?.serverPid).toBe(4242);
    expect(result?.reused).toBe(false);
    expect(result?.authenticationMode).toBe('authenticated');
  });

  it('parses a reused result without serverPid', () => {
    const raw = JSON.stringify({
      status: 'reused', url: 'http://127.0.0.1:3100', port: 3100, host: '127.0.0.1',
      workspaceDir: '', reused: true, browserOpened: false,
    });
    const result = tryParseConsoleOpenOutput(raw);
    expect(result?.status).toBe('reused');
    expect(result?.serverPid).toBeUndefined();
  });

  it('returns undefined for partial JSON (streaming chunks)', () => {
    expect(tryParseConsoleOpenOutput('{ "status": "sta')).toBeUndefined();
    expect(tryParseConsoleOpenOutput('')).toBeUndefined();
    expect(tryParseConsoleOpenOutput('not json at all')).toBeUndefined();
  });

  it('throws LaunchResultError when status is missing/invalid (fail loud, rc-3)', () => {
    const raw = JSON.stringify({ port: 3100 });
    expect(() => tryParseConsoleOpenOutput(raw)).toThrow(LaunchResultError);
    const raw2 = JSON.stringify({ status: 'exploded', port: 3100 });
    expect(() => tryParseConsoleOpenOutput(raw2)).toThrow(LaunchResultError);
  });

  it('throws when port is missing or out of range', () => {
    expect(() => tryParseConsoleOpenOutput(JSON.stringify({ status: 'started' }))).toThrow(LaunchResultError);
    expect(() => tryParseConsoleOpenOutput(JSON.stringify({ status: 'started', port: 99999 }))).toThrow(LaunchResultError);
  });

  it('throws when serverPid is present but invalid', () => {
    expect(() => tryParseConsoleOpenOutput(JSON.stringify({ status: 'started', port: 3100, serverPid: -5 }))).toThrow(LaunchResultError);
    expect(() => tryParseConsoleOpenOutput(JSON.stringify({ status: 'started', port: 3100, serverPid: 'x' }))).toThrow(LaunchResultError);
  });

  it('throws when authenticationMode is present but invalid', () => {
    expect(() => tryParseConsoleOpenOutput(JSON.stringify({
      status: 'started', port: 3100, authenticationMode: 'maybe',
    }))).toThrow(LaunchResultError);
  });

  it('keeps failed status with reason and nextAction passthrough', () => {
    const raw = JSON.stringify({
      status: 'failed', url: '', port: 0, host: '127.0.0.1', workspaceDir: '', reused: false,
      browserOpened: false, reason: 'workspace_missing', nextAction: 'Pass --workspace <path>',
    });
    const result = tryParseConsoleOpenOutput(raw);
    expect(result?.status).toBe('failed');
    expect(result?.reason).toBe('workspace_missing');
    expect(result?.nextAction).toBe('Pass --workspace <path>');
  });
});

describe('getAuthenticationMismatchCleanupPid', () => {
  it('returns the PID only for a newly started mismatched Console', () => {
    expect(getAuthenticationMismatchCleanupPid({
      status: 'started', url: '', port: 3100, host: '127.0.0.1', workspaceDir: '',
      reused: false, browserOpened: false, authenticationMode: 'no_auth', serverPid: 4242,
    }, 'authenticated')).toBe(4242);
  });

  it('never claims ownership of a reused Console', () => {
    expect(getAuthenticationMismatchCleanupPid({
      status: 'reused', url: '', port: 3100, host: '127.0.0.1', workspaceDir: '',
      reused: true, browserOpened: false, authenticationMode: 'no_auth', serverPid: 4242,
    }, 'authenticated')).toBeUndefined();
  });
});

describe('parsePluginVersion', () => {
  it('reads version from plugin package.json content', () => {
    expect(parsePluginVersion(JSON.stringify({ name: 'x', version: '1.76.1' }))).toBe('1.76.1');
  });

  it('returns undefined for malformed content or missing/non-string version', () => {
    expect(parsePluginVersion('not json')).toBeUndefined();
    expect(parsePluginVersion(JSON.stringify({}))).toBeUndefined();
    expect(parsePluginVersion(JSON.stringify({ version: 1 }))).toBeUndefined();
  });
});
