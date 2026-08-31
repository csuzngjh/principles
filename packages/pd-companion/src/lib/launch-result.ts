/**
 * Parse and validate the JSON emitted by `pd console open --json`.
 *
 * Runtime contract: the CLI's stdout is untrusted input (rc-1/rc-2) — every
 * field is narrowed with runtime checks before it reaches the supervisor.
 * A partial buffer (streaming chunks) yields undefined; a complete but
 * invalid object throws so the supervisor can fail loud.
 */

export type ConsoleOpenStatus = 'started' | 'reused' | 'failed' | 'refused';
export type ConsoleAuthenticationMode = 'authenticated' | 'no_auth';

export interface ConsoleOpenResult {
  status: ConsoleOpenStatus;
  url: string;
  port: number;
  host: string;
  workspaceDir: string;
  reused: boolean;
  browserOpened: boolean;
  authenticationMode?: ConsoleAuthenticationMode;
  serverPid?: number;
  reason?: string;
  nextAction?: string;
}

export class LaunchResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchResultError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function validateConsoleOpenResult(record: Record<string, unknown>): ConsoleOpenResult {
  const {status} = record;
  if (status !== 'started' && status !== 'reused' && status !== 'failed' && status !== 'refused') {
    throw new LaunchResultError(`CLI JSON status missing or invalid: ${JSON.stringify(status)}`);
  }
  const {port} = record;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LaunchResultError(`CLI JSON port missing or invalid: ${JSON.stringify(port)}`);
  }
  const result: ConsoleOpenResult = {
    status,
    url: readString(record, 'url') ?? '',
    port,
    host: readString(record, 'host') ?? '127.0.0.1',
    workspaceDir: readString(record, 'workspaceDir') ?? '',
    reused: record.reused === true,
    browserOpened: record.browserOpened === true,
  };
  const {serverPid} = record;
  if (serverPid !== undefined) {
    if (typeof serverPid !== 'number' || !Number.isInteger(serverPid) || serverPid <= 0) {
      throw new LaunchResultError(`CLI JSON serverPid invalid: ${JSON.stringify(serverPid)}`);
    }
    result.serverPid = serverPid;
  }
  const { authenticationMode } = record;
  if (authenticationMode !== undefined) {
    if (authenticationMode !== 'authenticated' && authenticationMode !== 'no_auth') {
      throw new LaunchResultError(`CLI JSON authenticationMode invalid: ${JSON.stringify(authenticationMode)}`);
    }
    result.authenticationMode = authenticationMode;
  }
  const reason = readString(record, 'reason');
  if (reason !== undefined) result.reason = reason;
  const nextAction = readString(record, 'nextAction');
  if (nextAction !== undefined) result.nextAction = nextAction;
  return result;
}

/**
 * Try to parse a (possibly partial) stdout buffer into a ConsoleOpenResult.
 * - Returns undefined while the buffer holds no complete JSON object yet.
 * - Throws LaunchResultError when a complete JSON object fails validation.
 */
export function tryParseConsoleOpenOutput(buffer: string): ConsoleOpenResult | undefined {
  const trimmed = buffer.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined; // partial pretty-printed JSON — more chunks coming
  }
  if (!isRecord(parsed)) {
    throw new LaunchResultError('CLI JSON output was not an object');
  }
  return validateConsoleOpenResult(parsed);
}

/**
 * Parse the plugin package.json content for the installed version.
 * Mirrors readCurrentVersion in pd-console update.ts (same source of truth).
 */
export function parsePluginVersion(packageJsonRaw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonRaw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const {version} = parsed;
  return typeof version === 'string' ? version : undefined;
}
