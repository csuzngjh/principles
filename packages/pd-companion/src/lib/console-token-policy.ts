/**
 * Console-token IPC policy (pure).
 *
 * Companion exposes three token IPC channels. All of them may only be used by
 * the console page itself:
 *
 *  - `configure` writes a durable credential (encrypted) and may restart the
 *    managed console, so it needs exactly the same sender + exact-origin guard
 *    as `get` and `clear`. A preload bridge alone is not authorization.
 *  - `get` hands the credential to the renderer.
 *  - `clear` destroys the durable credential.
 *
 * Restore policy: the encrypted token is Owner data. A failed restore must be
 * reported and must keep the ciphertext as recovery evidence; silently
 * deleting it (or silently running no-auth) hides a real problem.
 *
 * Pure logic only; main.ts stays thin glue around it.
 */

import { isSameConsoleOrigin } from './console-origin.js';

export type ConsoleTokenSenderDenial = 'invalid_sender' | 'console_not_running' | 'invalid_origin';

export interface ConsoleTokenSenderContext {
  /** `event.sender.id` from the IPC call. */
  senderId: number;
  /** `mainWindow?.webContents.id` — undefined before the window exists. */
  mainWindowWebContentsId: number | undefined;
  /** `event.senderFrame?.url` — '' when the frame URL is unavailable. */
  senderUrl: string;
  consoleRunning: boolean;
  /** The URL the supervisor currently serves, when running. */
  consoleUrl: string | undefined;
}

export interface ConsoleTokenSenderDecision {
  authorized: boolean;
  reason?: ConsoleTokenSenderDenial;
}

/**
 * Whether the IPC sender may touch the console token. Denial reasons are kept
 * distinct so the caller can explain the refusal, but every mutation path must
 * treat any denial the same: no state write, no env change, no restart.
 */
export function authorizeConsoleTokenSender(context: ConsoleTokenSenderContext): ConsoleTokenSenderDecision {
  if (context.mainWindowWebContentsId === undefined || context.senderId !== context.mainWindowWebContentsId) {
    return { authorized: false, reason: 'invalid_sender' };
  }
  if (!context.consoleRunning) {
    return { authorized: false, reason: 'console_not_running' };
  }
  if (!isSameConsoleOrigin(context.senderUrl, context.consoleUrl)) {
    return { authorized: false, reason: 'invalid_origin' };
  }
  return { authorized: true };
}

export type ConsoleTokenRestoreStatus = 'none' | 'restored' | 'encryption_unavailable' | 'decrypt_failed';

export interface ConsoleTokenRestoreInput {
  /** The ciphertext stored in companion state, when present. */
  encryptedToken: string | undefined;
  encryptionAvailable: boolean;
  /** Injected so the policy is testable without Electron safeStorage. */
  decrypt: (ciphertext: string) => string;
}

export interface ConsoleTokenRestoreDecision {
  status: ConsoleTokenRestoreStatus;
  token?: string;
  detail?: string;
  /**
   * The stored ciphertext must be kept on every failure path: it is the only
   * recovery evidence for the Owner's saved credential.
   */
  preserveCiphertext: boolean;
  nextAction?: string;
}

const RESTORE_RECOVERY_ACTION =
  'Re-enter the Console token from the Console window, or check the operating-system key store. The encrypted token was kept.';
const ENCRYPTION_UNAVAILABLE_ACTION =
  'Enable the operating-system key store, then relaunch PD Companion. The encrypted token was kept.';

/**
 * Decide what a startup restore can do with the saved ciphertext. Never
 * deletes it; a failed decrypt is a reportable condition, not a reason to
 * silently drop the credential and continue without authentication.
 */
export function classifyConsoleTokenRestore(input: ConsoleTokenRestoreInput): ConsoleTokenRestoreDecision {
  if (input.encryptedToken === undefined || input.encryptedToken.length === 0) {
    return { status: 'none', preserveCiphertext: false };
  }
  if (!input.encryptionAvailable) {
    return {
      status: 'encryption_unavailable',
      preserveCiphertext: true,
      nextAction: ENCRYPTION_UNAVAILABLE_ACTION,
    };
  }
  try {
    const token = input.decrypt(input.encryptedToken).trim();
    if (token.length === 0) {
      return {
        status: 'decrypt_failed',
        detail: 'decrypted token is empty',
        preserveCiphertext: true,
        nextAction: RESTORE_RECOVERY_ACTION,
      };
    }
    return { status: 'restored', token, preserveCiphertext: false };
  } catch (error) {
    return {
      status: 'decrypt_failed',
      detail: error instanceof Error ? error.message : String(error),
      preserveCiphertext: true,
      nextAction: RESTORE_RECOVERY_ACTION,
    };
  }
}
