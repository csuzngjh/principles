/**
 * Service Host ownership provisioning (PRI-1278 consolidation).
 *
 * The PD Service Host is the ONLY background runtime: the Companion worker
 * runtime and the Gateway auto-consumer are deleted repo-wide, so there is
 * no legacy consumer left to quiesce. Provisioning hands a workspace to the
 * Service Host in one atomic write from ANY prior ownership state — a
 * pre-consolidation record (including interrupted handover/rollback residue)
 * cannot prove a live consumer anymore:
 *
 *   1. the workspace is already registered in the canonical manifest;
 *   2. a no-consume Worker readiness probe runs through the ACTIVE RELEASE
 *      (`pd <host> worker --readiness` / `--status`), never through the
 *      installer's own code;
 *   3. the provision CAS transition writes `service_host_owned` atomically
 *      (the only surviving transition kind; flips any residue state);
 *   4. one bounded REAL managed cycle runs (`pd service run-once`);
 *   5. an auditable provisioning record is written under `<pdHome>/service/`.
 *
 * Boundaries (deliberate):
 *  - this module NEVER owns scheduler lifecycle or ownership semantics — both
 *    are delegated to their existing single implementations (`pd service …`
 *    and `@principles/install-layout`);
 *  - ownership is handed over ONLY when the scheduler is verified enabled —
 *    a failed/absent scheduler leaves a fail-closed pending record instead
 *    (there is no companion fallback);
 *  - on an upgrade install the caller proves first that no legacy continuous
 *    worker process still consumes the workspace (the one-time switch
 *    evidence gate); a positive or unverifiable scan stays pending;
 *  - no credential, token or environment snapshot is written to argv, the
 *    evidence file or logs.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  readWorkspaceBackgroundOwnership,
  transitionWorkspaceBackgroundExecution,
  type BackgroundExecutionRecord,
} from '@principles/install-layout';
import {
  runInstalledCliJson,
  type ServiceHostBridgeProbes,
  type ServiceHostSchedulerOutcome,
} from './service-host-bridge.js';
import type { HostSelection } from './installers/index.js';


/** Installer-scoped one-time proof that no pre-upgrade OpenClaw Gateway process remains active. */
export type OpenClawGatewayQuiesce =
  | { readonly ok: true; readonly evidence: 'not_running' | 'process_exited'; readonly pid?: number }
  | { readonly ok: false; readonly reason: string };

export type ProvisioningReadiness =
  | 'ready'
  | 'waiting_for_host_binding'
  | 'failed'
  | 'skipped';

export interface ProvisioningFirstCycle {
  readonly attempted: boolean;
  readonly ok: boolean;
  readonly outcome?: string;
  readonly runId?: string;
  /** Adapter cycles that actually produced a Worker result. */
  readonly executed: number;
  /** Executions with THIS run's task/cycle progress evidence (not carried). */
  readonly progressed: number;
  /** Service-Host-owned workspaces with no adapter binding (truthful wait). */
  readonly waitingForBinding: number;
  readonly reason?: string;
}

export interface ServiceHostProvisioningOutcome {
  readonly ownership: 'service_host_owned' | 'already_owned' | 'not_provisioned' | 'failed';
  readonly ownershipBefore: string;
  readonly ownershipAfter: string;
  readonly generation: number | null;
  readonly readiness: ProvisioningReadiness;
  readonly readinessDetail?: string;
  readonly firstCycle: ProvisioningFirstCycle;
  readonly evidencePath?: string;
  /**
   * TRUE when the install committed without Service Host ownership (scheduler
   * not enabled, readiness failed, a legacy worker still running, CAS
   * failure). The durable evidence record lets a LATER explicit install
   * resume initialization of this workspace.
   */
  readonly pendingProvisioning?: boolean;
  readonly nextAction: string;
  readonly warnings: readonly string[];
}

export interface ProvisioningInput {
  readonly pdHome: string;
  readonly workspaceDir: string;
  readonly host: HostSelection;
  readonly scheduler: ServiceHostSchedulerOutcome;
  readonly warn: (message: string) => void;
  readonly info?: (message: string) => void;
  readonly probes?: ServiceHostBridgeProbes;
  /** Bounded first-cycle budget (default 180s). */
  readonly firstCycleTimeoutMs?: number;
  /** Test seam: real fs by default. */
  readonly now?: () => Date;
  /**
   * Deferred-resume only: the caller could not verify the host binding that
   * the pending marker named. Ownership must NOT flip from an unverified
   * binding; the refusal is recorded durably with an actionable next action.
   */
  readonly bindingVerification?: { readonly ok: false; readonly reason: string; readonly nextAction: string };
  /** Upgrade installs must supply positive Gateway quiesce evidence for OpenClaw targets. */
  readonly requireOpenClawGatewayQuiesce?: boolean;
  readonly openClawGatewayQuiesce?: OpenClawGatewayQuiesce;
  /** Fresh probe at the ownership-CAS boundary; production installers supply this so readiness work cannot make Gateway evidence stale. */
  readonly openClawGatewayQuiesceFn?: () => Promise<OpenClawGatewayQuiesce> | OpenClawGatewayQuiesce;
  /**
   * Upgrade one-time-switch evidence (upgrade installs only): the legacy
   * continuous-worker process scan the installer ran BEFORE the first
   * provision write of the run. When the scan names THIS workspace — or
   * could not verify quiesce at all — ownership must NOT flip: a surviving
   * pre-upgrade worker would become a second consumer beside the Service
   * Host. Undefined on fresh installs (no legacy PD existed to spawn one).
   */
  readonly legacyWorkerScan?: LegacyWorkerScan;
  /** Re-scan at the CAS boundary so readiness work cannot make the evidence stale. */
  readonly legacyWorkerScanFn?: () => LegacyWorkerScan;
  /** Re-resolve the host binding at the CAS boundary; a changed/unverifiable binding fails closed. */
  readonly hostBindingReverification?: () =>
    | { readonly ok: true; readonly host: HostSelection }
    | { readonly ok: false; readonly reason: string; readonly nextAction: string };
}

const DEFAULT_FIRST_CYCLE_TIMEOUT_MS = 180_000;
const EVIDENCE_SCHEMA = 'pd.service-install-provisioning.v1';
const PENDING_SCHEMA = 'pd.service-pending-provisioning.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The real directory a workspace pointer resolves to (symlinks/junctions resolved). */
function stableWorkspacePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    const real = fs.realpathSync.native(resolved);
    // rc-1: a shimmed/mocked fs may hand back a non-string. Fall back to the
    // lexical path instead of letting an undefined leak into path operations.
    return typeof real === 'string' && real.length > 0 ? real : resolved;
  } catch {
    return resolved;
  }
}

function canonicalIdentity(value: string): string {
  const form = stableWorkspacePath(value);
  return process.platform === 'win32' ? form.toLowerCase() : form;
}

// ─── One-time switch probe: legacy continuous worker processes ─────────────

export interface LegacyWorkerProcessRow {
  readonly pid: number;
  readonly commandLine: string;
  /** argv with exact token boundaries when the platform exposes it (Linux /proc). */
  readonly argv?: readonly string[];
}

