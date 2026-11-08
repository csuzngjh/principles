/**
 * Cross-process child for the control-state concurrency tests (PRI-1151).
 *
 * Runs the REAL built production code (dist/, built before the test suites
 * in CI and by the developer locally) in a separate OS process. The parent
 * test drives it over a line-based stdio protocol so interleavings are
 * DETERMINISTIC (barriers), not sleeps. All inputs arrive on stdin — the
 * process itself is launched with fixed, literal arguments.
 *
 * stdin line protocol (first line, before READY):
 *   CONFIG <json>  {"homeDir":...,"mode":"...","arg1":...,"arg2":...}
 * then:
 *   RUN / PROCEED / FINISH
 *
 * stdout line protocol:
 *   READY / IN_LOCK / READ <json> / RESULT <json>
 *
 * Modes:
 *   migrate                     run migrateLegacyControlState; RESULT {ok}
 *   service-op <enable|disable|reset>
 *                               run the service mutation; RESULT {ok, consent?}
 *   hold <migrate|merge> [scope]
 *                               withControlStateLock transaction that parks
 *                               INSIDE the lock after readLatest: IN_LOCK →
 *                               (PROCEED) → READ {...} → (FINISH) → apply op
 *                               → release → RESULT
 *   rmw <counterPath>           locked read-modify-write on a counter file;
 *                               RESULT {ok, value}
 *   timeout                     withControlStateLock with a 400ms budget that
 *                               must fail loud while the parent holds the
 *                               lock; RESULT {ok:false, reason} — the body
 *                               never runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';

const here = path.dirname(fileURLToPath(import.meta.url));
const distModule = (relative) => pathToFileURL(path.join(here, relative)).href;
const { migrateLegacyControlState, withControlStateLock } = await import(distModule('../../dist/product-telemetry/consent-store.js'));
const { createProductTelemetryService } = await import(distModule('../../dist/product-telemetry/service.js'));

const out = (line) => process.stdout.write(`${line}\n`);
const stdin = readline.createInterface({ input: process.stdin });
const nextLine = () =>
  new Promise((resolve) => {
    stdin.once('line', (line) => resolve(String(line).trim()));
  });
const waitLine = (expected) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${expected}`)), 20_000);
    const onLine = (line) => {
      if (String(line).trim() === expected) {
        clearTimeout(timer);
        stdin.off('line', onLine);
        resolve(undefined);
      }
    };
    stdin.on('line', onLine);
  });

async function main() {
  const configLine = await nextLine();
  if (!configLine.startsWith('CONFIG ')) throw new Error(`expected CONFIG line, got: ${configLine.slice(0, 80)}`);
  const config = JSON.parse(configLine.slice('CONFIG '.length));
  const homeDir = config.homeDir;
  const mode = config.mode;
  const args = [config.arg1, config.arg2].filter((value) => value !== undefined);
  out('READY');
  await waitLine('RUN');
  if (mode === 'migrate') {
    const result = await migrateLegacyControlState(homeDir);
    out(`RESULT ${JSON.stringify(result)}`);
    return;
  }
  if (mode === 'service-op') {
    const service = createProductTelemetryService({ homeDir });
    const [op] = args;
    const result = op === 'enable' ? await service.enable() : op === 'disable' ? await service.disable() : await service.reset();
    out(`RESULT ${JSON.stringify(result)}`);
    return;
  }
  if (mode === 'hold') {
    const [op, scope = 'aaaa0000aaaa0000'] = args;
    const result = await withControlStateLock(homeDir, async (tx) => {
      out('IN_LOCK');
      await waitLine('PROCEED');
      const read = tx.readLatest();
      out(
        `READ ${JSON.stringify(
          read.ok
            ? { ok: true, diskSchemaVersion: read.diskSchemaVersion, consent: read.state.consent, hasSecret: read.state.telemetrySecret !== undefined }
            : read,
        )}`,
      );
      await waitLine('FINISH');
      if (!read.ok) return { ok: false, step: 'read', reason: read.reason };
      if (op === 'migrate') {
        if (read.diskSchemaVersion !== '1') return { ok: true, applied: false };
        const written = tx.write(read.state);
        return written.ok ? { ok: true, applied: true } : { ok: false, step: 'write', reason: written.reason };
      }
      if (op === 'merge') {
        if (read.state.consent !== 'granted') return { ok: true, applied: false, identityChanged: true };
        const next = {
          ...read.state,
          workspaceExports: {
            ...(read.state.workspaceExports ?? {}),
            [scope]: { lastAttemptedAt: new Date().toISOString(), lastSucceededAt: new Date().toISOString() },
          },
        };
        const written = tx.write(next);
        return written.ok ? { ok: true, applied: true } : { ok: false, step: 'write', reason: written.reason };
      }
      return { ok: true, applied: false };
    });
    out(`RESULT ${JSON.stringify(result.ok ? result.value : result)}`);
    return;
  }
  if (mode === 'rmw') {
    const [counterPath] = args;
    const result = await withControlStateLock(homeDir, async () => {
      let value = 0;
      try {
        value = JSON.parse(fs.readFileSync(counterPath, 'utf8')).value;
      } catch {
        value = 0;
      }
      const next = value + 1;
      fs.writeFileSync(counterPath, JSON.stringify({ value: next }));
      return next;
    });
    out(`RESULT ${JSON.stringify(result)}`);
    return;
  }
  if (mode === 'timeout') {
    const result = await withControlStateLock(
      homeDir,
      () => {
        throw new Error('body must not run while the parent holds the lock');
      },
      { timeoutMs: 400 },
    );
    out(`RESULT ${JSON.stringify(result)}`);
    return;
  }
  throw new Error(`unknown mode: ${mode}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
