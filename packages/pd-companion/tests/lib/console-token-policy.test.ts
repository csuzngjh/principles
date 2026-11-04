import { describe, expect, it } from 'vitest';
import {
  authorizeConsoleTokenSender,
  classifyConsoleTokenRestore,
} from '../../src/lib/console-token-policy.js';

describe('authorizeConsoleTokenSender', () => {
  const main = { mainWindowWebContentsId: 7 };

  it('authorizes the main window frame on the exact console origin', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 7,
        ...main,
        senderUrl: 'http://127.0.0.1:53421/',
        consoleRunning: true,
        consoleUrl: 'http://127.0.0.1:53421/',
      }),
    ).toEqual({ authorized: true });
  });

  it('denies a different webContents id', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 9,
        ...main,
        senderUrl: 'http://127.0.0.1:53421/',
        consoleRunning: true,
        consoleUrl: 'http://127.0.0.1:53421/',
      }),
    ).toEqual({ authorized: false, reason: 'invalid_sender' });
  });

  it('denies the main window before it exists', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 7,
        mainWindowWebContentsId: undefined,
        senderUrl: 'http://127.0.0.1:53421/',
        consoleRunning: true,
        consoleUrl: 'http://127.0.0.1:53421/',
      }),
    ).toEqual({ authorized: false, reason: 'invalid_sender' });
  });

  it('denies a non-console origin even from the main window', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 7,
        ...main,
        senderUrl: 'https://evil.example.com/',
        consoleRunning: true,
        consoleUrl: 'http://127.0.0.1:53421/',
      }),
    ).toEqual({ authorized: false, reason: 'invalid_origin' });
  });

  it('denies a different loopback port (port is part of the origin)', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 7,
        ...main,
        senderUrl: 'http://127.0.0.1:53422/',
        consoleRunning: true,
        consoleUrl: 'http://127.0.0.1:53421/',
      }),
    ).toEqual({ authorized: false, reason: 'invalid_origin' });
  });

  it('denies any sender while the console is not running', () => {
    expect(
      authorizeConsoleTokenSender({
        senderId: 7,
        ...main,
        senderUrl: 'http://127.0.0.1:53421/',
        consoleRunning: false,
        consoleUrl: undefined,
      }),
    ).toEqual({ authorized: false, reason: 'console_not_running' });
  });
});

describe('classifyConsoleTokenRestore', () => {
  const decryptOk = (ciphertext: string): string => `decrypted:${ciphertext}`;

  it('does nothing when no ciphertext was saved', () => {
    expect(
      classifyConsoleTokenRestore({ encryptedToken: undefined, encryptionAvailable: true, decrypt: decryptOk }),
    ).toEqual({ status: 'none', preserveCiphertext: false });
  });

  it('restores a usable token', () => {
    expect(
      classifyConsoleTokenRestore({ encryptedToken: 'cipher', encryptionAvailable: true, decrypt: decryptOk }),
    ).toEqual({ status: 'restored', token: 'decrypted:cipher', preserveCiphertext: false });
  });

  it('reports unavailable encryption instead of silently running no-auth', () => {
    const decision = classifyConsoleTokenRestore({
      encryptedToken: 'cipher',
      encryptionAvailable: false,
      decrypt: decryptOk,
    });
    expect(decision.status).toBe('encryption_unavailable');
    expect(decision.preserveCiphertext).toBe(true);
    expect(decision.nextAction).toMatch(/key store/i);
  });

  it('reports a decrypt failure and keeps the ciphertext as recovery evidence', () => {
    const decision = classifyConsoleTokenRestore({
      encryptedToken: 'cipher',
      encryptionAvailable: true,
      decrypt: () => {
        throw new Error('DPAPI decryption failed');
      },
    });
    expect(decision.status).toBe('decrypt_failed');
    expect(decision.detail).toContain('DPAPI decryption failed');
    expect(decision.preserveCiphertext).toBe(true);
    expect(decision.nextAction).toMatch(/kept/i);
  });

  it('treats a blank decrypted token as a failed restore rather than no-auth', () => {
    const decision = classifyConsoleTokenRestore({
      encryptedToken: 'cipher',
      encryptionAvailable: true,
      decrypt: () => '   ',
    });
    expect(decision.status).toBe('decrypt_failed');
    expect(decision.preserveCiphertext).toBe(true);
  });
});
