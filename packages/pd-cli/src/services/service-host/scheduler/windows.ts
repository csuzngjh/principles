/**
 * Windows scheduler adapter — current-user Task Scheduler task via the
 * ScheduledTasks PowerShell module (SPEC-PD-SERVICE-HOST-001 §10.1, task §3.2).
 *
 * Protocol: every operation is ONE `powershell.exe -Command` script that
 *   - forces UTF-8 console output (ConvertTo-Json must not mojibake);
 *   - reports either a structured JSON body or `{ok:false, errorId, message}`
 *     from a single catch — the FullyQualifiedErrorId is a stable English
 *     identifier, so permission denial (AccessDenied) is NEVER confused with
 *     "task not found" (ScheduledTaskNotFound); localized stderr prose is
 *     never parsed;
 *   - receives file paths through environment variables — nothing is
 *     interpolated into the script except task names, which this package
 *     generates from [A-Za-z0-9-] only.
 *
 * Security shape (task §3.2): LogonTrigger + repeating TimeTrigger,
 * InteractiveToken principal ("run only when user is logged on"), RunLevel
 * LeastPrivilege (no elevation), absolute node/entry paths, no credentials,
 * MultipleInstancesPolicy=IgnoreNew (OS-level overlap convergence that
 * complements the install-level run lock).
 */
import * as path from 'node:path';
import { schedulerInvocationArgs } from './contract.js';
import type {
  SchedulerAdapter,
  SchedulerCommandRunner,
  SchedulerCommandResult,
  SchedulerFacts,
  SchedulerFileIo,
  SchedulerIdentity,
  SchedulerOperationResult,
  SchedulerRegistration,
} from './contract.js';

const POWERSHELL_ARGS_PREFIX = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const;

