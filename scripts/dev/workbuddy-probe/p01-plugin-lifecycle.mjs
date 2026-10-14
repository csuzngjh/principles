#!/usr/bin/env node
/**
 * WorkBuddy host probe P01 — plugin lifecycle (marketplace → install → enabledPlugins →
 * hooks fire → uninstall → hooks stop), fully inside an isolated config dir.
 *
 * Preconditions:
 *   - WorkBuddy desktop installed (engine path below); no WorkBuddy/desktop assumptions
 *     beyond the engine file existing.
 *   - Isolation lab dir prepared (see README.md): iso-home with models.json (custom mock
 *     model) is REQUIRED only for the "hooks fire" session check.
 *
 * Usage: node p01-plugin-lifecycle.mjs
 * Writes: <LAB>/p01-results.json
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LAB = process.env.WB_PROBE_LAB || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', 'wb-probe-lab');
const ENGINE = process.env.WB_ENGINE || 'D:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';
const NODE = process.execPath;
const ISO = path.join(LAB, 'iso-home');
const env = { ...process.env, WORKBUDDY_CONFIG_DIR: ISO, CODEBUDDY_CONFIG_DIR: ISO };
const results = [];
function step(name, pass, detail) { results.push({ name, pass: !!pass, detail: detail || '' }); console.log(pass ? 'PASS' : 'FAIL', name, detail || ''); }
function eng(args, opts = {}) { return spawnSync(NODE, [ENGINE, ...args], { env, encoding: 'utf8', timeout: 120000, ...opts }); }

// 1. marketplace add (local dir)
let r = eng(['plugin', 'marketplace', 'add', path.join(LAB, 'marketplace')]);
step('marketplace add local dir', /added successfully|already/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim().slice(0, 120));

// 2. install
r = eng(['plugin', 'install', 'pd-probe@pd-probe-market']);
step('plugin install', /Successfully installed/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim().slice(0, 120));

// 3. settings.json enabledPlugins format
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path.join(ISO, 'settings.json'), 'utf8')); } catch {}
step('settings enabledPlugins key format name@marketplace=true', settings.enabledPlugins && settings.enabledPlugins['pd-probe@pd-probe-market'] === true,
  JSON.stringify(settings.enabledPlugins || null));

// 4. registry + cache layout
const reg = JSON.parse(fs.readFileSync(path.join(ISO, 'plugins/installed_plugins.json'), 'utf8'));
const entry = reg.plugins['pd-probe@pd-probe-market'];
const cacheOk = entry && fs.existsSync(path.join(ISO, 'plugins/cache/pd-probe-market/pd-probe/0.1.0/.codebuddy-plugin/plugin.json'));
step('installed_plugins.json v2 + versioned cache layout', reg.version === 2 && !!entry && cacheOk, entry ? entry.installPath : 'missing');

// 5. hooks fire in a NEW session (engine -p, mock model; SessionStart is enough)
fs.writeFileSync(path.join(LAB, 'scenario.txt'), '*=neutral\n');
try { fs.unlinkSync(path.join(LAB, 'hook-events/hook-log.jsonl')); } catch {}
r = eng(['-p', 'say P1', '--model', 'wb-probe-mock', '--no-session-persistence'], { cwd: path.join(LAB, 'proj-a') });
let hooks = [];
try { hooks = fs.readFileSync(path.join(LAB, 'hook-events/hook-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
const ss = hooks.find(h => h.eventArg === 'sessionstart');
step('SessionStart hook fires from marketplace-installed plugin in new session', !!ss, ss ? 'PLUGIN_ROOT=' + ss.env.CODEBUDDY_PLUGIN_ROOT : 'no hook fired');

// 6. uninstall
r = eng(['plugin', 'uninstall', 'pd-probe@pd-probe-market']);
step('plugin uninstall', /Successfully uninstalled/i.test(r.stdout + r.stderr), (r.stdout + r.stderr).trim().slice(0, 120));

// 7. settings restored (entry removed, other keys preserved)
settings = JSON.parse(fs.readFileSync(path.join(ISO, 'settings.json'), 'utf8'));
step('settings enabledPlugins entry removed after uninstall', !settings.enabledPlugins['pd-probe@pd-probe-market'], JSON.stringify(settings.enabledPlugins));

// 8. hooks no longer fire (only count events from AFTER this check started — the
//    uninstall CLI process itself fires SessionStart hooks at its own startup)
const step8Start = new Date(Date.now() - 1000).toISOString();
try { fs.unlinkSync(path.join(LAB, 'hook-events/hook-log.jsonl')); } catch {}
r = eng(['-p', 'say P1b', '--model', 'wb-probe-mock', '--no-session-persistence'], { cwd: path.join(LAB, 'proj-a') });
let lateHooks = [];
try {
  lateHooks = fs.readFileSync(path.join(LAB, 'hook-events/hook-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(h => h.t >= step8Start);
} catch {}
step('no plugin hooks fire after uninstall', lateHooks.length === 0, lateHooks.map(h => h.eventArg + '@' + h.t).join(',') || 'clean');

// 9. reinstall (leave lab in working state for other probes)
r = eng(['plugin', 'install', 'pd-probe@pd-probe-market']);
step('reinstall for subsequent probes', /Successfully installed/i.test(r.stdout + r.stderr));

fs.writeFileSync(path.join(LAB, 'p01-results.json'), JSON.stringify(results, null, 1));
const failed = results.filter(x => !x.pass);
console.log(failed.length ? 'P01 FAILURES: ' + failed.length : 'P01 ALL PASS (' + results.length + ')');
process.exit(failed.length ? 1 : 0);
