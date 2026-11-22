/**
 * Service Host scheduler bridge — REAL cross-package integration tests
 * (task §1 review): the bridge's strict stdout contract is exercised
 * through a REAL spawned node process writing to a REAL stdout — never a
 * faked ChildProcess.
 *
 * Two layers:
 *
 *  1. REAL pd-cli: `<pdHome>/runtime/pd-cli` is a symlink to the built
 *     monorepo package, so `pd service status/install/uninstall --json`
 *     run the shipping implementation end-to-end (unit files, systemctl
 *     failure semantics included).
 *  2. Fixture CLI entries: a real `dist/index.js` script prints hostile
 *     stdout shapes (log-mixed JSON, multi-document, truncated, empty,
 *     wrong schema) — the bridge must refuse each one distinctly and
 *     NEVER interpret a parse failure as "scheduler not registered".
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runServiceHostCli } from '../src/service-host-bridge.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pd-bridge-int-'));
  dirs.push(dir);
  // The real pd-cli records invocations under `os.homedir()/.pd` — the
  // spawned process inherits our env, so point HOME/USERPROFILE at the
  // temp home; the real home must never be touched by a test run.
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}
afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The real, built pd-cli package (monorepo sibling). */
const REAL_PD_CLI_PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'pd-cli');
const REAL_CLI_ENTRY = path.join(REAL_PD_CLI_PACKAGE, 'dist', 'index.js');
const realCliAvailable = existsSync(REAL_CLI_ENTRY);

/**
 * Materialize `<home>/.pd/runtime/pd-cli` pointing at the REAL package so
 * the bridge's `<pdHome>/runtime/pd-cli/dist/index.js` entry check + spawn
 * hit the shipping CLI, dependencies and all.
 */
function realInstalledCli(home: string): string {
  const pdHome = path.join(home, '.pd');
  mkdirSync(path.join(pdHome, 'runtime'), { recursive: true });
  symlinkSync(REAL_PD_CLI_PACKAGE, path.join(pdHome, 'runtime', 'pd-cli'), 'dir');
  return pdHome;
}

/** Materialize a fixture CLI entry: a real script run by a real node. */
function fixtureCli(home: string, scriptBody: string): string {
  const pdHome = path.join(home, '.pd');
  const entry = path.join(pdHome, 'runtime', 'pd-cli', 'dist', 'index.js');
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, scriptBody, 'utf8');
  return pdHome;
}

