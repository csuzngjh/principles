/**
 * Release handover — a Console never keeps serving a release that is no
 * longer the installed one.
 *
 * An update replaces the runtime on disk and, at its commit point, writes the
 * active release record. The Console process that carried the update is NOT
 * restarted by that: it goes on answering from the code it started with, so
 * the Owner finishes an update, is told "restart the console", and keeps
 * looking at the old version until they do. Every restart path that existed
 * needed the Owner's hand (Ctrl+C, reopening the Companion).
 *
 * This module closes that gap from the inside. While it serves, a Console
 * re-reads the active release record; the moment it names a different release
 * than the one this process started on, the Console starts its own successor
 * on the installed code and, once the successor is serving on the same port,
 * exits. The Owner's tab reloads into the new version with nothing to do.
 *
 * Safety properties, in order of importance:
 *  - NEVER leave the port unserved, and never leave it worse than before. This
 *    process stops accepting only after the successor exists; if the successor
 *    does not answer in time it is STOPPED first — it may be listening already —
 *    and only then is the port taken back. This process exits only once a
 *    console answers on the port.
 *  - The record is the ONLY trigger. It is written after the transaction
 *    journal reached `confirmed`, so a failed or rolled-back update (record
 *    unchanged) and a mid-flight update (record not yet written) never hand
 *    over. A record that cannot be read is not a change.
 *  - One handover per change: the watch fires once, then stops.
 *  - The successor is a fixed module of the installed build — never a path
 *    this process was handed — and its launch line travels over stdin as data.
 *  - The successor must not hold the installed runtime open. It works from the
 *    directory its launcher was run from, like any console, never from inside
 *    the runtime: on Windows a working directory keeps its tree from being
 *    renamed, and the next update starts by renaming the runtime away.
 *
 * Two consoles do NOT hand themselves over, and both are decisions about
 * ownership rather than capability:
 *
 *  - one the Companion launched. The Companion hands over the console it owns
 *    by stopping it and relaunching through its own launcher — the only
 *    sequence in which it still owns what comes next. A console that replaced
 *    itself underneath it comes back as somebody else's process: its restart
 *    ladder then waits for a "new" process that never starts, or adopts the
 *    successor as a foreign instance. So here the Companion stays in charge.
 *  - one that does not run from the installed runtime (a repository build, a
 *    pre-canonical layout). The files an update replaces are not the ones this
 *    process runs from, so a successor started beside it would be the same
 *    code again — a restart to nowhere.
 *
 * `PD_CONSOLE_RELEASE_HANDOVER=off` disables the watch for one process.
 */

import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveReleaseRecord, type ActiveReleaseRecord, type ActiveReleaseVerdict } from '@principles/install-layout';

/** `off` disables the release watch for this process (the rollback lever). */
export const CONSOLE_RELEASE_HANDOVER_ENV = 'PD_CONSOLE_RELEASE_HANDOVER';

export const HANDOVER_BIND_WAIT_MS = 20_000;
export const HANDOVER_BIND_RETRY_MS = 250;
export const RELEASE_WATCH_INTERVAL_MS = 2_000;
/** How long the predecessor waits for its successor to answer on the port. */
export const HANDOVER_HEALTHY_TIMEOUT_MS = 20_000;
/** How long to wait for a stopped successor to actually be gone. */
export const HANDOVER_ABANDON_WAIT_MS = 5_000;
/** How long "address in use" is tolerated while the port is taken back. */
export const HANDOVER_RELISTEN_RETRY_MS = 5_000;

/** What identifies "the release this process started on". */
export interface ReleaseIdentity {
  readonly generation: number;
  readonly releaseId: string;
}

export function releaseIdentityOf(record: ActiveReleaseRecord): ReleaseIdentity {
  return { generation: record.generation, releaseId: record.releaseId };
}

