/**
 * Console successor — the process a Console starts when the installed release
 * changes under it (see release-handover.ts).
 *
 * It exists so a handover never launches a path it was handed: the predecessor
 * forks THIS module — a fixed name inside its own installed build, which an
 * update has already replaced with the new release's copy — and writes the
 * launch configuration to the successor's stdin. The successor then starts the
 * console exactly the way the packaged entry does, with one difference: it
 * keeps trying to bind while the predecessor is still releasing the port.
 *
 * stdin carries one JSON object, `{ "args": ["--workspace", "...", ...] }`:
 * the predecessor's own command-line arguments. It is untrusted input and is
 * validated field by field; anything else exits before a port is touched, so a
 * malformed or absent configuration never leaves a stray process behind.
 *
 * cli-7 / PRI-892 precedent: importing this module (a test driving
 * `parseSuccessorLaunchConfig`, for example) must NOT start a console or wait
 * on stdin — reading standard input blocks until it ends. Only direct
 * execution runs the successor.
 */

import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { main } from './index.js';

/** A console launch line is a handful of short flags; nothing legitimate is larger. */
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;

export interface SuccessorLaunchConfig {
  readonly args: readonly string[];
}

export function parseSuccessorLaunchConfig(raw: string): SuccessorLaunchConfig | null {
  if (raw.length > MAX_CONFIG_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const args = Object.hasOwn(value, 'args') ? Reflect.get(value, 'args') : undefined;
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS) return null;
  const copied: string[] = [];
  for (const argument of args) {
    if (typeof argument !== 'string' || argument.length > MAX_ARG_LENGTH || argument.includes('\0')) return null;
    copied.push(argument);
  }
  return { args: copied };
}

async function run(): Promise<void> {
  const config = parseSuccessorLaunchConfig(fs.readFileSync(0, 'utf8'));
  if (config === null) {
    console.error('[pd-console] Successor received no usable launch configuration; exiting.');
    process.exit(1);
  }
  // Configuration in hand: let go of the predecessor. An open IPC channel
  // would tie this process's lifetime to the one it is meant to replace.
  if (process.connected === true) process.disconnect?.();
  await main({
    // `[node, <this module>]` is all the console reads from the first two slots.
    argv: [...process.argv.slice(0, 2), ...config.args],
    keepTryingToBind: true,
  });
}

function isMainModuleEntry(): boolean {
  const [, entry] = process.argv;
  if (!entry) return false;
  try {
    return pathToFileURL(fs.realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModuleEntry()) {
  run().catch((error: unknown) => {
    console.error('[pd-console] Successor failed to start:', error);
    process.exit(1);
  });
}
