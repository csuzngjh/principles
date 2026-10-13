/**
 * PRI-961 — regression tests for scripts/lint-by-package.mjs.
 *
 * The scheduler's contract under test:
 * - package discovery from root `workspaces` (no hardcoded list; new packages
 *   auto-included; dirs without package.json excluded; POSIX rel paths),
 * - per-package ESLint args (same glob + the three ignore patterns +
 *   --no-error-on-unmatched-pattern; extra args like --fix forwarded),
 * - strictly serial child execution (no two children alive at once),
 * - failure semantics (lint failure, spawn error, signal kill → non-zero
 *   overall, remaining packages still run, failures named),
 * - interrupt handling (SIGINT kills the running child, stops the loop,
 *   reports interrupted, never reports success).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';

import {
  buildEslintArgs,
  discoverPackageRelDirs,
  repoRootFromModuleUrl,
  runLintByPackage,
} from '../lint-by-package.mjs';

function makeFixtureRoot({ packages }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-by-pkg-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }),
  );
  fs.mkdirSync(path.join(root, 'node_modules', 'eslint', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'), '// stub\n');
  for (const name of packages) {
    fs.mkdirSync(path.join(root, 'packages', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', name, 'package.json'), '{}');
  }
  return root;
}

/** Fake spawn: resolves each child via queued outcome (`hold` = manual close); records serial overlaps. */
function makeFakeSpawn({ outcomes = [], recorder }) {
  const spawnChild = (cmd, args, opts) => {
    if (recorder.pending > 0) recorder.overlaps += 1;
    recorder.pending += 1;
    const rel = String(args[1]).replace(/\/\*\*\/\*\.ts$/, '');
    recorder.calls.push({ cmd, args, opts, rel });
    const child = new EventEmitter();
    child.kill = (signal) => {
      child.killedWith = signal;
    };
    const outcome = outcomes[recorder.calls.length - 1] ?? { code: 0 };
    child.closeWith = (code, signal = null) => {
      recorder.pending -= 1;
      child.emit('close', code, signal);
    };
    if (!outcome.hold) {
      queueMicrotask(() => {
        if (outcome.error) child.emit('error', outcome.error);
        else child.closeWith(outcome.code ?? 0, outcome.signal ?? null);
      });
    }
    return child;
  };
  return spawnChild;
}

function makeSignalTarget() {
  const handlers = new Map();
  return {
    on: (signal, handler) => {
      const list = handlers.get(signal) ?? [];
      list.push(handler);
      handlers.set(signal, list);
    },
    off: (signal, handler) => {
      handlers.set(signal, (handlers.get(signal) ?? []).filter((h) => h !== handler));
    },
    emit: (signal) => {
      for (const handler of [...(handlers.get(signal) ?? [])]) handler(signal);
    },
  };
}