describe('runServiceHostCli — REAL pd-cli stdout round-trip (task §1)', () => {
  it.skipIf(!realCliAvailable)('pd service status on a fresh home: ONE JSON document, registered=false', async () => {
    const home = tempHome();
    const pdHome = realInstalledCli(home);

    const outcome = await runServiceHostCli(pdHome, ['service', 'status']);

    // A real spawn + real stdout: the contract's happy path end-to-end.
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe('ok');
    expect(outcome.registered).toBe(false);
  }, 60_000);

  it.skipIf(!realCliAvailable)('pd service uninstall on an unregistered home is an honest no-op over real stdout', async () => {
    const home = tempHome();
    const pdHome = realInstalledCli(home);

    const outcome = await runServiceHostCli(pdHome, ['service', 'uninstall']);

    expect(outcome.ok).toBe(true);
  }, 60_000);

  it.skipIf(!realCliAvailable)('pd service install: a real CLI failure round-trips as a REFUSAL, never a parse error (Linux bus may be absent)', async () => {
    const home = tempHome();
    const pdHome = realInstalledCli(home);

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    // On a box with a live systemd --user manager this registers
    // successfully; without one the REAL CLI emits a structured failure
    // JSON on exit≠0 which must surface as `service_host_cli_refused:*`
    // — a distinct class from spawn/parse/schema failures, and NEVER
    // silently interpreted.
    if (outcome.ok) {
      expect(outcome.detail).toBe('ok');
      const status = await runServiceHostCli(pdHome, ['service', 'status']);
      expect(status.ok).toBe(true);
      expect(status.registered).toBe(true);
      const removed = await runServiceHostCli(pdHome, ['service', 'uninstall']);
      expect(removed.ok).toBe(true);
    } else {
      expect(outcome.detail.startsWith('service_host_cli_refused:')).toBe(true);
      // The refusal reason carries the CLI's real reason — e.g.
      // systemctl_daemon_reload_failed on a host without a user bus.
      expect(outcome.nextAction ?? '').not.toBe('');
    }
  }, 90_000);

  it.skipIf(!realCliAvailable)('pd service enable on an unregistered home refuses truthfully over real stdout', async () => {
    const home = tempHome();
    const pdHome = realInstalledCli(home);

    const outcome = await runServiceHostCli(pdHome, ['service', 'enable']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('service_host_cli_refused:scheduler_not_registered');
  }, 60_000);
});

describe('runServiceHostCli — hostile REAL stdout fails closed (task §1)', () => {
  it('a log line before the JSON document is refused (no line-scanning)', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(
      home,
      'console.log("boot log: pd-cli starting");\nconsole.log(JSON.stringify({ok:true}));\n',
    );

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_unparsable_json')).toBe(true);
  });

  it('TWO JSON documents on stdout are refused — exactly one document is the contract', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(
      home,
      'console.log(JSON.stringify({ok:true}));\nconsole.log(JSON.stringify({ok:true}));\n',
    );

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_unparsable_json')).toBe(true);
  });

  it('a truncated JSON document is refused', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(home, 'process.stdout.write("{\\"ok\\":true,");\n');

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_unparsable_json')).toBe(true);
  });

  it('an EMPTY stdout (crash before output, exit≠0) is a distinct failure class', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(home, 'process.stderr.write("fatal: cannot boot");\nprocess.exit(2);\n');

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_no_json:exit_2')).toBe(true);
  });

  it('an EMPTY stdout with exit 0 is still a no_json failure (not a success)', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(home, 'process.exit(0);\n');

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_no_json:exit_0')).toBe(true);
  });

  it('a JSON document without a boolean `ok` field is a schema violation', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(home, 'console.log(JSON.stringify({status:"fine"}));\n');

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('service_host_cli_schema_violation:ok_field');
  });

  it('a refused op carrying a real reason surfaces `service_host_cli_refused:<reason>`', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(
      home,
      'console.log(JSON.stringify({ok:false,reason:"scheduler_query_failed:AccessDenied"}));\nprocess.exit(1);\n',
    );

    const outcome = await runServiceHostCli(pdHome, ['service', 'install']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('service_host_cli_refused:scheduler_query_failed:AccessDenied');
  });

  it('status: a document with an unknown schemaVersion is refused (never guessed)', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(
      home,
      'console.log(JSON.stringify({schemaVersion:"pd.service-status.v999",scheduler:{registered:false}}));\n',
    );

    const outcome = await runServiceHostCli(pdHome, ['service', 'status']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('service_host_cli_schema_violation:schema_version');
    expect(outcome.registered).toBe(false); // parsed evidence still surfaced, never a registration claim
  });

  it('status: a corrupt stdout is a parse failure — NEVER "scheduler not registered"', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(home, 'console.log("not json at all");\nprocess.exit(1);\n');

    const outcome = await runServiceHostCli(pdHome, ['service', 'status']);

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.startsWith('service_host_cli_unparsable_json')).toBe(true);
    expect(outcome.registered).toBeUndefined(); // no registration claim is made either way
  });

  it('status: stderr noise beside a VALID single JSON document is tolerated', async () => {
    const home = tempHome();
    const pdHome = fixtureCli(
      home,
      'process.stderr.write("warn: verbose diagnostics\\n");\nconsole.log(JSON.stringify({schemaVersion:"pd.service-status.v1",scheduler:{registered:true,enabled:false}}));\n',
    );

    const outcome = await runServiceHostCli(pdHome, ['service', 'status']);

    expect(outcome.ok).toBe(true);
    expect(outcome.registered).toBe(true);
  });
});
