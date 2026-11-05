/**
 * `pd mcp logs export` — bundle the durable PD MCP logs for offline analysis.
 *
 * The Owner runs one command on the machine where PD is installed; the
 * resulting zip can be sent to an agent as-is. Contents:
 *   README.md     field/event meanings + privacy contract
 *   manifest.json generation window, file list, sizes (no absolute paths)
 *   *.jsonl       the raw sanitized log lines, unmodified
 *
 * The archive is bounded (≤20 MiB) and includes only the last N days (default
 * 7) of `mcp-*.jsonl` from the PD-owned log directory. Nothing here reads or
 * rewrites a log file.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildZip, type ZipEntry } from '../services/zip-writer.js';

export interface McpLogsExportOptions {
  days?: number;
  out?: string;
  json?: boolean;
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 18 * 1024 * 1024;
const DEFAULT_DAYS = 7;
const LOG_FILE_PATTERN = /^mcp-.*\.jsonl$/;

interface CollectedFile {
  readonly name: string;
  readonly fullPath: string;
  readonly size: number;
  readonly mtimeMs: number;
  data: Buffer;
}

interface Manifest {
  readonly generatedAt: string;
  readonly tzOffsetMinutes: number;
  readonly days: number;
  readonly source: string;
  readonly files: readonly { name: string; bytes: number; lines: number; modifiedAt: string }[];
  readonly skippedForSize: readonly string[];
  readonly totalBytes: number;
  readonly note: string;
}

function logDirPath(): { dir: string; source: string } {
  const override = process.env.PD_MCP_LOG_DIR;
  if (typeof override === 'string' && override.trim().length > 0) {
    return { dir: path.resolve(override), source: 'PD_MCP_LOG_DIR (custom)' };
  }
  return { dir: path.join(os.homedir(), '.pd', 'logs', 'mcp'), source: '~/.pd/logs/mcp' };
}

function localTimestamp(date: Date): { ts: string; tzOffsetMinutes: number } {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return {
    ts:
      `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
      `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
    tzOffsetMinutes: offset,
  };
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const char of text) if (char === '\n') lines += 1;
  return text.endsWith('\n') ? lines : lines + 1;
}

const README = `# PD MCP logs bundle

This archive was produced by \`pd mcp logs export\`. It contains the sanitized
JSON Lines log files written by the PD MCP server and its launcher.

## Privacy

- No pain text, principle text, tool input, token, secret or workspace path is
  recorded. Workspaces are represented by a short fingerprint.
- Paths never appear in events. Hosts and environment variables appear only
  as booleans or enum values.
- Each line has the same fields the server already writes to stderr.

## Common fields

| field | meaning |
| --- | --- |
| ts | event time, RFC3339 with the machine's local offset |
| tzOffsetMinutes | local UTC offset in minutes |
| runId | 8-hex id shared by the launcher and server of ONE process |
| seq | per-file sequence starting at 1; gaps mean dropped lines |
| server | pd-mcp-launcher or pd-mcp-server |
| version | emitting component version |
| level | info / warn / error |
| event | event name (see below) |
| host | codex / openclaw / workbuddy / unspecified |
| pid | process id |

## Events

### launcher_start
Emitted once after binding validation, before importing the server.

| field | meaning |
| --- | --- |
| launcherVersion | launcher contract stamp |
| mcpServerVersion | installed server package version |
| bindingPathExists | mcp-binding.json exists (boolean, never the path) |
| workspaceResolution | ok / not_checked / declaration failure category |
| envPresence | booleans for PD_MCP_WORKSPACE_DIR, PD_MCP_HOST, PD_WORKSPACE_DIR, OPENCLAW_WORKSPACE |

### startup
Server resolved a usable binding.

| field | meaning |
| --- | --- |
| host | host marker |
| workspaceFingerprint | sha256(path) prefix 16; same workspace = same value |
| nodeVersion | Node runtime version |
| platform | process.platform |

### initialize
Two lines per MCP handshake: phase=request (client asked) and phase=response
(the server answered). If only the request line exists, the handshake never
completed.

| field | meaning |
| --- | --- |
| phase | request / response |
| requestId | bounded JSON-RPC id |
| clientName / clientVersion / protocolVersion | bounded labels (request) |
| capabilityKeysCount | number of client capability keys (request) |
| ok | response succeeded (response) |
| errorCode | bounded error code when ok=false |
| durationMs | request → response time |
| responseBytes | response JSON size |

### tools_list
Same two-phase shape as initialize; response adds toolCount.

### tool_call
One line per call, including refused/deadline/exception paths.

| field | meaning |
| --- | --- |
| toolName | MCP tool name |
| durationMs | call duration |
| status | ok / partial / unavailable / invalid_input ... |
| errorCode | bounded code; see below |
| responseBytes | bytes returned to the client |
| truncated | true only if the response was truncated (never: over-budget responses are withheld) |

Diagnostic errorCode values: shutting_down, saturated, deadline_exceeded,
tool_execution_failed, response_budget_exceeded, failure_envelope_over_budget.

### shutdown
| field | meaning |
| --- | --- |
| reason | stdin_closed |
| orphans | timed-out calls still settling |
| active | calls executing at close |
| uptimeMs | process uptime |

### startup_failure
A process exited before the MCP handshake completed. This is the ONLY PD-side
evidence available for that failure class.

| field | meaning |
| --- | --- |
| stage | server / launcher |
| reasonCategory | invalid_binding (server) |
| reasonCode | workspace_env_missing, workspace_not_absolute, workspace_unreadable, workspace_not_directory, host_invalid |
| reason | bounded launcher failure code (launcher stage) |
| bindingPathExists | boolean |
| workspaceResolution | ok / not_checked / declaration category |
| envPresence | environment-variable presence booleans |
| envVar | env var named by an invalid binding |
| nextAction | remediation hint (no paths or values) |

## How to read it

- No launcher_start and no startup_failure: the host never started PD.
- launcher_start without startup: the server failed between validation and
  startup, or was killed.
- initialize request without initialize response: handshake failed.
- initialize response without tool_call: the model never called the tool.
- tool_call status=partial: the capability returned partial data (one or more
  sources unavailable); status=unavailable: inspect errorCode.
`;

function resolveOutputPath(out: string | undefined, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const defaultName = `pd-mcp-logs-${stamp}.zip`;
  if (typeof out !== 'string' || out.trim().length === 0) {
    return path.resolve(process.cwd(), defaultName);
  }
  const resolved = path.resolve(out.trim());
  return resolved.toLowerCase().endsWith('.zip') ? resolved : path.join(resolved, defaultName);
}

export async function handleMcpLogsExport(opts: McpLogsExportOptions = {}): Promise<void> {
  const days = Number.isInteger(opts.days) && (opts.days as number) > 0 ? (opts.days as number) : DEFAULT_DAYS;
  if (days > 365) throw new Error('--days must be between 1 and 365');
  const now = new Date();
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const { dir, source } = logDirPath();

  const skipped: string[] = [];
  const collected: CollectedFile[] = [];
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        const stat = fs.statSync(fullPath);
        return { name: entry.name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((file) => file.mtimeMs >= cutoff)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    let budget = MAX_UNCOMPRESSED_BYTES;
    for (const file of files) {
      if (file.size > budget) {
        skipped.push(file.name);
        continue;
      }
      const data = fs.readFileSync(file.fullPath);
      budget -= data.length;
      collected.push({ ...file, data });
    }
  }
  // Oldest first in the archive keeps a natural reading order.
  collected.sort((left, right) => left.mtimeMs - right.mtimeMs);

  const outPath = resolveOutputPath(opts.out, now);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let archive: Buffer;
  let base = localTimestamp(now);
  while (true) {
    const included = collected;
    const manifest: Manifest = {
      generatedAt: base.ts,
      tzOffsetMinutes: base.tzOffsetMinutes,
      days,
      source,
      files: included.map((file) => ({
        name: file.name,
        bytes: file.data.length,
        lines: countLines(file.data.toString('utf8')),
        modifiedAt: localTimestamp(new Date(file.mtimeMs)).ts,
      })),
      skippedForSize: skipped,
      totalBytes: included.reduce((sum, file) => sum + file.data.length, 0),
      note: included.length === 0 ? 'No MCP log files matched the requested window.' : '',
    };
    const entries: ZipEntry[] = [
      { name: 'README.md', data: Buffer.from(README, 'utf8') },
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      ...included.map((file) => ({ name: file.name, data: file.data })),
    ];
    archive = buildZip(entries, now);
    if (archive.length <= MAX_ZIP_BYTES) break;
    // Size is enforced on the compressed result: drop the oldest file and retry.
    const dropped = collected.shift();
    if (dropped === undefined) throw new Error('Bundle exceeds 20 MiB even without log files');
    skipped.push(dropped.name);
    base = localTimestamp(new Date());
  }

  fs.writeFileSync(outPath, archive);
  const manifestForOutput = {
    output: outPath,
    bytes: archive.length,
    files: collected.map((file) => file.name),
    days,
    skippedForSize: skipped,
  };
  if (opts.json) {
    console.log(JSON.stringify(manifestForOutput, null, 2));
    return;
  }
  console.log(`PD MCP log bundle: ${outPath}`);
  console.log(`Window: last ${days} day(s) | files: ${collected.length} | size: ${archive.length} bytes`);
  for (const file of collected) {
    console.log(`  ${file.name} (${file.data.length} bytes, ${countLines(file.data.toString('utf8'))} lines)`);
  }
  if (skipped.length > 0) {
    console.log(`  skipped for size/window: ${skipped.join(', ')}`);
  }
}
