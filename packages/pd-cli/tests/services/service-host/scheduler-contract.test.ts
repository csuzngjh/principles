/**
 * Phase 3 scheduler adapters — pure contract/builder unit tests (PRI-1281).
 *
 * Covers the platform-neutral pieces: identity derivation stability, interval
 * validation bounds, the exact managed-run invocation arguments, the three
 * platform registration documents (Task Scheduler XML / LaunchAgent plist /
 * systemd user units) and their interval parsers. No OS interaction.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULER_INTERVAL_MS,
  MAX_SCHEDULER_INTERVAL_MS,
  MIN_SCHEDULER_INTERVAL_MS,
  schedulerIdentityFor,
  schedulerInvocationArgs,
  validateSchedulerIntervalMs,
  type SchedulerRegistration,
} from '../../../src/services/service-host/scheduler/contract.js';
import { buildWindowsTaskXml, parseWindowsIntervalMs } from '../../../src/services/service-host/scheduler/windows.js';
import { buildMacosLaunchAgentPlist, parseMacosStartIntervalMs } from '../../../src/services/service-host/scheduler/macos.js';
import { buildLinuxServiceUnit, buildLinuxTimerUnit, parseLinuxTimerIntervalMs } from '../../../src/services/service-host/scheduler/linux.js';

const BASE_DIR = path.join(os.tmpdir(), 'pd-scheduler-contract-tests');

function makeRegistration(overrides: {
  pdHome?: string;
  cliEntry?: string;
  nodePath?: string;
  intervalMs?: number;
} = {}): SchedulerRegistration {
  const pdHome = overrides.pdHome ?? path.join(BASE_DIR, 'alpha', '.pd');
  const cliEntry = overrides.cliEntry ?? path.join(BASE_DIR, 'releases', 'active', 'index.js');
  const nodePath = overrides.nodePath ?? path.join(BASE_DIR, 'runtime', 'node.exe');
  const intervalMs = overrides.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
  return { pdHome, homeDir: path.dirname(pdHome), cliEntry, nodePath, intervalMs, identity: schedulerIdentityFor(pdHome) };
}

describe('schedulerIdentityFor', () => {
  it('is stable for the same pdHome', () => {
    const pdHome = path.join(BASE_DIR, 'alpha', '.pd');
    expect(schedulerIdentityFor(pdHome)).toEqual(schedulerIdentityFor(pdHome));
  });

  it('differs across pdHomes (one install = one registration identity)', () => {
    const alpha = schedulerIdentityFor(path.join(BASE_DIR, 'alpha', '.pd'));
    const beta = schedulerIdentityFor(path.join(BASE_DIR, 'beta', '.pd'));
    expect(alpha.installKey).not.toBe(beta.installKey);
  });

  it('derives the three platform names from a 10-hex install key', () => {
    const identity = schedulerIdentityFor(path.join(BASE_DIR, 'alpha', '.pd'));
    expect(identity.installKey).toMatch(/^[0-9a-f]{10}$/);
    expect(identity.windowsTaskName).toBe(`PrinciplesDisciple-ServiceHost-${identity.installKey}`);
    expect(identity.macosLabel).toBe(`com.principles-disciple.service-host.${identity.installKey}`);
    expect(identity.linuxUnitBase).toBe(`pd-service-host-${identity.installKey}`);
  });

  it.runIf(process.platform === 'win32')('folds path case on win32 so one install cannot register twice', () => {
    expect(schedulerIdentityFor('D:\\PD Home').installKey).toBe(schedulerIdentityFor('d:\\pd home').installKey);
  });

  it.skipIf(process.platform === 'win32')('keeps path case on posix (two installs stay distinct)', () => {
    expect(schedulerIdentityFor('/tmp/PD-Home').installKey).not.toBe(schedulerIdentityFor('/tmp/pd-home').installKey);
  });
});

describe('validateSchedulerIntervalMs', () => {
  it('defaults to 120000 ms when undefined', () => {
    expect(validateSchedulerIntervalMs(undefined)).toEqual({ ok: true, intervalMs: 120_000 });
    expect(DEFAULT_SCHEDULER_INTERVAL_MS).toBe(120_000);
  });

  it('accepts the floor (60s — the Windows repetition minimum) and the ceiling (30 days)', () => {
    expect(validateSchedulerIntervalMs(MIN_SCHEDULER_INTERVAL_MS)).toEqual({ ok: true, intervalMs: 60_000 });
    expect(validateSchedulerIntervalMs(MAX_SCHEDULER_INTERVAL_MS)).toEqual({ ok: true, intervalMs: 2_592_000_000 });
  });

  it('rejects 59999 (sub-minute intervals are rejected — Task Scheduler refuses PT<1M) with the scheduler_interval_out_of_range reason', () => {
    const result = validateSchedulerIntervalMs(59_999);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('scheduler_interval_out_of_range:59999');
    expect(result.nextAction).toContain('--interval-ms');
  });

  it('rejects non-integer values', () => {
    const result = validateSchedulerIntervalMs(60_000.5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('scheduler_interval_out_of_range:60000.5');
  });

  it('rejects values above the 30-day ceiling', () => {
    const result = validateSchedulerIntervalMs(MAX_SCHEDULER_INTERVAL_MS + 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.startsWith('scheduler_interval_out_of_range:')).toBe(true);
  });
});

describe('schedulerInvocationArgs', () => {
  it('is the exact managed-run command line shared by every platform (--pd-home carries the HOME ROOT)', () => {
    const registration = makeRegistration();
    expect(schedulerInvocationArgs(registration)).toEqual([
      registration.cliEntry,
      'service',
      'run-once',
      '--json',
      '--trigger',
      'scheduler',
      '--pd-home',
      registration.homeDir,
    ]);
    // The CLI derives <home>/.pd from the trusted home itself — passing the
    // .pd dir would resolve to <home>/.pd/.pd.
    expect(registration.homeDir).not.toBe(registration.pdHome);
  });
});

describe('buildWindowsTaskXml', () => {
  it('embeds the node command, quoted entry arguments, pdHome and the disabled-by-default settings', () => {
    const registration = makeRegistration();
    const xml = buildWindowsTaskXml(registration);
    expect(xml).toContain(`<Command>${registration.nodePath}</Command>`);
    // The cliEntry is quoted in the argument string; the quotes are part of
    // the XML text and therefore serialized as &quot; entities.
    expect(xml).toContain(
      `<Arguments>&quot;${registration.cliEntry}&quot; service run-once --json --trigger scheduler --pd-home ${registration.homeDir}</Arguments>`,
    );
    expect(xml).toContain(`<WorkingDirectory>${registration.pdHome}</WorkingDirectory>`);
    expect(xml).toContain(`<Description>PD Service Host managed run-once trigger for pdHome ${registration.pdHome}.`);
    expect(xml).toContain('<Enabled>false</Enabled>'); // installed_disabled
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('__PD_TASK_USER__'); // principal substituted inside PowerShell
    expect(xml).not.toContain('LeastPrivilege'); // no RunLevel elevation token at all
  });

  it('maps the repetition interval to ISO-8601 durations', () => {
    expect(buildWindowsTaskXml(makeRegistration({ intervalMs: 120_000 }))).toContain('<Interval>PT2M</Interval>');
    expect(buildWindowsTaskXml(makeRegistration({ intervalMs: 30_000 }))).toContain('<Interval>PT30S</Interval>');
  });

  it('XML-escapes paths with spaces and CJK characters (no raw & anywhere)', () => {
    const pdHome = 'D:\\PD Home 项目\\pd-test\\.pd';
    const registration = makeRegistration({ pdHome, cliEntry: 'D:\\PD Home 项目\\pd-test\\tools\\cli.js' });
    const xml = buildWindowsTaskXml(registration);
    expect(xml).toContain(`<WorkingDirectory>${pdHome}</WorkingDirectory>`);
    expect(xml).toContain(`&quot;${registration.cliEntry}&quot;`);
    expect(xml).toContain(`<Description>PD Service Host managed run-once trigger for pdHome ${pdHome}.`);
    expect(xml.match(/&(?!amp;|lt;|gt;|quot;|apos;|#)/)).toBeNull();
  });
});

describe('buildMacosLaunchAgentPlist', () => {
  it('builds a RunAtLoad + StartInterval agent invoking node with our entry', () => {
    const registration = makeRegistration();
    const plist = buildMacosLaunchAgentPlist(registration);
    expect(plist).toContain(`<string>${registration.identity.macosLabel}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<true/>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>120</integer>');
    expect(plist).toContain(`<string>${registration.nodePath}</string>`);
    expect(plist).toContain(`<string>${registration.cliEntry}</string>`);
    expect(plist).toContain(`<string>${path.join(registration.pdHome, 'service', 'scheduler-stdout.log')}</string>`);
  });
});

describe('buildLinuxServiceUnit / buildLinuxTimerUnit', () => {
  it('quotes and escapes every ExecStart token (systemd quoting)', () => {
    const registration = makeRegistration({
      nodePath: 'C:\\node\\bin\\node.exe',
      cliEntry: '/opt/PD Dir/cli/index.js',
      pdHome: '/home/pd user/.pd',
    });
    const unit = buildLinuxServiceUnit(registration);
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain(
      'ExecStart="C:\\\\node\\\\bin\\\\node.exe" "/opt/PD Dir/cli/index.js" "service" "run-once" "--json" "--trigger" "scheduler" "--pd-home" "/home/pd user"',
    );
    expect(unit).toContain('WorkingDirectory=/home/pd user/.pd');
  });

  it('builds a timer that targets our service at the configured cadence', () => {
    const registration = makeRegistration({ intervalMs: 120_000 });
    const timer = buildLinuxTimerUnit(registration);
    expect(timer).toContain(`Unit=${registration.identity.linuxUnitBase}.service`);
    expect(timer).toContain('OnUnitActiveSec=120s');
    expect(timer).toContain('WantedBy=timers.target');
  });
});

describe('parseWindowsIntervalMs', () => {
  it('parses PT2M / PT30S and returns null when absent', () => {
    expect(parseWindowsIntervalMs('<Repetition><Interval>PT2M</Interval></Repetition>')).toBe(120_000);
    expect(parseWindowsIntervalMs('<Interval>PT30S</Interval>')).toBe(30_000);
    expect(parseWindowsIntervalMs('<Repetition><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>')).toBeNull();
  });
});

describe('parseMacosStartIntervalMs', () => {
  it('parses the StartInterval integer (seconds) and returns null when absent', () => {
    expect(parseMacosStartIntervalMs('  <key>StartInterval</key>\n  <integer>120</integer>')).toBe(120_000);
    expect(parseMacosStartIntervalMs('<dict>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>')).toBeNull();
  });
});

describe('parseLinuxTimerIntervalMs', () => {
  it("parses '120s', '2min' and '90ms' values; null when absent", () => {
    expect(parseLinuxTimerIntervalMs('[Timer]\nOnUnitActiveSec=120s\n')).toBe(120_000);
    expect(parseLinuxTimerIntervalMs('OnUnitActiveSec=2min')).toBe(120_000);
    expect(parseLinuxTimerIntervalMs('OnUnitActiveSec=90ms')).toBe(90);
    expect(parseLinuxTimerIntervalMs('[Timer]\nAccuracySec=30s\n')).toBeNull();
  });
});