export interface LegacyWorkerScan {
  /** FALSE when the process table itself could not be read — quiesce unverifiable. */
  readonly ok: boolean;
  readonly workers: readonly { readonly pid: number; readonly workspaceDir: string }[];
  readonly detail?: string;
}

/**
 * The legacy continuous-worker shape: `<host> worker --workspace <dir>`
 * WITHOUT `--once`. Post-consolidation workers are always bounded `--once`
 * cycles the Service Host spawns; a worker process without `--once` can only
 * be a pre-upgrade continuous child the deleted Companion runtime spawned.
 * Returns the `--workspace` value when the command line matches.
 */
export function matchLegacyWorkerCommandLine(commandLine: string): string | null {
  if (/(^|\\s)--once(?=\s|$)/.test(commandLine)) return null;
  if (!/(^|\s)worker(?=\s|$)/.test(commandLine)) return null;
  const workspace = /(?:^|\s)--workspace(?:\s+|=)(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(commandLine);
  return workspace?.[1] ?? workspace?.[2] ?? workspace?.[3] ?? null;
}

const LEGACY_WORKER_HOSTS = new Set(['codex', 'workbuddy']);

/**
 * argv-token matcher for platforms that expose exact process arguments.
 * Unlike command-line scraping, a workspace containing spaces is one token
 * here and can never be truncated. The host token must immediately precede
 * `worker`, which keeps unrelated Node processes out of the match set.
 */
export function matchLegacyWorkerArgv(argv: readonly string[]): string | null {
  // Inspect every exact `<host> worker` pair. Mode flags are interpreted only
  // in the argument stream after that subcommand; a workspace VALUE such as
  // `--once` is consumed as a value and must not suppress detection.
  for (let workerIndex = 1; workerIndex < argv.length; workerIndex += 1) {
    if (argv[workerIndex] !== 'worker' || !LEGACY_WORKER_HOSTS.has(argv[workerIndex - 1] ?? '')) continue;
    let continuous = true;
    let workspaceDir: string | null = null;
    for (let index = workerIndex + 1; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === '--workspace') {
        const value = argv[index + 1];
        if (typeof value === 'string' && value.length > 0) {
          workspaceDir = value;
          index += 1;
        }
        continue;
      }
      if (token?.startsWith('--workspace=') === true) {
        const value = token.slice('--workspace='.length);
        if (value.length > 0) workspaceDir = value;
        continue;
      }
      // `--once` is the new bounded mode. `--status`/`--readiness` are
      // no-consume probes, not continuous consumers.
      if (token === '--once' || token === '--status' || token === '--readiness') continuous = false;
    }
    if (continuous && workspaceDir !== null) return workspaceDir;
  }
  return null;
}

/**
 * Windows process entries are a single CommandLine string, not an argv array.
 * Parse the MSVC/CommandLineToArgvW quoting rules closely enough for the
 * installer-produced worker shape; malformed whitespace/token structure is a
 * scan failure rather than a false clean result.
 */
export function parseWindowsCommandLineArgv(commandLine: string): readonly string[] | null {
  const argv: string[] = [];
  let current = '';
  let inQuotes = false;
  let tokenActive = false;
  let backslashes = 0;
  for (const char of commandLine) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 0) {
        // A quote preceded by an even number of backslashes toggles quoting;
        // inside quotes a doubled quote is represented by the sequence rules
        // closely enough for paths produced by Node/Windows installers.
        inQuotes = !inQuotes;
        tokenActive = true;
      } else {
        current += '"';
        tokenActive = true;
      }
      backslashes = 0;
      continue;
    }
    current += '\\'.repeat(backslashes);
    backslashes = 0;
    if ((char === ' ' || char === '\t') && !inQuotes) {
      if (tokenActive || current.length > 0) argv.push(current);
      current = '';
      tokenActive = false;
      continue;
    }
    current += char;
    tokenActive = true;
  }
  current += '\\'.repeat(backslashes);
  if (tokenActive || current.length > 0 || argv.length === 0) argv.push(current);
  return argv.length > 0 && argv.every((token) => typeof token === 'string') ? argv : null;
}


/**
 * Parse the Darwin `KERN_PROCARGS2` payload. Layout: int32 argc, exec path,
 * NUL padding, then exactly argc NUL-terminated argv entries followed by envp.
 * Returning null is parse failure, never "no argv".
 */
export function parseDarwinProcArgs2(raw: Buffer): readonly string[] | null {
  if (raw.length < 4) return null;
  const argc = raw.readInt32LE(0);
  if (!Number.isInteger(argc) || argc < 1 || argc > 4096) return null;
  const execEnd = raw.indexOf(0, 4);
  if (execEnd < 4 || execEnd === raw.length - 1) return null;

  // Apple pads the executable path with NUL bytes before argv. Empty leading
  // argv entries are inherently ambiguous with that padding in this kernel
  // format; for normal host-launched workers argv[0] is non-empty. Parse the
  // selected entries byte-wise and require every one to be NUL-terminated so
  // truncation can never masquerade as a complete argument.
  let cursor = execEnd + 1;
  while (cursor < raw.length && raw[cursor] === 0) cursor += 1;
  if (cursor >= raw.length) return null;
  const argv: string[] = [];
  for (let index = 0; index < argc; index += 1) {
    const end = raw.indexOf(0, cursor);
    if (end < 0) return null;
    argv.push(raw.subarray(cursor, end).toString('utf8'));
    cursor = end + 1;
    if (cursor > raw.length && index < argc - 1) return null;
  }
  return argv;
}