/** ISO-8601 duration for the Task XML repetition interval. */
export function windowsRepetitionDuration(intervalMs: number): string {
  if (intervalMs % 60_000 === 0) return `PT${Math.round(intervalMs / 60_000)}M`;
  return `PT${Math.round(intervalMs / 1000)}S`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

/** Max one run-once coordinator may legitimately take (own bounds are tighter). */
const EXECUTION_TIME_LIMIT = 'PT8H';

/**
 * The Task Scheduler XML definition. `__PD_TASK_USER__` is substituted with
 * `DOMAIN\user` INSIDE PowerShell (env-derived), never on the Node side.
 * Exported for unit tests.
 */
/** The Arguments element: quote the entry path (spaces/CJK safe); generated flags are plain words. */
function schedulerArgumentsString(registration: SchedulerRegistration): string {
  const args = schedulerInvocationArgs(registration);
  return `"${args[0]}" ${args.slice(1).join(' ')}`;
}

export function buildWindowsTaskXml(registration: SchedulerRegistration): string {
  const { nodePath, pdHome, intervalMs } = registration;
  const startBoundary = new Date().toISOString().replace(/\.\d{3}Z$/, ''); // local-ish, Task XML tolerant
  const args = schedulerArgumentsString(registration);
  return [
    // No encoding declaration: Task Scheduler's MSXML rejects a UTF-8
    // declaration on a string-sourced document with "cannot switch
    // encoding" (HRESULT 0x8004131a, verified on a real zh-CN host).
    '<?xml version="1.0"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>PD Service Host managed run-once trigger for pdHome ${escapeXml(pdHome)}. Installed by pd service install; remove with pd service uninstall.</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '      <UserId>__PD_TASK_USER__</UserId>',
    '    </LogonTrigger>',
    '    <TimeTrigger>',
    `      <StartBoundary>${startBoundary}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <Repetition>',
    `        <Interval>${windowsRepetitionDuration(intervalMs)}</Interval>`,
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    '    </TimeTrigger>',
    '  </Triggers>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    // installed_disabled: the registration exists but never fires until
    // `pd service enable` flips it (task §5).
    '    <Enabled>false</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    `    <ExecutionTimeLimit>${EXECUTION_TIME_LIMIT}</ExecutionTimeLimit>`,
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(nodePath)}</Command>`,
    `      <Arguments>${escapeXml(args)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(pdHome)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** Case-insensitive containment used for "ours" identity checks on Windows. */
function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

interface PowerShellQueryBody {
  readonly found: boolean;
  readonly state?: string;
  readonly xml?: string;
  readonly lastRunAt?: string;
  readonly lastResult?: number | string;
  readonly nextRunTime?: string;
}

interface PowerShellErrorBody {
  readonly ok: false;
  readonly errorId: string;
  readonly message: string;
}

/** Runtime guard for the error envelope (untrusted parsed JSON, rc-1/rc-3). */
function isPowerShellError(body: unknown): body is PowerShellErrorBody {
  if (typeof body !== 'object' || body === null) return false;
  // `=== false` is own-property safe: an inherited `ok` reads undefined.
  return (body as Partial<PowerShellErrorBody>).ok === false;
}

function isPowerShellQueryBody(value: unknown): value is PowerShellQueryBody {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'found')) return false;
  return typeof (value as { found?: unknown }).found === 'boolean';
}

function isPowerShellErrorBodyValue(value: unknown): value is PowerShellErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  return (value as Partial<PowerShellErrorBody>).ok === false && typeof (value as { errorId?: unknown }).errorId === 'string';
}

/** The mutation scripts' success ack. */
interface PowerShellMutationAck {
  readonly done: boolean;
}

function isPowerShellMutationAck(value: unknown): value is PowerShellMutationAck {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, 'done')) return false;
  return typeof (value as { done?: unknown }).done === 'boolean';
}

type PowerShellJsonBody = PowerShellQueryBody | PowerShellErrorBody | PowerShellMutationAck;

function parsePowerShellJson(stdout: string): { ok: true; body: PowerShellJsonBody } | { ok: false; reason: string } {
  const cleaned = stdout.replace(/^\uFEFF/, '').trim();
  if (cleaned === '') return { ok: false, reason: 'powershell_empty_output' };
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (isPowerShellQueryBody(parsed) || isPowerShellErrorBodyValue(parsed) || isPowerShellMutationAck(parsed)) {
      return { ok: true, body: parsed };
    }
    return { ok: false, reason: 'powershell_unexpected_output_shape' };
  } catch (error) {
    return { ok: false, reason: `powershell_unparsable_output:${error instanceof Error ? error.message.slice(0, 80) : 'unknown'}` };
  }
}

/** PowerShell's "never run" sentinel timestamp — report null instead. */
const NEVER_RUN_YEAR_PREFIX = '1899';

/** Parse `<Interval>PT2M</Interval>` / `PT30S` from the exported task XML. */
export function parseWindowsIntervalMs(xml: string): number | null {
  const match = /<Interval>PT(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?<\/Interval>/i.exec(xml);
  if (match === null) return null;
  const minutes = match[1] !== undefined ? Number(match[1]) : 0;
  const seconds = match[2] !== undefined ? Number(match[2]) : 0;
  const ms = Math.round((minutes * 60 + seconds) * 1000);
  return ms > 0 ? ms : null;
}

function factsFromQuery(identity: SchedulerIdentity, body: PowerShellQueryBody): SchedulerFacts {
  if (!body.found) {
    return { platform: 'win32', taskName: identity.windowsTaskName, registered: false, enabled: false, triggerIntervalMs: null, lastRunAt: null, lastResult: null };
  }
  const state = typeof body.state === 'string' ? body.state : '';
  // 267011 (0x41303) = SCHED_S_TASK_HAS_NOT_RUN — the never-run signal that
  // survives locale-dependent timestamp sentinels (real hosts observed with
  // both 1899- and 1999-dated sentinels).
  const neverRan = String(body.lastResult ?? '') === '267011';
  const lastRunAt = !neverRan && typeof body.lastRunAt === 'string' && !body.lastRunAt.startsWith(NEVER_RUN_YEAR_PREFIX)
    ? body.lastRunAt
    : null;
  return {
    platform: 'win32',
    taskName: identity.windowsTaskName,
    registered: true,
    enabled: state === '' ? null : state !== 'Disabled',
    triggerIntervalMs: typeof body.xml === 'string' ? parseWindowsIntervalMs(body.xml) : null,
    lastRunAt,
    lastResult: body.lastResult === undefined ? null : String(body.lastResult),
  };
}

export interface WindowsSchedulerDeps {
  readonly runner: SchedulerCommandRunner;
  readonly fileIo: SchedulerFileIo;
}

function queryScript(taskName: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
  $task = $null
  try { $task = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction Stop } catch { if ($_.FullyQualifiedErrorId -notmatch 'NotFound') { throw } }
  if ($null -eq $task) {
    [PSCustomObject]@{ found = $false } | ConvertTo-Json -Compress
  } else {
    $info = Get-ScheduledTaskInfo -TaskName '${taskName}'
    $xml = Export-ScheduledTask -TaskName '${taskName}'
    $lastRun = $null
    # 267011 (0x41303) = SCHED_S_TASK_HAS_NOT_RUN — the RELIABLE never-run
    # signal; the timestamp sentinel alone varies by locale/host (observed
    # 1899- AND 1999-dated sentinons on real hosts).
    if ($info.LastRunTime -and $info.LastTaskResult -ne 267011 -and $info.LastRunTime.Year -gt 1899) { $lastRun = $info.LastRunTime.ToString('o') }
    $lastResult = $null
    if ($null -ne $info.LastTaskResult) { $lastResult = [int]$info.LastTaskResult }
    $nextRun = $null
    if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1899) { $nextRun = $info.NextRunTime.ToString('o') }
    [PSCustomObject]@{ found = $true; state = [string]$task.State; xml = [string]$xml; lastRunAt = $lastRun; lastResult = $lastResult; nextRunTime = $nextRun } | ConvertTo-Json -Compress
  }
} catch {
  [PSCustomObject]@{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`.trim();
}

function mutationScript(body: string): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
try {
${body}
} catch {
  [PSCustomObject]@{ ok = $false; errorId = $_.FullyQualifiedErrorId; message = $_.Exception.Message } | ConvertTo-Json -Compress
}
`.trim();
}

export function createWindowsSchedulerAdapter(deps: WindowsSchedulerDeps): SchedulerAdapter {
  const { runner, fileIo } = deps;

  async function runPowerShell(script: string, extraEnv?: Readonly<Record<string, string>>): Promise<SchedulerCommandResult> {
    return runner.run('powershell.exe', [...POWERSHELL_ARGS_PREFIX, script], extraEnv);
  }

  /** Query the OS task. `not-found` is a normal verdict, everything else is structured. */
  async function queryTask(taskName: string): Promise<
    | { ok: true; body: PowerShellQueryBody }
    | { ok: false; kind: 'unavailable' | 'command_failed'; reason: string; nextAction: string }
  > {
    const result = await runPowerShell(queryScript(taskName));
    if (result.timedOut === true) {
      return { ok: false, kind: 'command_failed', reason: 'powershell_timeout', nextAction: 'The Task Scheduler query did not return in time; check powershell.exe availability and machine load, then retry.' };
    }
    if (result.spawnError !== undefined) {
      return { ok: false, kind: 'unavailable', reason: `powershell_unavailable:${result.spawnError.slice(0, 80)}`, nextAction: 'powershell.exe could not be started; the Windows scheduler adapter needs PowerShell (built into Windows).' };
    }
    const parsed = parsePowerShellJson(result.stdout);
    if (!parsed.ok) {
      return { ok: false, kind: 'command_failed', reason: parsed.reason, nextAction: 'The Task Scheduler PowerShell query returned unparsable output; re-run pd service status to see whether it is transient.' };
    }
    if (isPowerShellError(parsed.body)) {
      const errorId = parsed.body.errorId ?? 'unknown';
      // Permission denial must NEVER be reported as "not installed" (task §5).
      return {
        ok: false,
        kind: 'command_failed',
        reason: `scheduler_query_failed:${errorId}`,
        nextAction: `The Task Scheduler query failed (${errorId}: ${parsed.body.message ?? ''}). If this is an access-denied error, the task exists but this process may not read it — do not treat the install as unregistered.`,
      };
    }
    if (!isPowerShellQueryBody(parsed.body)) {
      return { ok: false, kind: 'command_failed', reason: 'powershell_unexpected_output_shape', nextAction: 'The Task Scheduler query returned an unexpected document shape; re-run pd service status to see whether it is transient.' };
    }
    return { ok: true, body: parsed.body };
  }

  /** Fail-closed ownership check: the exported definition must reference THIS install. */
  function ownershipVerdict(body: PowerShellQueryBody, registration: SchedulerRegistration): { ours: true } | { ours: false; conflict: 'external' } {
    if (!body.found || typeof body.xml !== 'string') return { ours: false, conflict: 'external' };
    const {xml} = body;
    // The definition carries XML-escaped paths — a real install path with
    // `& ' < >` chars must still match its own registration (special-char
    // paths are a task §3.2 requirement), so both forms are checked.
    const referencesEntry = containsIgnoreCase(xml, registration.cliEntry) || containsIgnoreCase(xml, escapeXml(registration.cliEntry));
    const referencesPdHome = containsIgnoreCase(xml, registration.pdHome) || containsIgnoreCase(xml, escapeXml(registration.pdHome));
    return referencesEntry && referencesPdHome ? { ours: true } : { ours: false, conflict: 'external' };
  }

  async function status(registration: SchedulerRegistration): Promise<SchedulerOperationResult> {
    const query = await queryTask(registration.identity.windowsTaskName);
    if (!query.ok) {
      return { ok: false, kind: query.kind, reason: query.reason, nextAction: query.nextAction };
    }
    return { ok: true, changed: false, facts: factsFromQuery(registration.identity, query.body) };
  }

  async function runMutation(
    registration: SchedulerRegistration,
    scriptBody: (taskName: string) => string,
    options?: { readonly extraEnv?: Readonly<Record<string, string>> },
  ): Promise<SchedulerOperationResult> {
    const taskName = registration.identity.windowsTaskName;
    const result = await runPowerShell(mutationScript(scriptBody(taskName)), options?.extraEnv);
    if (result.timedOut === true) {
      return { ok: false, kind: 'command_failed', reason: 'powershell_timeout', nextAction: 'The Task Scheduler mutation did not finish in time; re-run the command — operations are idempotent.' };
    }
    if (result.spawnError !== undefined) {
      return { ok: false, kind: 'unavailable', reason: `powershell_unavailable:${result.spawnError.slice(0, 80)}`, nextAction: 'powershell.exe could not be started; the Windows scheduler adapter needs PowerShell (built into Windows).' };
    }
    const parsed = parsePowerShellJson(result.stdout);
    if (!parsed.ok) {
      return { ok: false, kind: 'command_failed', reason: parsed.reason, nextAction: 'The Task Scheduler PowerShell mutation returned unparsable output; re-run the command and inspect the task with pd service status.' };
    }
    if (isPowerShellError(parsed.body)) {
      const errorId = parsed.body.errorId ?? 'unknown';
      return {
        ok: false,
        kind: 'command_failed',
        reason: `scheduler_mutation_failed:${errorId}`,
        nextAction: `The Task Scheduler operation failed (${errorId}: ${parsed.body.message ?? ''}). Nothing was silently skipped — re-run after fixing the cause; the operation is idempotent.`,
      };
    }
    const statusNow = await status(registration);
    if (!statusNow.ok) return statusNow;
    return { ...statusNow, changed: true };
  }

  return {
    platform: 'win32',

    async install(registration) {
      const taskName = registration.identity.windowsTaskName;
      const query = await queryTask(taskName);
      if (!query.ok) {
        return { ok: false, kind: query.kind, reason: query.reason, nextAction: query.nextAction };
      }
      if (query.body.found) {
        const ownership = ownershipVerdict(query.body, registration);
        if (!ownership.ours) {
          return {
            ok: false,
            kind: 'external_conflict',
            reason: 'scheduler_task_name_conflict_foreign_task',
            nextAction: `A Task Scheduler task named ${taskName} already exists but does not reference this PD install (${registration.pdHome}). PD never overwrites or deletes foreign registrations — remove or rename it manually, or inspect it with Export-ScheduledTask.`,
            facts: factsFromQuery(registration.identity, query.body),
          };
        }
        // Idempotent: our own registration is reused; the enabled/disabled
        // state is PRESERVED (task §5 install contract).
        return { ok: true, changed: false, facts: factsFromQuery(registration.identity, query.body) };
      }

      const xml = buildWindowsTaskXml(registration);
      const xmlDir = path.join(registration.pdHome, 'service');
      const xmlFile = path.join(xmlDir, 'scheduler-registration-win.xml');
      const mkdir = fileIo.mkdirs(xmlDir);
      if (!mkdir.ok) {
        return { ok: false, kind: 'command_failed', reason: `scheduler_xml_dir_unwritable:${mkdir.reason.slice(0, 80)}`, nextAction: `Could not prepare ${xmlDir}; check permissions and retry pd service install.` };
      }
      const written = fileIo.writeAtomic(xmlFile, xml);
      if (!written.ok) {
        return { ok: false, kind: 'command_failed', reason: `scheduler_xml_write_failed:${written.reason.slice(0, 80)}`, nextAction: `Could not write the task definition to ${xmlFile}; retry pd service install after fixing the filesystem issue.` };
      }
      const body = (name: string) => `
  # -Encoding UTF8: the definition is written UTF-8 without BOM; Windows
  # PowerShell 5.1 would otherwise decode it with the ANSI codepage and
  # corrupt CJK/special characters in install paths (task §3.2).
  $xmlText = Get-Content -LiteralPath $env:PD_TASK_XML -Raw -Encoding UTF8
  $user = "$env:USERDOMAIN\\$env:USERNAME" -replace '&','&amp;'
  $xmlText = $xmlText.Replace('__PD_TASK_USER__', $user)
  Register-ScheduledTask -TaskName '${name}' -Xml $xmlText | Out-Null
  [PSCustomObject]@{ done = $true } | ConvertTo-Json -Compress`;
      return runMutation(registration, body, { extraEnv: { PD_TASK_XML: xmlFile } });
    },

    async enable(registration) {
      const taskName = registration.identity.windowsTaskName;
      const query = await queryTask(taskName);
      if (!query.ok) {
        return { ok: false, kind: query.kind, reason: query.reason, nextAction: query.nextAction };
      }
      if (!query.body.found) {
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: 'scheduler_not_registered',
          nextAction: 'No scheduler registration exists for this install. Run pd service install first — enable never creates one.',
        };
      }
      const ownership = ownershipVerdict(query.body, registration);
      if (!ownership.ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'scheduler_task_name_conflict_foreign_task',
          nextAction: `The task named ${taskName} is not PD's own registration; PD refuses to modify it. Remove it manually if you own it.`,
          facts: factsFromQuery(registration.identity, query.body),
        };
      }
      if (query.body.state === 'Ready' || query.body.state === 'Running' || query.body.state === 'Queued') {
        return { ok: true, changed: false, facts: factsFromQuery(registration.identity, query.body) };
      }
      return runMutation(registration, (name) => `
  Enable-ScheduledTask -TaskName '${name}' | Out-Null
  [PSCustomObject]@{ done = $true } | ConvertTo-Json -Compress`);
    },

    async disable(registration) {
      const taskName = registration.identity.windowsTaskName;
      const query = await queryTask(taskName);
      if (!query.ok) {
        return { ok: false, kind: query.kind, reason: query.reason, nextAction: query.nextAction };
      }
      if (!query.body.found) {
        return {
          ok: false,
          kind: 'unsafe_state',
          reason: 'scheduler_not_registered',
          nextAction: 'No scheduler registration exists for this install; nothing to disable. Run pd service install first if you expected one.',
        };
      }
      const ownership = ownershipVerdict(query.body, registration);
      if (!ownership.ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'scheduler_task_name_conflict_foreign_task',
          nextAction: `The task named ${taskName} is not PD's own registration; PD refuses to modify it.`,
          facts: factsFromQuery(registration.identity, query.body),
        };
      }
      if (query.body.state === 'Disabled') {
        return { ok: true, changed: false, facts: factsFromQuery(registration.identity, query.body) };
      }
      return runMutation(registration, (name) => `
  Disable-ScheduledTask -TaskName '${name}' | Out-Null
  [PSCustomObject]@{ done = $true } | ConvertTo-Json -Compress`);
    },

    status,

    async uninstall(registration) {
      const taskName = registration.identity.windowsTaskName;
      const query = await queryTask(taskName);
      if (!query.ok) {
        return { ok: false, kind: query.kind, reason: query.reason, nextAction: query.nextAction };
      }
      if (!query.body.found) {
        // Idempotent no-op: nothing registered, nothing to remove.
        return { ok: true, changed: false, facts: factsFromQuery(registration.identity, query.body) };
      }
      const ownership = ownershipVerdict(query.body, registration);
      if (!ownership.ours) {
        return {
          ok: false,
          kind: 'external_conflict',
          reason: 'scheduler_task_name_conflict_foreign_task',
          nextAction: `A task named ${taskName} exists but does not reference this PD install; PD never deletes foreign registrations. Inspect it with Export-ScheduledTask and remove it manually if you own it.`,
          facts: factsFromQuery(registration.identity, query.body),
        };
      }
      // Stop future triggers first, then remove the registration (task §5).
      return runMutation(registration, (name) => `
  Disable-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue | Out-Null
  Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false
  [PSCustomObject]@{ done = $true } | ConvertTo-Json -Compress`);
    },
  };
}