/** True when `current` is a release other than `baseline` — in either direction, a downgrade is a change too. */
export function isReleaseSuperseded(baseline: ReleaseIdentity, current: ActiveReleaseRecord): boolean {
  return current.generation !== baseline.generation || current.releaseId !== baseline.releaseId;
}

/**
 * The marker the Companion puts on everything it launches. A Console carrying
 * it was started by the Companion's own launcher, which is what makes the
 * Console "managed" on the Companion side.
 */
export const COMPANION_INVOCATION_SOURCE = 'companion';

export function isCompanionLaunched(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.PD_INVOCATION_SOURCE === COMPANION_INVOCATION_SOURCE;
}

/**
 * Whether this console hands itself over to a new release, and — when it does
 * not — why, in words a log reader can act on (rc-9: never a silent "off").
 * The reasons are ordered by who owns the decision: the Companion that
 * launched this console, the installer's own probe, the operator's switch,
 * and lastly what this process is running from.
 */
export type ReleaseHandoverDecision =
  | { readonly watch: true }
  | { readonly watch: false; readonly reason: string };

/** Where the build files this module among the Console's (`tsc` mirrors `src/`). */
const SERVER_OUTPUT_SEGMENTS = ['dist', 'server'] as const;

/**
 * True when `runningFrom` — the directory this process loaded its server code
 * from — IS the installed Console's. Only then does the successor beside this
 * file belong to the release an update just laid down.
 *
 * Both sides are resolved to their real path: the installed location may be
 * reached through a link, and Node already hands `import.meta.url` as the real
 * path. Anything that cannot be resolved is "not installed" — never a guess.
 */
export function isInstalledConsoleCode(runningFrom: string, installedConsoleDir: string): boolean {
  const real = (target: string): string | null => {
    try {
      const resolved = fs.realpathSync.native(target);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    } catch {
      return null;
    }
  };
  const running = real(runningFrom);
  const installed = real(path.join(installedConsoleDir, ...SERVER_OUTPUT_SEGMENTS));
  return running !== null && running === installed;
}

export function decideReleaseHandoverWatch(
  env: Readonly<Record<string, string | undefined>>,
  runsInstalledCode: boolean,
): ReleaseHandoverDecision {
  if (isCompanionLaunched(env)) {
    return { watch: false, reason: 'the Companion relaunches this console after an update' };
  }
  // The installer's verification probe is killed right after it answers; a
  // handover from inside it would leave a stray Console on a probe port.
  if (env.PD_CONSOLE_VERIFY_NONCE !== undefined) {
    return { watch: false, reason: 'installer verification probe' };
  }
  if (env[CONSOLE_RELEASE_HANDOVER_ENV] === 'off') {
    return { watch: false, reason: `disabled by ${CONSOLE_RELEASE_HANDOVER_ENV}=off` };
  }
  if (!runsInstalledCode) {
    return { watch: false, reason: 'not the installed console — a restart would bring back the same code' };
  }
  return { watch: true };
}

/**
 * Who switches this console to the new release once an update has activated
 * it. The page asks, because what it should say — and how long it should wait
 * — depends on the answer.
 */
export type ReleaseHandoverOwner =
  /** This process: it starts a successor on the installed code and exits once that serves. */
  | 'console'
  /** The Companion that launched this process: it stops and relaunches the console it owns. */
  | 'companion'
  /** Nobody. The console goes on serving the previous release until it is restarted by hand. */
  | 'manual';

let watchArmed = false;

/**
 * The handover owner of THIS process. `'console'` only while its watch is
 * actually running — not merely entitled to run — so a page told to wait is
 * always waiting for something real.
 */
export function releaseHandoverOwner(env: Readonly<Record<string, string | undefined>> = process.env): ReleaseHandoverOwner {
  if (watchArmed) return 'console';
  return isCompanionLaunched(env) ? 'companion' : 'manual';
}

export interface ReleaseHandoverWatch {
  stop(): void;
}