/** One-shot Darwin argv reader. Ruby/Fiddle is a transient interpreter use, not a service. */
const DARWIN_ARGV_READER = String.raw`
require 'fiddle'
require 'fiddle/import'
module PdSysctl
  extend Fiddle::Importer
  dlload '/usr/lib/libSystem.B.dylib'
  extern 'int sysctl(void*, unsigned int, void*, void*, void*, unsigned long)'
end
pid_state = lambda do |pid|
  begin
    Process.kill(0, pid)
  rescue Errno::ESRCH
    next 'exited'
  rescue Errno::EPERM
    next 'live'
  end
  # kill(pid, 0) still succeeds for an unreaped zombie. KERN_PROCARGS2 then
  # fails with EINVAL even though no consumer threads remain, so classify the
  # current process-table state at the moment the read fails/succeeds.
  stat_io = IO.popen(['/bin/ps', '-o', 'stat=', '-p', pid.to_s], err: File::NULL)
  stat = stat_io.read.strip
  stat_io.close
  ps_ok = !$?.nil? && $?.success?
  if stat.empty? && ps_ok
    'exited'
  elsif stat.empty?
    # ps itself failing is not evidence of exit. Re-check liveness; a process
    # still present but whose state cannot be inspected remains fail-closed.
    begin
      Process.kill(0, pid)
      'live'
    rescue Errno::ESRCH
      'exited'
    end
  elsif stat.start_with?('Z')
    'zombie'
  else
    'live'
  end
end
emit_failure = lambda do |pid, reason|
  # A process that disappeared or became zombie residue after enumeration no
  # longer consumes anything; a live process whose argv cannot be inspected is
  # unverifiable and must stay fail-closed.
  if pid_state.call(pid) == 'live'
    puts "#{pid}\tERROR:#{reason}"
  else
    puts "#{pid}\tEXITED"
  end
end
ARGV.each do |pid_text|
  pid = pid_text.to_i
  next if pid <= 1
  begin
    unless pid_state.call(pid) != 'exited'
      puts "#{pid}\tEXITED"
      next
    end
    mib = [1, 49, pid].pack('l<3')
    size = [0].pack('Q<')
    if PdSysctl.sysctl(mib, 3, nil, size, nil, 0) != 0
      emit_failure.call(pid, 'sysctl_size')
      next
    end
    len = size.unpack1('Q<')
    if len < 4 || len > 8 * 1024 * 1024
      emit_failure.call(pid, 'invalid_size')
      next
    end
    if len > 8 * 1024 * 1024
      emit_failure.call(pid, 'oversized')
      next
    end
    raw = nil
    attempts = 0
    while attempts < 3 && raw.nil?
      attempts += 1
      buf = Fiddle::Pointer.malloc(len)
      size = Fiddle::Pointer.malloc(8)
      size[0, 8] = [len].pack('Q<')
      if PdSysctl.sysctl(mib, 3, buf, size, nil, 0) != 0
        errno = Fiddle.last_error
        if errno == Errno::ENOMEM::Errno && attempts < 3
          # The argument area can grow while a process execs; re-query instead
          # of accepting a truncation-prone fixed ceiling.
          size_probe = Fiddle::Pointer.malloc(8)
          size_probe[0, 8] = [0].pack('Q<')
          if PdSysctl.sysctl(mib, 3, nil, size_probe, nil, 0) == 0
            new_len = size_probe.to_str(8).unpack1('Q<')
            if new_len >= 4 && new_len <= 8 * 1024 * 1024
              len = new_len
              next
            end
          end
        end
        emit_failure.call(pid, "sysctl_read:#{errno || 'unknown'}")
        break
      end
      out_len = size.to_str(8).unpack1('Q<')
      if out_len < 4 || out_len > len
        emit_failure.call(pid, 'invalid_read_size')
        break
      end
      raw = buf.to_str(out_len)
    end
    next if raw.nil?
    puts "#{pid}\t#{raw.unpack1('H*')}"
  rescue Errno::ESRCH
    puts "#{pid}\tEXITED"
  rescue SystemCallError => e
    emit_failure.call(pid, "#{e.class.name}:#{e.respond_to?(:errno) ? e.errno : 'unknown'}")
  rescue => e
    emit_failure.call(pid, e.class.name)
  end
end
`

/**
 * Decode the one-shot Darwin reader protocol. `EXITED` rows are safe scan
 * residue; every malformed or `ERROR` row is fail-closed scan evidence rather
 * than proof that no legacy worker exists. Exported for focused regression tests.
 */
export function parseDarwinArgvReaderOutput(output: string): LegacyWorkerProcessRow[] {
  const rows: LegacyWorkerProcessRow[] = [];
  const failures: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;
    const tab = trimmed.indexOf('\t');
    const pid = Number.parseInt(trimmed.slice(0, tab), 10);
    if (!(tab > 0 && Number.isInteger(pid) && pid > 1)) {
      failures.push(`unparseable row ${trimmed.slice(0, 80)}`);
      continue;
    }
    const payload = trimmed.slice(tab + 1);
    if (payload === 'EXITED') continue;
    if (payload.startsWith('ERROR:')) {
      failures.push(`pid ${pid}: ${payload.slice('ERROR:'.length)}`);
      continue;
    }
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(payload)) {
      failures.push(`pid ${pid}: malformed hex payload`);
      continue;
    }
    const raw = Buffer.from(payload, 'hex');
    const argv = parseDarwinProcArgs2(raw);
    if (argv === null) {
      failures.push(`pid ${pid}: malformed KERN_PROCARGS2 payload`);
      continue;
    }
    rows.push({ pid, commandLine: argv.join(' '), argv });
  }
  if (failures.length > 0) {
    throw new Error(`darwin argv reader evidence unverifiable (${failures.slice(0, 5).join('; ')}${failures.length > 5 ? '; …' : ''})`);
  }
  return rows;
}

function listDarwinProcessRows(afterEnumeration?: () => void): LegacyWorkerProcessRow[] {
  // `-x` is NOT a same-user filter on Darwin: it also exposes unrelated
  // daemons, and KERN_PROCARGS2 can return EINVAL for another account's
  // process. Legacy installer-spawned workers belong to the install user, so
  // filter ownership before reading argv. A same-user process that still
  // cannot be inspected remains fail-closed in the Ruby reader.
  const currentUser = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
  if (currentUser.length === 0) throw new Error('darwin scan could not resolve the current user');
  const pidOutput = execFileSync('/bin/ps', ['-xo', 'pid=,user=,stat=,comm='], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const pids: number[] = [];
  for (const line of pidOutput.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [pidText, user, stat, commandText] = trimmed.split(/\s+/);
    const pid = Number.parseInt(pidText ?? '', 10);
    if (!(Number.isInteger(pid) && pid > 1) || typeof user !== 'string' || user.length === 0 || typeof stat !== 'string' || stat.length === 0 || typeof commandText !== 'string' || commandText.length === 0) {
      throw new Error(`darwin ps returned an unparseable process row: ${trimmed.slice(0, 80)}`);
    }
    // Legacy workers are Node processes. Restricting the expensive
    // KERN_PROCARGS2 pass to Node keeps the scan bounded on a real macOS host
    // while preserving exact argv evidence for every process that can match.
    if (user !== currentUser || stat.startsWith('Z') || path.basename(commandText) !== 'node') continue;
    pids.push(pid);
  }
  if (pids.length === 0) return [];
  afterEnumeration?.();
  const output = execFileSync('/usr/bin/ruby', ['-e', DARWIN_ARGV_READER, ...pids.map(String)], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseDarwinArgvReaderOutput(output);
}

/**
 * Parse the Windows owner-scoped process table emitted by the PowerShell
 * enumerator. Ownership filtering is deliberate migration evidence, so it is
 * a pure TypeScript contract rather than hidden script text: a process whose
 * owner resolves to another account is not installer evidence at all, while a
 * same-user or owner-unresolved process with an unreadable command line stays
 * fail-closed.
 */
export function parseWindowsProcessRows(output: string): LegacyWorkerProcessRow[] {
  const rows: LegacyWorkerProcessRow[] = [];
  let currentUser: string | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) continue;
    if (line.startsWith('CURRENT\t')) {
      currentUser = line.slice('CURRENT\t'.length);
      continue;
    }
    const [pidText, ownerState, owner, encodedCommandLine, extra] = line.split('\t');
    const pid = Number.parseInt(pidText ?? '', 10);
    if (!Number.isInteger(pid) || pid <= 0 || typeof ownerState !== 'string' || typeof encodedCommandLine !== 'string' || extra !== undefined) {
      throw new Error(`Windows process row unparseable: ${line.slice(0, 80)}`);
    }
    if (ownerState === 'resolved' && typeof currentUser === 'string' && currentUser.length > 0
      && typeof owner === 'string' && owner.toLowerCase() !== currentUser.toLowerCase()) {
      continue;
    }
    const commandLine = Buffer.from(encodedCommandLine, 'base64').toString('utf16le');
    if (commandLine.length === 0) {
      throw new Error(`Windows process command line unreadable for pid ${pid}`);
    }
    const argv = parseWindowsCommandLineArgv(commandLine);
    if (argv === null) throw new Error(`Windows process command line unparseable for pid ${pid}`);
    rows.push({ pid, commandLine, argv });
  }
  if (typeof currentUser !== 'string' || currentUser.length === 0) {
    throw new Error('Windows process scan did not identify the current user');
  }
  return rows;
}

