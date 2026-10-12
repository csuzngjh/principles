import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Shared real-process harness for the WorkBuddy adapter tests.
 *
 * Unlike the Codex fail-open harness, a NON-ZERO exit is a legitimate result
 * here (the P02 exit-2 blocking contract on the PreToolUse channel), so the
 * runner REPORTS status codes instead of throwing on them. Only abnormal
 * terminations (signal/timeout kill) throw, with the captured stderr, so a
 * red states what actually happened.
 */
export interface WorkBuddyHookRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunEntryOptions {
  timeoutMs?: number;
  /** JS injected into the child BEFORE the hook module is imported (belt tests). */
  childPrelude?: string;
  /** JS run in the child AFTER the import resolves (belt tests). */
  childPostlude?: string;
  /** Extra env overrides (e.g. PD_WORKBUDDY_ADAPTER_ENTRY for the wrapper). */
  env?: Record<string, string>;
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.resolve(PACKAGE_ROOT, 'dist', 'pd-hook.js');
const WRAPPER = path.resolve(PACKAGE_ROOT, 'plugin', 'scripts', 'wrapper.cjs');

function homeEnv(homeDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    USERPROFILE: homeDir,
    HOME: homeDir,
    ...(extra ?? {}),
  };
}

function assertEntryBuilt(): void {
  if (!ENTRY.startsWith(`${PACKAGE_ROOT}${path.sep}`) || !fs.statSync(ENTRY).isFile()) {
    throw new Error(`hook entry not found or outside the package: ${ENTRY} (run npm run build in packages/workbuddy-adapter)`);
  }
}

function interpret(result: ReturnType<typeof spawnSync>, what: string): WorkBuddyHookRunResult {
  if (result.error) throw new Error(`${what} spawn failed: ${String(result.error.message)}`);
  if (result.status === null || result.signal !== null) {
    throw new Error(
      `${what} terminated abnormally (status=${String(result.status)}, signal=${String(result.signal)}). `
        + `An abnormal kill (harness timeout / external signal) is environmental, NOT a governance outcome — re-run before treating it as a regression.\n--- subprocess stderr ---\n${String(result.stderr).slice(0, 4000)}`,
    );
  }
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

/** Build the `node -e` script for damaged-environment belt cases; argv[1]/argv[2] point at the real entry so the entry guard fires. */
function buildInjectedScript(entry: string, entryUrl: string, channel: string | undefined, prelude?: string, postlude?: string): string {
  return [
    `process.argv[1] = ${JSON.stringify(entry)};`,
    ...(channel !== undefined ? [`process.argv[2] = ${JSON.stringify(channel)};`] : []),
    prelude ?? '',
    `import(${JSON.stringify(entryUrl)})`,
    `.then(() => { ${postlude ?? ''} })`,
    `.catch((error) => { console.error('IMPORT_FAILED', error && error.message); process.exit(9); });`,
  ].join('\n');
}

/** Run the built pd-hook entry in a fresh subprocess with a controlled fake home. */
export function runEntry(homeDir: string, payloadJson: string, channel?: string, options: RunEntryOptions = {}): WorkBuddyHookRunResult {
  assertEntryBuilt();
  const timeout = options.timeoutMs ?? 15_000;
  const injected = options.childPrelude !== undefined || options.childPostlude !== undefined;
  const argv = injected
    ? ['-e', buildInjectedScript(ENTRY, pathToFileURL(ENTRY).href, channel, options.childPrelude, options.childPostlude)]
    : [ENTRY, ...(channel !== undefined ? [channel] : [])];
  const result = spawnSync(process.execPath, argv, {
    input: payloadJson,
    encoding: 'utf8',
    env: homeEnv(homeDir, options.env),
    windowsHide: true,
    timeout,
  });
  return interpret(result, 'pd-hook entry');
}

/** Run the plugin wrapper (real transport path the WorkBuddy host executes). */
export function runWrapper(homeDir: string, payloadJson: string, channel: string, options: RunEntryOptions = {}): WorkBuddyHookRunResult {
  const timeout = options.timeoutMs ?? 15_000;
  const result = spawnSync(process.execPath, [WRAPPER, channel], {
    input: payloadJson,
    encoding: 'utf8',
    env: homeEnv(homeDir, options.env),
    windowsHide: true,
    timeout,
  });
  return interpret(result, 'plugin wrapper');
}

export const PACKAGE_ENTRY = ENTRY;
export const PLUGIN_WRAPPER = WRAPPER