export interface ReleaseHandoverWatchOptions {
  /** `<pdHome>/active.json` — the installation authority. */
  readonly recordPath: string;
  /** Called at most once, with the record that superseded this process. */
  readonly onSuperseded: (current: ActiveReleaseRecord) => void;
  readonly intervalMs?: number;
  /** Seams (tests); production reads the record through install-layout. */
  readonly readRecord?: (recordPath: string) => ActiveReleaseVerdict;
  readonly log?: (message: string) => void;
}

/**
 * Starts re-reading the active release record. Returns null — and watches
 * nothing — when there is no readable record to be the baseline: with no
 * installation there is nothing this process could be stale relative to.
 */
export function startReleaseHandoverWatch(options: ReleaseHandoverWatchOptions): ReleaseHandoverWatch | null {
  const read = options.readRecord ?? readActiveReleaseRecord;
  const log = options.log ?? ((message: string) => console.log(message));
  const baseline = read(options.recordPath);
  if (!baseline.ok) {
    log(`[pd-console] Release handover watch not started (${baseline.reason}): ${baseline.detail}`);
    return null;
  }
  const identity = releaseIdentityOf(baseline.record);
  const timer = setInterval(() => {
    const current = read(options.recordPath);
    if (!current.ok || !isReleaseSuperseded(identity, current.record)) return;
    clearInterval(timer);
    // One handover per change: having fired, this process is no longer waiting
    // for anything — should the handover be called off, it is a plain console.
    watchArmed = false;
    options.onSuperseded(current.record);
  }, options.intervalMs ?? RELEASE_WATCH_INTERVAL_MS);
  // A watch must never be what keeps a Console alive.
  timer.unref?.();
  watchArmed = true;
  return {
    stop: () => {
      clearInterval(timer);
      watchArmed = false;
    },
  };
}

/** The part of a forked child the handover needs; tests hand in an EventEmitter with a `pid` and a `kill`. */
export interface SuccessorProcess {
  readonly pid?: number;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: () => void): unknown;
  /** Ends the process. Called only ever on the successor THIS process started. */
  kill(): void;
}

/** The successor's whole launch line: this process's own command-line arguments. */
export interface ConsoleSuccessorSpec {
  readonly args: readonly string[];
}

export interface SuccessorLaunch {
  /**
   * Where `./successor.js` is resolved from. Production leaves it alone: the
   * build's own directory, which an update has already replaced with the
   * installed release's copy. Tests point at a directory holding a stand-in.
   */
  readonly cwd?: string;
}

/**
 * Starts the successor: the installed build's own successor module, detached
 * and unattended so it outlives this process, with the launch line on its
 * stdin. Null when it could not be started — the caller then keeps serving.
 *
 * The directory above only serves to resolve the module path: the successor
 * is told where this process was working and leaves the build's directory at
 * once (see successor.ts). It must not go on working from inside the installed
 * runtime — on Windows a working directory keeps its tree from being renamed,
 * and the next update starts by renaming the runtime away.
 */