/** Platform process table as (pid, commandLine/argv) rows — bounded, read-only. */
function listProcessRows(platform: string, afterDarwinEnumeration?: () => void): LegacyWorkerProcessRow[] {
  if (platform === 'win32') {
    // powershell.exe is the project-allowlisted process-query host (wmic is
    // gone since Windows 11 24H2). EncodedCommand because Node→PowerShell
    // argv quoting corrupts embedded quotes in -Command strings. PowerShell
    // only ENUMERATES pid/owner/command-line evidence here; ownership policy
    // and fail-closed parsing stay in parseWindowsProcessRows where adversarial
    // owner/unreadable combinations are directly testable.
    const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; "CURRENT\`t$([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)"; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $ownerState = 'unresolved'; $owner = ''; try { $ownerResult = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; if ($ownerResult.ReturnValue -eq 0) { $ownerState = 'resolved'; $owner = "$($ownerResult.Domain)\\$($ownerResult.User)" } } catch { $ownerState = 'query_failed' }; $cmd = $_.CommandLine; if ($null -eq $cmd) { $cmd = '' }; $encodedCmd = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd)); "$($_.ProcessId)\`t$ownerState\`t$owner\`t$encodedCmd" }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    return parseWindowsProcessRows(output);
  }
  const rows: LegacyWorkerProcessRow[] = [];
  if (platform === 'linux') {
    // `/proc/<pid>/cmdline` preserves exact argv boundaries with NUL separators.
    // Flattening Linux argv through `ps ... args` is ownership-unsafe because a
    // workspace such as `/tmp/pd legacy worker/workspace` is indistinguishable
    // from multiple independent arguments.
    const procEntries = fs.readdirSync('/proc', { withFileTypes: true });
    const unreadable: string[] = [];
    for (const entry of procEntries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const pid = Number.parseInt(entry.name, 10);
      const cmdlinePath = path.join('/proc', entry.name, 'cmdline');
      let raw: Buffer;
      try {
        raw = fs.readFileSync(cmdlinePath);
      } catch (error) {
        const { code } = error as { code?: string };
        // ENOENT/ESRCH means the process exited between directory enumeration
        // and the read; an exited process cannot still consume the workspace.
        if (code !== 'ENOENT' && code !== 'ESRCH') unreadable.push(`${entry.name}:${code ?? 'read_failed'}`);
        continue;
      }
      const argv = raw.toString('utf8').split('\0');
      if (argv[argv.length - 1] === '') argv.pop();
      if (argv.length === 0) continue; // kernel threads and zombies carry no argv
      rows.push({ pid, commandLine: argv.join(' '), argv });
    }
    if (unreadable.length > 0) {
      throw new Error(`/proc cmdline unreadable for pid(s) ${unreadable.slice(0, 5).join(',')}${unreadable.length > 5 ? '…' : ''}`);
    }
    return rows;
  }
  if (platform === 'darwin') return listDarwinProcessRows(afterDarwinEnumeration);
  // Other POSIX process APIs do not expose a portable argv-boundary-safe table.
  // Returning a flat `ps args` parse would fabricate confidence; quiesce is
  // unverifiable instead (the caller's fail-closed gate stays pending).
  throw new Error(`legacy worker scan unsupported on platform ${platform}: argv boundaries cannot be verified`);
}

/**
 * One bounded scan of the process table for legacy continuous workers.
 *
 * Rationale (one-time switch, PRI-1278 consolidation): the upgrade replaced
 * the binaries and the Companion restart kills its continuous worker
 * children — but "the binary is new" is not evidence that no old child
 * survived, and a surviving child becomes a second consumer the moment
 * ownership flips. This probe is the evidence gate: it runs once per upgrade
 * install before the first provision write — no retry machinery, no daemon.
 * A positive or unverifiable scan keeps the workspace pending (fail-closed);
 * the next install re-verifies.
 */