describe('lint-by-package', () => {
  let roots = [];

  function fixture(options) {
    const root = makeFixtureRoot(options);
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  describe('discoverPackageRelDirs', () => {
    it('discovers workspace packages, skips dirs without package.json, sorts stably', () => {
      const root = fixture({ packages: ['beta', 'alpha'] });
      fs.mkdirSync(path.join(root, 'packages', 'not-a-package'), { recursive: true });
      const relDirs = discoverPackageRelDirs(root);
      assert.deepEqual(relDirs, ['packages/alpha', 'packages/beta']);
    });

    it('auto-includes a newly added workspace package without list changes', () => {
      const root = fixture({ packages: ['alpha'] });
      assert.deepEqual(discoverPackageRelDirs(root), ['packages/alpha']);
      fs.mkdirSync(path.join(root, 'packages', 'gamma'), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages', 'gamma', 'package.json'), '{}');
      assert.deepEqual(discoverPackageRelDirs(root), ['packages/alpha', 'packages/gamma']);
    });

    it('returns POSIX-separated relative paths on Windows', () => {
      const root = fixture({ packages: ['one'] });
      for (const rel of discoverPackageRelDirs(root)) {
        assert.equal(rel.includes('\\'), false, `backslash leaked into rel dir: ${rel}`);
      }
    });
  });

  describe('buildEslintArgs', () => {
    it('builds the same per-package invocation as the old full-repo command', () => {
      const args = buildEslintArgs('packages/pd-cli');
      assert.equal(args[0], 'packages/pd-cli/**/*.ts');
      assert.deepEqual(args.slice(1, 7), [
        '--ignore-pattern', '**/*.test.ts',
        '--ignore-pattern', '**/*.spec.ts',
        '--ignore-pattern', '**/*.d.ts',
      ]);
      assert.equal(args[7], '--no-error-on-unmatched-pattern');
      assert.equal(args.length, 8);
    });

    it('forwards extra args (e.g. --fix) after the fixed contract args', () => {
      const args = buildEslintArgs('packages/core', ['--fix']);
      assert.deepEqual(args.slice(-1), ['--fix']);
    });
  });

  describe('runLintByPackage', () => {
    function recorder() {
      return { calls: [], pending: 0, overlaps: 0 };
    }

    it('lints every package serially with inherit stdio, no shell, repo cwd', async () => {
      const root = fixture({ packages: ['alpha', 'beta'] });
      const rec = recorder();
      const { ok, interrupted, results } = await runLintByPackage({
        root,
        spawnChild: makeFakeSpawn({ recorder: rec }),
        log: () => {},
      });
      assert.equal(ok, true);
      assert.equal(interrupted, false);
      assert.deepEqual(results.map((r) => [r.package, r.ok]), [
        ['packages/alpha', true],
        ['packages/beta', true],
      ]);
      assert.equal(rec.overlaps, 0, 'two child processes were alive at once');
      assert.equal(rec.calls.length, 2);
      for (const call of rec.calls) {
        assert.equal(call.cmd, process.execPath);
        assert.match(call.args[0], /eslint\.js$/);
        assert.equal(call.opts.cwd, root);
        assert.equal(call.opts.shell, false);
        assert.deepEqual(call.opts.stdio, 'inherit');
      }
      assert.equal(rec.calls[0].rel, 'packages/alpha');
      assert.equal(rec.calls[1].rel, 'packages/beta');
    });

    it('forwards extra args (--fix) to every child invocation', async () => {
      const root = fixture({ packages: ['alpha'] });
      const rec = recorder();
      await runLintByPackage({
        root,
        args: ['--fix'],
        spawnChild: makeFakeSpawn({ recorder: rec }),
        log: () => {},
      });
      assert.deepEqual(rec.calls[0].args.slice(-1), ['--fix']);
    });

    it('continues after a failing package and reports overall failure naming it', async () => {
      const root = fixture({ packages: ['alpha', 'beta', 'gamma'] });
      const rec = recorder();
      const logs = [];
      const { ok, results } = await runLintByPackage({
        root,
        spawnChild: makeFakeSpawn({ recorder: rec, outcomes: [{ code: 0 }, { code: 1 }] }),
        log: (message) => logs.push(message),
      });
      assert.equal(ok, false);
      assert.equal(rec.calls.length, 3, 'packages after the failure must still be linted');
      assert.deepEqual(
        results.map((r) => [r.package, r.ok, r.code]),
        [['packages/alpha', true, 0], ['packages/beta', false, 1], ['packages/gamma', true, 0]],
      );
      const summary = logs.find((line) => line.includes('summary'));
      assert.match(summary, /FAILED: packages\/beta/);
    });

    it('treats a spawn error as a failure, not a success', async () => {
      const root = fixture({ packages: ['alpha'] });
      const rec = recorder();
      const { ok, results } = await runLintByPackage({
        root,
        spawnChild: makeFakeSpawn({
          recorder: rec,
          outcomes: [{ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }],
        }),
        log: () => {},
      });
      assert.equal(ok, false);
      assert.equal(results[0].ok, false);
      assert.match(results[0].error, /ENOENT/);
    });

    it('treats a signal-killed child as a failure, not a success', async () => {
      const root = fixture({ packages: ['alpha'] });
      const rec = recorder();
      const { ok, results } = await runLintByPackage({
        root,
        spawnChild: makeFakeSpawn({ recorder: rec, outcomes: [{ code: null, signal: 'SIGKILL' }] }),
        log: () => {},
      });
      assert.equal(ok, false);
      assert.equal(results[0].signal, 'SIGKILL');
    });

    it('stops on SIGINT: kills the running child, skips the rest, never reports success', async () => {
      const root = fixture({ packages: ['alpha', 'beta'] });
      const rec = recorder();
      const signals = makeSignalTarget();
      const logs = [];
      let firstChild;
      const spawnChild = (cmd, args, opts) => {
        const child = makeFakeSpawn({ recorder: rec, outcomes: [{ hold: true }] })(cmd, args, opts);
        firstChild ??= child;
        return child;
      };
      const runPromise = runLintByPackage({
        root,
        spawnChild,
        log: (message) => logs.push(message),
        signalTarget: signals,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(firstChild, 'first child should be running');
      signals.emit('SIGINT');
      assert.equal(firstChild.killedWith, 'SIGINT', 'running child was not killed');
      firstChild.closeWith(null, 'SIGINT');
      const { ok, interrupted } = await runPromise;
      assert.equal(rec.calls.length, 1, 'next package must not be spawned after interrupt');
      assert.equal(interrupted, true);
      assert.equal(ok, false);
      assert.ok(logs.some((line) => line.includes('interrupted')));
    });
  });

  describe('bootstrap failures', () => {
    it('fails loudly when the local ESLint CLI is missing', async () => {
      const root = fixture({ packages: ['alpha'] });
      fs.rmSync(path.join(root, 'node_modules', 'eslint'), { recursive: true, force: true });
      await assert.rejects(
        runLintByPackage({ root, spawnChild: () => { throw new Error('must not spawn'); }, log: () => {} }),
        /ESLint CLI not found/,
      );
    });
  });

  describe('repoRootFromModuleUrl', () => {
    it('resolves the repository root from a scripts/ module URL', () => {
      const moduleUrl = new URL('../lint-by-package.mjs', import.meta.url).href;
      const root = repoRootFromModuleUrl(moduleUrl);
      assert.equal(root, path.resolve(fileURLToPath(moduleUrl), '..', '..'));
      assert.ok(fs.existsSync(path.join(root, 'package.json')), 'repo root must contain package.json');
    });
  });
});