export function startConsoleSuccessor(spec: ConsoleSuccessorSpec, log: (message: string) => void, launch: SuccessorLaunch = {}): SuccessorProcess | null {
  const buildDirectory = path.dirname(fileURLToPath(import.meta.url));
  try {
    const child: ChildProcess = fork('./successor.js', [], {
      cwd: launch.cwd ?? buildDirectory,
      // stdin carries the launch line; the successor has no terminal to talk
      // to. `fork` insists on an IPC channel — the successor closes it as soon
      // as it has read its configuration, so it outlives this process.
      stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
      detached: true,
      windowsHide: true,
    });
    child.stdin?.end(`${JSON.stringify({ args: spec.args, cwd: process.cwd() })}\n`);
    child.unref();
    return child;
  } catch (error) {
    log(`[pd-console] Could not start the successor console: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** A transaction id that names no transaction: it only asks the console to identify itself (it matches the route's id pattern). */
const IDENTITY_PROBE_ID = 'handover-identity-probe';

/**
 * The url that asks the console on `port` to name itself. The transaction
 * route answers it from the journal directory alone — no diagnostics, no
 * database — so a console can answer the moment it is listening. `/api/health`
 * cannot serve here: it runs diagnostics with budgets longer than a handover
 * can wait, so a healthy successor would look absent.
 */
export function consoleIdentityUrl(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  return `http://${authority}/api/update/transaction/${IDENTITY_PROBE_ID}`;
}

const IDENTITY_BODY_LIMIT = 4096;

/**
 * The pid of the console answering at `url`, or null when nobody does, the
 * answer is not a console's, or it does not arrive in time. Never rejects.
 */
export function probeConsolePid(url: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (pid: number | null): void => {
      if (settled) return;
      settled = true;
      resolve(pid);
    };
    const request = http.get(url, (response) => {
      response.on('error', () => finish(null));
      response.on('close', () => finish(null));
      if (response.statusCode !== 200) {
        response.resume();
        finish(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        // Bounded (rc-8): an answer this long is not the one-line fact asked for.
        if (body.length > IDENTITY_BODY_LIMIT) request.destroy();
      });
      response.on('end', () => {
        let pid: unknown;
        try {
          const value: unknown = JSON.parse(body);
          const data = typeof value === 'object' && value !== null ? Reflect.get(value, 'data') : undefined;
          pid = typeof data === 'object' && data !== null ? Reflect.get(data, 'serverPid') : undefined;
        } catch {
          pid = undefined;
        }
        finish(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null);
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
  });
}

export interface ConsoleListenRequest {
  readonly server: http.Server;
  readonly port: number;
  readonly host: string;
  readonly onListening: () => void;
  /** Receives the error that ends the attempts — a port that stays taken, or any other error. */
  readonly giveUp: (error: Error & { code?: string }) => void;
  /** How long "address in use" is retried. 0 (the default) means not at all. */
  readonly retryInUseForMs?: number;
  readonly retryMs?: number;
}

/**
 * Binds the console. A handover successor boots while its predecessor is
 * still releasing the port, so for it "address in use" means "try again" —
 * but only for a bounded time, after which it is the dead end it always was.
 * Any other error is never retried.
 */
export interface ConsoleListener {
  /**
   * Binds again after the port was released for a handover, retrying
   * "address in use" for `retryInUseForMs` (a successor that was just stopped
   * may still be letting go). Rejects with the error that ended the attempts.
   * That failure is the handover's to report — it is not the dead end a
   * boot-time bind failure is, so it never reaches `giveUp`.
   */
  relisten(retryInUseForMs: number): Promise<void>;
}

export function listenWithHandoverRetry(request: ConsoleListenRequest): ConsoleListener {
  const { server, port, host, onListening, giveUp } = request;
  const retryMs = request.retryMs ?? HANDOVER_BIND_RETRY_MS;
  let retryUntil = Date.now() + (request.retryInUseForMs ?? 0);
  /** Set while a `relisten` is pending: a bind failure then is reported there. */
  let pendingRelisten: ((error: Error & { code?: string }) => void) | null = null;
  server.on('listening', onListening);
  server.on('error', (error: Error & { code?: string }) => {
    if (error.code === 'EADDRINUSE' && Date.now() < retryUntil) {
      // Ref'd on purpose: until the port is theirs, this retry is what keeps a
      // successor alive.
      setTimeout(() => { server.listen(port, host); }, retryMs);
      return;
    }
    const reject = pendingRelisten;
    pendingRelisten = null;
    if (reject !== null) {
      reject(error);
      return;
    }
    giveUp(error);
  });
  server.listen(port, host);
  return {
    relisten: (retryInUseForMs) => new Promise<void>((resolve, reject) => {
      pendingRelisten = reject;
      retryUntil = Date.now() + retryInUseForMs;
      server.once('listening', () => {
        pendingRelisten = null;
        resolve();
      });
      server.listen(port, host);
    }),
  };
}

export interface ServingWaitOptions {
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolves with the first answer `probe` gives that is not null, or null at
 * the deadline. Never rejects.
 */
export async function waitUntilAnswer<T>(
  probe: () => Promise<T | null>,
  timeoutMs: number,
  options: ServingWaitOptions = {},
): Promise<T | null> {
  const intervalMs = options.intervalMs ?? HANDOVER_BIND_RETRY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answer = await probe();
    if (answer !== null) return answer;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Stops the successor this process started, and resolves once it is gone — or
 * when `waitMs` has passed, whichever comes first: a successor that will not
 * die must not hold this console's decision about its own port for good.
 */
export async function stopSuccessor(successor: SuccessorProcess | null, waitMs: number = HANDOVER_ABANDON_WAIT_MS): Promise<void> {
  if (successor === null) return;
  const gone = new Promise<void>((resolve) => { successor.once('exit', () => resolve()); });
  successor.kill();
  await Promise.race([gone, new Promise<void>((resolve) => { setTimeout(resolve, waitMs); })]);
}

export interface ReleaseHandoverDeps {
  readonly startSuccessor: () => SuccessorProcess | null;
  /** Stops accepting connections; in-flight requests still finish. */
  readonly stopAccepting: () => Promise<void>;
  /** The pid of the console answering on the port again, or null at the deadline. */
  readonly waitForSuccessor: () => Promise<number | null>;
  /** Ends the successor this process started, and resolves once it is gone (within a bound). */
  readonly abandonSuccessor: () => Promise<void>;
  /** Binds the port again. Rejects when it cannot be taken back. */
  readonly resumeAccepting: () => Promise<void>;
  /** Ends this process. Called only once the port is someone's — or when it can be nobody's. */
  readonly exit: (code: number) => void;
  readonly log?: (message: string) => void;
  readonly spawnTimeoutMs?: number;
}

/**
 * Hands the port over to a successor running the installed release.
 *
 * Every failure keeps this process serving, or leaves it no worse off: a
 * successor that cannot be started is reported and dropped; one that never
 * answers is stopped before the port is taken back — it may be listening
 * already, and binding over a live listener is not possible. The port goes
 * unserved only for the successor's own boot time.
 */
export async function performReleaseHandover(deps: ReleaseHandoverDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const keepServing = (why: string): void => {
    log(`[pd-console] Release handover skipped — this console keeps serving (${why}).`);
  };

  let successor: SuccessorProcess | null;
  try {
    successor = deps.startSuccessor();
  } catch (error) {
    keepServing(`successor could not be started: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (successor === null) {
    keepServing('successor could not be started');
    return;
  }

  const created = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), deps.spawnTimeoutMs ?? 10_000);
    successor?.once('error', (error: Error) => {
      clearTimeout(timer);
      keepServing(`successor failed to start: ${error.message}`);
      resolve(false);
    });
    successor?.once('spawn', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!created) return;

  log(`[pd-console] Installed release changed — handing over to the new release (successor pid ${successor.pid}).`);
  await deps.stopAccepting();

  const serving = await deps.waitForSuccessor();
  if (serving !== null) {
    // Said plainly, because in a terminal this is the moment `pd console open`
    // returns to the prompt: the console did not stop, it moved. Whoever
    // answers was started after the release changed, so it runs the new code.
    const who = serving === successor.pid ? 'The successor console' : `Another console`;
    log(`[pd-console] ${who} (pid ${serving}) is serving on the new release; this console exits.`);
    deps.exit(0);
    return;
  }

  log('[pd-console] Successor did not come up in time — stopping it and taking the port back.');
  await deps.abandonSuccessor();
  try {
    await deps.resumeAccepting();
  } catch (error) {
    log(`[pd-console] Could not take the port back: ${error instanceof Error ? error.message : String(error)}`);
    deps.exit(1);
    return;
  }
  log('[pd-console] Port taken back — this console keeps serving the previous release, and will not hand itself over again before it is restarted.');
}