export function scanRunningLegacyWorkerProcesses(options: {
  readonly platform?: string;
  /** Test seam: replace the process-table read. */
  readonly rows?: () => readonly LegacyWorkerProcessRow[];
  /** Darwin race-test seam: runs after process enumeration and before argv reads. */
  readonly afterDarwinEnumeration?: () => void;
} = {}): LegacyWorkerScan {
  let rows: readonly LegacyWorkerProcessRow[];
  try {
    rows = options.rows !== undefined ? options.rows() : listProcessRows(options.platform ?? process.platform, options.afterDarwinEnumeration);
  } catch (error) {
    return { ok: false, workers: [], detail: `process scan failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const workers: { pid: number; workspaceDir: string }[] = [];
  for (const row of rows) {
    if (row.pid === process.pid) continue;
    const workspaceDir = row.argv !== undefined
      ? matchLegacyWorkerArgv(row.argv)
      : matchLegacyWorkerCommandLine(row.commandLine);
    if (workspaceDir !== null) workers.push({ pid: row.pid, workspaceDir });
  }
  return { ok: true, workers };
}

function readinessProbeArgs(host: Exclude<HostSelection, 'all' | 'none'>, workspaceDir: string): string[] {
  // OpenClaw has a dedicated no-consume readiness mode; Codex / WorkBuddy
  // answer the same question through their `--status` mode (no cycle runs).
  return host === 'openclaw'
    ? ['openclaw', 'worker', '--readiness', '--json', '--workspace', workspaceDir]
    : [host, 'worker', '--status', '--json', '--workspace', workspaceDir];
}

function hostsToProbe(host: HostSelection): Exclude<HostSelection, 'all' | 'none'>[] {
  if (host === 'none') return [];
  if (host === 'all') return ['openclaw', 'codex'];
  return [host];
}

async function probeReadiness(input: ProvisioningInput): Promise<{
  readiness: ProvisioningReadiness;
  detail?: string;
}> {
  const hosts = hostsToProbe(input.host);
  if (hosts.length === 0) {
    return {
      readiness: 'waiting_for_host_binding',
      detail: 'no_host_adapter_installed',
    };
  }
  for (const host of hosts) {
    const probe = await runInstalledCliJson(
      input.pdHome,
      readinessProbeArgs(host, input.workspaceDir),
      {
        probes: input.probes ?? {},
        // Worker commands do NOT register --pd-home; Commander would reject
        // the whole probe. Identity comes from the trusted home env instead.
        includePdHome: false,
        homeDir: path.dirname(input.pdHome),
      },
    );
    if (!probe.ok) {
      return { readiness: 'failed', detail: `${host}:${probe.detail}` };
    }
    const doc = isRecord(probe.doc) ? probe.doc : {};
    const mode = typeof doc.mode === 'string' ? doc.mode : 'unknown';
    // 'paused' is a GOVERNANCE state (PD disabled in this workspace), not an
    // install-wiring failure: the Service Host honors flags at cycle time.
    if (mode !== 'ready' && mode !== 'paused') {
      return { readiness: 'failed', detail: `${host}:worker_mode_${mode}` };
    }
  }
  return { readiness: 'ready', detail: hosts.join('+') };
}

function notAttempted(reason: string): ProvisioningFirstCycle {
  return { attempted: false, ok: false, executed: 0, progressed: 0, waitingForBinding: 0, reason };
}

function countExecutions(
  doc: Record<string, unknown>,
  workspaceDir: string,
): { executed: number; progressed: number; waitingForBinding: number } {
  const managed = isRecord(doc.managed) ? doc.managed : {};
  const executions = Array.isArray(managed.executions) ? managed.executions : [];
  const expected = canonicalIdentity(workspaceDir);
  let executed = 0;
  let progressed = 0;
  let waitingForBinding = 0;
  for (const entry of executions) {
    if (!isRecord(entry)) continue;
    // `service run-once` is a GLOBAL cycle over every owned workspace. The
    // evidence for THIS provisioning target must count only its own entry,
    // otherwise a multi-host install reports the sibling's work as its own.
    if (typeof entry.canonicalDir !== 'string') continue;
    if (canonicalIdentity(entry.canonicalDir) !== expected) continue;
    if (entry.workspaceState === 'waiting_for_host_binding') {
      waitingForBinding += 1;
      continue;
    }
    // Only a REAL adapter cycle counts as execution: the no-adapter record has
    // no `execution` payload and must not be reported as work performed.
    const ranWorker = entry.admission === 'executed'
      && typeof entry.hostKind === 'string'
      && isRecord(entry.execution);
    if (!ranWorker) continue;
    executed += 1;
    // Progress must come from THIS run's evidence; a timestamp carried from a
    // previous run is not progress made by the first cycle.
    if (entry.lastProgressSource === 'task_state_change' || entry.lastProgressSource === 'cycle_evidence') {
      progressed += 1;
    }
  }
  return { executed, progressed, waitingForBinding };
}

async function runFirstCycle(input: ProvisioningInput): Promise<ProvisioningFirstCycle> {
  const budgetMs = input.firstCycleTimeoutMs ?? DEFAULT_FIRST_CYCLE_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { ...notAttempted('first_cycle_timeout'), attempted: true };
    const result = await runInstalledCliJson(
      input.pdHome,
      ['service', 'run-once', '--trigger', 'installer', '--json'],
      {
        probes: input.probes ?? {},
        timeoutMs: remainingMs,
      },
    );
    if (!isRecord(result.doc)) {
      return { ...notAttempted(result.detail), attempted: true };
    }
    const { doc } = result;
    const outcome = typeof doc.outcome === 'string' ? doc.outcome : 'unknown';
    if (outcome === 'already_running') {
      // Enabling a systemd timer on a machine whose uptime already exceeds
      // OnBootSec can start the OS-triggered run immediately. Overlap is
      // healthy, but the installer still owes first-cycle evidence for THIS
      // ownership write: wait inside the existing bounded budget for the
      // holder to finish, then run the installer-triggered cycle once.
      if (deadline - Date.now() > 1_100) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      return { ...notAttempted('service_run_lock_held'), attempted: true, outcome };
    }
    const { executed, progressed, waitingForBinding } = countExecutions(doc, input.workspaceDir);
    return {
      attempted: true,
      ok: result.code === 0 && (doc.ok === true || outcome === 'completed'),
      ...(outcome !== 'unknown' ? { outcome } : {}),
      ...(typeof doc.runId === 'string' ? { runId: doc.runId } : {}),
      executed,
      progressed,
      waitingForBinding,
      ...(typeof doc.reason === 'string'
        ? { reason: doc.reason }
        : result.code !== 0
          ? { reason: result.detail }
          : {}),
    };
  }
}

interface ProvisioningEvidence {
  readonly schemaVersion: typeof EVIDENCE_SCHEMA;
  readonly recordedAt: string;
  readonly workspaceDir: string;
  readonly host: HostSelection;
  readonly scheduler: {
    state: string;
    registered: boolean | null;
    enabled: boolean | null;
    triggerIntervalMs?: number | null;
  };
  readonly ownership: {
    before: string;
    after: string;
    generation: number | null;
    record?: BackgroundExecutionRecord;
  };
  readonly readiness: { status: ProvisioningReadiness; detail?: string };
  readonly firstCycle: ProvisioningFirstCycle;
  readonly pendingProvisioning: boolean;
  readonly pendingReason?: string;
  readonly limitations: readonly string[];
}

function writeEvidence(pdHome: string, evidence: ProvisioningEvidence): string {
  const dir = path.join(pdHome, 'service');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'install-provisioning.json');
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
  return target;
}

/** Host values a pending provisioning entry may carry. */
const PENDING_HOSTS: readonly HostSelection[] = ['none', 'openclaw', 'codex', 'workbuddy', 'all'];

interface PendingRegistryEntry {
  /** The REAL resolved directory this entry owns. */
  readonly workspaceDir: string;
  /** The operator's original pointer, when it differed (display only). */
  readonly requestedWorkspaceDir?: string;
  readonly host: HostSelection;
  readonly recordedAt: string;
  readonly reason?: string;
}

interface PendingRegistryRead {
  readonly entries: readonly PendingRegistryEntry[];
  readonly warning?: string;
}

function pendingRegistryPath(pdHome: string): string {
  return path.join(pdHome, 'service', 'pending-provisioning.json');
}

function isPendingHost(value: unknown): value is HostSelection {
  return typeof value === 'string' && (PENDING_HOSTS as readonly string[]).includes(value);
}

/**
 * Read the PER-WORKSPACE pending provisioning registry.
 *
 * A single evidence document is last-write-wins, so `--host all` (OpenClaw +
 * Codex bound to different directories) lost every record but the last one.
 * The registry is keyed by canonical workspace and merged on write; each entry
 * carries the host that was being provisioned so a later resume can verify the
 * binding instead of trusting this run's (possibly `none`) host choice.
 */
function readPendingRegistry(pdHome: string): PendingRegistryRead {
  const file = pendingRegistryPath(pdHome);
  if (!fs.existsSync(file)) return { entries: [] };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { entries: [], warning: `pending provisioning registry is unreadable (${error instanceof Error ? error.message : String(error)}).` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [], warning: `pending provisioning registry is not valid JSON (${file}).` };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== PENDING_SCHEMA || !Array.isArray(parsed.entries)) {
    return { entries: [], warning: `pending provisioning registry has an unsupported shape (${file}).` };
  }
  const entries: PendingRegistryEntry[] = [];
  let invalid = 0;
  for (const entry of parsed.entries) {
    if (!isRecord(entry)) {
      invalid += 1;
      continue;
    }
    if (typeof entry.workspaceDir !== 'string' || entry.workspaceDir.length === 0) {
      invalid += 1;
      continue;
    }
    if (!isPendingHost(entry.host)) {
      invalid += 1;
      continue;
    }
    if (typeof entry.recordedAt !== 'string') {
      invalid += 1;
      continue;
    }
    entries.push({
      workspaceDir: entry.workspaceDir,
      host: entry.host,
      recordedAt: entry.recordedAt,
      ...(typeof entry.requestedWorkspaceDir === 'string' ? { requestedWorkspaceDir: entry.requestedWorkspaceDir } : {}),
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
    });
  }
  return {
    entries,
    ...(invalid > 0
      ? { warning: `pending provisioning registry contains ${invalid} invalid entr${invalid === 1 ? 'y' : 'ies'} (${file}); they were ignored.` }
      : {}),
  };
}

function writePendingRegistry(pdHome: string, entries: readonly PendingRegistryEntry[]): void {
  const dir = path.join(pdHome, 'service');
  fs.mkdirSync(dir, { recursive: true });
  const target = pendingRegistryPath(pdHome);
  const temp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: PENDING_SCHEMA, entries }, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
}

function upsertPending(
  pdHome: string,
  entry: PendingRegistryEntry,
  warn: (message: string) => void,
): void {
  try {
    const { entries, warning } = readPendingRegistry(pdHome);
    if (warning !== undefined) warn(`${warning} Recording a fresh pending entry for ${entry.workspaceDir}.`);
    // Persist the REAL directory the operator's pointer resolved to NOW. A
    // later resume must own that directory even if a symlink/junction has been
    // re-pointed since; the requested path is kept for display only.
    const stable = stableWorkspacePath(entry.workspaceDir);
    const identity = canonicalIdentity(stable);
    const merged = entries.filter((candidate) => canonicalIdentity(candidate.workspaceDir) !== identity);
    merged.push({
      ...entry,
      workspaceDir: stable,
      ...(stable !== entry.workspaceDir ? { requestedWorkspaceDir: entry.workspaceDir } : {}),
    });
    writePendingRegistry(pdHome, merged);
  } catch (error) {
    warn(`Pending provisioning record could not be written (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function clearPending(
  pdHome: string,
  workspaceDir: string,
  warn: (message: string) => void,
): void {
  try {
    const { entries, warning } = readPendingRegistry(pdHome);
    if (warning !== undefined) {
      // Never rewrite a registry whose current content could not be read:
      // overwriting it would silently discard the other workspaces' hints.
      warn(warning);
      return;
    }
    const identity = canonicalIdentity(workspaceDir);
    const remaining = entries.filter((candidate) => canonicalIdentity(candidate.workspaceDir) !== identity);
    if (remaining.length === entries.length) return;
    writePendingRegistry(pdHome, remaining);
  } catch (error) {
    warn(`Pending provisioning record could not be updated (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function findPendingEntry(pdHome: string, workspaceDir: string): PendingRegistryEntry | undefined {
  const { entries } = readPendingRegistry(pdHome);
  const identity = canonicalIdentity(workspaceDir);
  return entries.find((entry) => canonicalIdentity(entry.workspaceDir) === identity);
}

function limitationsFor(host: HostSelection, readiness: ProvisioningReadiness): string[] {
  const limitations: string[] = [];
  if (host === 'none') {
    limitations.push('Service-Host-only install: no host adapter is installed, so the workspace reports waiting_for_host_binding until a host adapter is installed and bound.');
  }
  if (readiness === 'waiting_for_host_binding') {
    limitations.push('Worker readiness was not proven because no host adapter is bound; the scheduler owns the cycle but has no adapter to dispatch.');
  }
  return limitations;
}

/**
 * Provision ONE workspace into Service Host ownership — a fresh install's
 * new workspace or a deferred/upgrade resume converging residue state.
 * Returns a structured outcome; never throws for expected refusals (rc-9).
 */
export async function provisionFreshInstallWorkspace(input: ProvisioningInput): Promise<ServiceHostProvisioningOutcome> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
    input.warn(message);
  };
  const manifestPath = path.join(input.pdHome, 'install.json');

  const before = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  if (before.status === 'manifest_unreadable') {
    return {
      ownership: 'failed',
      ownershipBefore: 'manifest_unreadable',
      ownershipAfter: 'manifest_unreadable',
      generation: null,
      readiness: 'skipped',
      firstCycle: notAttempted(before.reason),
      nextAction: before.nextAction,
      warnings,
    };
  }
  if (before.status === 'service_host_owned') {
    // The workspace already converged (an earlier provisioning run or a
    // replay); its pending hint is stale and must not be resumed again.
    clearPending(input.pdHome, input.workspaceDir, warn);
    return {
      ownership: 'already_owned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: 'skipped',
      firstCycle: notAttempted('already_service_host_owned'),
      nextAction: 'This workspace is already owned by the Service Host; the installer left the ownership record untouched.',
      warnings,
    };
  }
  // Every other persisted state — no record, an explicit legacy_owned record,
  // or interrupted handover/rollback residue — is flippable residue in the
  // Service-Host-only model: the legacy consumer implementation is deleted
  // repo-wide, so no recorded history can prove a live consumer anymore.

  const recordPending = (
    reason: string,
    args: {
      readiness: ProvisioningReadiness;
      readinessDetail?: string;
      firstCycle: ProvisioningFirstCycle;
      ownership?: 'failed';
      nextAction: string;
    },
  ): ServiceHostProvisioningOutcome => {
    const recordedAt = (input.now?.() ?? new Date()).toISOString();
    // Per-workspace hint: `--host all` produces multiple targets, and the
    // single evidence document below is last-write-wins. The registry keeps
    // every target independently resumable, including the host it was for.
    upsertPending(input.pdHome, {
      workspaceDir: input.workspaceDir,
      host: input.host,
      recordedAt,
      reason,
    }, warn);
    let evidencePath: string | undefined;
    try {
      evidencePath = writeEvidence(input.pdHome, {
        schemaVersion: EVIDENCE_SCHEMA,
        recordedAt,
        workspaceDir: input.workspaceDir,
        host: input.host,
        scheduler: {
          state: input.scheduler.state,
          registered: input.scheduler.registered,
          enabled: input.scheduler.enabled,
          ...(input.scheduler.triggerIntervalMs !== undefined ? { triggerIntervalMs: input.scheduler.triggerIntervalMs } : {}),
        },
        ownership: { before: before.status, after: before.status, generation: before.generation },
        readiness: { status: args.readiness, ...(args.readinessDetail !== undefined ? { detail: args.readinessDetail } : {}) },
        firstCycle: args.firstCycle,
        pendingProvisioning: true,
        pendingReason: reason,
        limitations: limitationsFor(input.host, args.readiness),
      });
    } catch (error) {
      warn(`Service Host provisioning evidence could not be written (${error instanceof Error ? error.message : String(error)}).`);
    }
    return {
      ownership: args.ownership ?? 'not_provisioned',
      ownershipBefore: before.status,
      ownershipAfter: before.status,
      generation: before.generation,
      readiness: args.readiness,
      ...(args.readinessDetail !== undefined ? { readinessDetail: args.readinessDetail } : {}),
      firstCycle: args.firstCycle,
      ...(evidencePath !== undefined ? { evidencePath } : {}),
      pendingProvisioning: true,
      nextAction: args.nextAction,
      warnings,
    };
  };

  // Resume-only: a pending hint may name a host whose binding can no longer be
  // read/validated. Flipping ownership from an unverified binding is exactly
  // the "assume a host that may not be there" failure; refuse durably instead.
  if (input.bindingVerification !== undefined && !input.bindingVerification.ok) {
    return recordPending('binding_unverifiable', {
      readiness: 'skipped',
      firstCycle: notAttempted('binding_unverifiable'),
      nextAction: `${input.bindingVerification.nextAction} Ownership was NOT handed over because the workspace's host binding could not be verified (${input.bindingVerification.reason}).`,
    });
  }

  // Guard: ownership is only handed over when the scheduler is VERIFIED
  // enabled. A registration that failed or stayed disabled must never flip
  // the marker — there is no companion fallback — so it records a PENDING
  // provisioning fact instead, and a later explicit install can resume.
  if (input.scheduler.state !== 'enabled' || input.scheduler.enabled !== true) {
    return recordPending(`scheduler_${input.scheduler.state}`, {
      readiness: 'skipped',
      firstCycle: notAttempted(`scheduler_${input.scheduler.state}`),
      nextAction: `${input.scheduler.nextAction} Workspace ownership was NOT handed over because the scheduler is not verified enabled. This workspace is recorded as pending; after arming the scheduler, re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
    });
  }


  // Static caller-supplied scan evidence is a pre-readiness gate. When a
  // scan function is supplied, the same scan is refreshed again immediately
  // before CAS below; positive/unverifiable evidence never reaches readiness.
  if (input.legacyWorkerScan !== undefined) {
    const scan = input.legacyWorkerScan;
    const identity = canonicalIdentity(input.workspaceDir);
    const matches = scan.workers.filter((worker) => canonicalIdentity(worker.workspaceDir) === identity);
    if (!scan.ok || matches.length > 0) {
      const detail = !scan.ok
        ? `the legacy worker process scan could not verify quiesce (${scan.detail ?? 'scan failed'})`
        : `legacy continuous worker process(es) still consume this workspace (pid ${matches.map((match) => match.pid).join(', ')})`;
      return recordPending('legacy_worker_still_running', {
        readiness: 'skipped',
        firstCycle: notAttempted('legacy_worker_still_running'),
        nextAction: `Ownership was NOT handed over: ${detail}. Restart the machine first — or let the Companion update finish retiring its old worker processes — then re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
      });
    }
  }

  // OpenClaw's legacy consumer was an in-process Gateway timer chain, so the
  // continuous-worker argv scan cannot see it. An upgrade ownership transfer
  // requires positive installer-scoped proof that the old Gateway is absent or
  // the observed process exited; absence of evidence is fail-closed pending.
  if (input.requireOpenClawGatewayQuiesce === true && (input.host === 'openclaw' || input.host === 'all')) {
    const quiesce = input.openClawGatewayQuiesce;
    if (quiesce?.ok !== true) {
      return recordPending('openclaw_gateway_unproven', {
        readiness: 'skipped',
        firstCycle: notAttempted('openclaw_gateway_unproven'),
        nextAction: `Ownership was NOT handed over because the pre-upgrade OpenClaw Gateway process could not be proven quiescent (${quiesce?.reason ?? 'no quiesce evidence'}). Stop the OpenClaw Gateway and re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
      });
    }
  }

  const readiness = await probeReadiness(input);
  if (readiness.readiness === 'failed') {
    return recordPending('readiness_failed', {
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted('readiness_failed'),
      nextAction: `The active-release Worker readiness probe failed (${readiness.detail ?? 'unknown'}), so workspace ownership was NOT handed over. Fix the host adapter/workspace readiness, then re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
    });
  }


  // Re-verify at the CAS boundary. The first scan may have selected this
  // target, but readiness probing is asynchronous; ownership evidence must be
  // fresh enough that no legacy worker appeared during that window.
  const casBoundaryScan = input.legacyWorkerScanFn?.() ?? input.legacyWorkerScan;
  if (casBoundaryScan !== undefined) {
    const identity = canonicalIdentity(input.workspaceDir);
    const matches = casBoundaryScan.workers.filter((worker) => canonicalIdentity(worker.workspaceDir) === identity);
    if (!casBoundaryScan.ok || matches.length > 0) {
      const detail = !casBoundaryScan.ok
        ? `the legacy worker process scan could not verify quiesce (${casBoundaryScan.detail ?? 'scan failed'})`
        : `legacy continuous worker process(es) still consume this workspace (pid ${matches.map((match) => match.pid).join(', ')})`;
      return recordPending('legacy_worker_still_running', {
        readiness: readiness.readiness,
        ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
        firstCycle: notAttempted('legacy_worker_still_running'),
        nextAction: `Ownership was NOT handed over: ${detail}. Restart the machine first — or let the Companion update finish retiring its old worker processes — then re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
      });
    }
  }

  // Re-verify OpenClaw quiescence at the CAS boundary as well. The initial
  // evidence was collected before a long install transaction and readiness
  // probes; ownership must not flip if the Gateway returned in that window.
  if (input.requireOpenClawGatewayQuiesce === true && (input.host === 'openclaw' || input.host === 'all')) {
    let boundaryQuiesce = input.openClawGatewayQuiesce;
    if (input.openClawGatewayQuiesceFn !== undefined) {
      try {
        boundaryQuiesce = await input.openClawGatewayQuiesceFn();
      } catch (error) {
        boundaryQuiesce = { ok: false, reason: `Gateway quiescence re-verification failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (boundaryQuiesce?.ok !== true) {
      return recordPending('openclaw_gateway_unproven', {
        readiness: readiness.readiness,
        ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
        firstCycle: notAttempted('openclaw_gateway_unproven'),
        nextAction: `Ownership was NOT handed over because OpenClaw Gateway quiescence could not be re-verified immediately before the ownership write (${boundaryQuiesce?.reason ?? 'no quiesce evidence'}). Stop the OpenClaw Gateway and re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
      });
    }
  }

  // Host-binding evidence is likewise stale after asynchronous readiness work.
  // A binding that appeared, disappeared, or changed during that window means
  // the readiness/quiescence evidence was gathered for the wrong host set.
  if (input.hostBindingReverification !== undefined) {
    const reverified = input.hostBindingReverification();
    if (!reverified.ok) {
      return recordPending('binding_unverifiable', {
        readiness: readiness.readiness,
        ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
        firstCycle: notAttempted('binding_unverifiable'),
        nextAction: `${reverified.nextAction} Ownership was NOT handed over because the workspace's host binding could not be re-verified immediately before the ownership write (${reverified.reason}).`,
      });
    }
    if (reverified.host !== input.host) {
      return recordPending('binding_changed', {
        readiness: readiness.readiness,
        ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
        firstCycle: notAttempted('binding_changed'),
        nextAction: `Ownership was NOT handed over because the workspace host binding changed during provisioning (${input.host} -> ${reverified.host}). Re-run: npx create-principles-disciple install --enable-service-host --workspace "${input.workspaceDir}"`,
      });
    }
  }

  const operationId = `install-provision-${input.now?.().getTime() ?? Date.now()}-${process.pid}`;
  // provision_fresh_install is the only surviving transition kind, redefined
  // as from-ANY-state → service_host_owned: residue records flip in the same
  // atomic write as a no-record workspace (generation fencing still applies).
  const provisioned = transitionWorkspaceBackgroundExecution({
    manifestPath,
    workspaceDir: input.workspaceDir,
    kind: 'provision_fresh_install',
    operationId,
    registerWorkspace: true,
    expectedGeneration: before.generation,
  });
  if (!provisioned.ok) {
    warn(`Service Host ownership provisioning failed (${provisioned.reason}: ${provisioned.message}). ${provisioned.nextAction ?? ''}`.trim());
    return recordPending(`cas_${provisioned.reason}`, {
      ownership: 'failed',
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted(`cas_${provisioned.reason}`),
      nextAction: provisioned.nextAction ?? 'Repair the install manifest and retry; no ownership change was written.',
    });
  }

  // Verify the persisted fact, not the in-memory result.
  const after = readWorkspaceBackgroundOwnership({ manifestPath, workspaceDir: input.workspaceDir });
  const owned = after.status === 'service_host_owned'
    && after.record.effectiveOwner === 'service_host'
    && after.generation >= 1;
  if (!owned) {
    warn(`Service Host ownership provisioning reported success but the persisted projection is ${after.status}.`);
    return recordPending('post_write_projection_mismatch', {
      ownership: 'failed',
      readiness: readiness.readiness,
      ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
      firstCycle: notAttempted('post_write_projection_mismatch'),
      nextAction: 'Inspect ~/.pd/install.json (backgroundExecutions) before relying on automatic runs; the persisted ownership could not be verified.',
    });
  }

  // The durable pending hint has done its job: ownership is verified, so a
  // later install must not treat this workspace as "uninitialized" again.
  clearPending(input.pdHome, input.workspaceDir, warn);

  const firstCycle = await runFirstCycle(input);
  if (!firstCycle.ok) {
    warn(`The first managed Service Host cycle did not complete cleanly (${firstCycle.reason ?? firstCycle.outcome ?? 'unknown'}); the workspace ownership is valid and the next scheduler trigger retries.`);
  }

  const record = after.status === 'service_host_owned' ? after.record : undefined;
  const limitations = limitationsFor(input.host, readiness.readiness);
  let evidencePath: string | undefined;
  try {
    evidencePath = writeEvidence(input.pdHome, {
      schemaVersion: EVIDENCE_SCHEMA,
      recordedAt: (input.now?.() ?? new Date()).toISOString(),
      workspaceDir: input.workspaceDir,
      host: input.host,
      scheduler: {
        state: input.scheduler.state,
        registered: input.scheduler.registered,
        enabled: input.scheduler.enabled,
        ...(input.scheduler.triggerIntervalMs !== undefined ? { triggerIntervalMs: input.scheduler.triggerIntervalMs } : {}),
      },
      ownership: {
        before: before.status,
        after: after.status,
        generation: after.generation,
        ...(record !== undefined ? { record } : {}),
      },
      readiness: {
        status: readiness.readiness,
        ...(readiness.detail !== undefined ? { detail: readiness.detail } : {}),
      },
      firstCycle,
      pendingProvisioning: false,
      limitations,
    });
    input.info?.(`Provisioning evidence: ${evidencePath}`);
  } catch (error) {
    // The ownership write already happened and is the authority; a failed
    // evidence write must be visible, not rolled back or hidden (rc-9).
    warn(`Service Host provisioning evidence could not be written (${error instanceof Error ? error.message : String(error)}). The ownership record itself is intact; inspect ~/.pd/install.json.`);
  }

  input.info?.(`Service Host owns workspace ${input.workspaceDir} (generation ${after.generation}, owner=service_host).`);

  return {
    ownership: provisioned.changed ? 'service_host_owned' : 'already_owned',
    ownershipBefore: before.status,
    ownershipAfter: after.status,
    generation: after.generation,
    readiness: readiness.readiness,
    ...(readiness.detail !== undefined ? { readinessDetail: readiness.detail } : {}),
    firstCycle,
    evidencePath,
    pendingProvisioning: false,
    nextAction: readiness.readiness === 'waiting_for_host_binding'
      ? 'The Service Host scheduler is enabled and owns this workspace, but no host adapter is bound — install a host adapter and bind the workspace before tasks can be consumed.'
      : firstCycle.ok
        ? 'The Service Host owns this workspace and completed its first managed cycle.'
        : 'The Service Host owns this workspace; the first cycle did not complete, and the next scheduler trigger retries from persisted task/lease state.',
    warnings,
  };
}

/** Durable hint that a NEW workspace was committed without Service Host ownership. */
export interface PendingProvisioningMarker {
  /** The REAL resolved directory ownership will be written for. */
  readonly workspaceDir: string;
  /** The operator's original pointer, when it differed (display only). */
  readonly requestedWorkspaceDir?: string;
  /** The host adapter that was being provisioned when the hand-over was deferred. */
  readonly host: HostSelection;
  readonly recordedAt: string;
  readonly reason?: string;
}

/**
 * Every pending hint this PD home recorded.
 *
 * A multi-host install (`--host all`) records one entry per ACTUAL workspace
 * instead of overwriting a single document, so a later explicit enable can
 * resume all of them. This is a HINT, never an ownership authority: the
 * caller still requires explicit enable consent, and the provisioning CAS
 * itself converges any residue ownership state in one atomic write.
 */
export function readAllPendingProvisioning(pdHome: string): {
  entries: readonly PendingProvisioningMarker[];
  warning?: string;
} {
  const { entries, warning } = readPendingRegistry(pdHome);
  return {
    entries: entries.map((entry) => ({
      workspaceDir: entry.workspaceDir,
      host: entry.host,
      recordedAt: entry.recordedAt,
      ...(entry.requestedWorkspaceDir !== undefined ? { requestedWorkspaceDir: entry.requestedWorkspaceDir } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    })),
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * Read the pending hint for ONE workspace.
 *
 * Unreadable/foreign records are `null` (fail-closed, never a guess); the
 * caller then leaves the workspace un-provisioned.
 */
export function readPendingProvisioningEvidence(pdHome: string, workspaceDir: string): PendingProvisioningMarker | null {
  const found = findPendingEntry(pdHome, workspaceDir);
  return found === undefined
    ? null
    : {
        workspaceDir: found.workspaceDir,
        host: found.host,
        recordedAt: found.recordedAt,
        ...(found.requestedWorkspaceDir !== undefined ? { requestedWorkspaceDir: found.requestedWorkspaceDir } : {}),
        ...(found.reason !== undefined ? { reason: found.reason } : {}),
      };
}
