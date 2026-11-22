/**
 * SPEC-PD-SERVICE-HOST-001 §7/§8.2 (PRI-1281 Phase 3) — Console read-only
 * Service Host status.
 *
 *   GET /api/service-host/status
 *
 * The Console NEVER owns scheduler lifecycle (§7): this route only READS the
 * unified status contract by spawning `pd service status --json` — the same
 * single implementation the CLI/Companion use (P4). It does not re-detect
 * the OS scheduler in-process, does not start Workers and writes nothing.
 */
import { spawn } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import { resolvePdCliInvocation } from './diagnostician.js';
import { sendError, sendJson } from '../utils/response.js';

const STATUS_TIMEOUT_MS = 30_000;

/** Injectable CLI boundary so tests never spawn a real process. */
export interface ServiceHostStatusRuntime {
  readStatus(): Promise<{ ok: true; document: unknown } | { ok: false; reason: string; nextAction: string }>;
}

/** Production runtime: spawn the installed pd CLI's status command. */
export function createCliServiceHostStatusRuntime(): ServiceHostStatusRuntime {
  return {
    async readStatus() {
      const { entryPath } = resolvePdCliInvocation();
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (value: Awaited<ReturnType<ServiceHostStatusRuntime['readStatus']>>): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(value);
        };
        let child: ReturnType<typeof spawn>;
        timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // close handler settles
          }
          settle({ ok: false, reason: 'service_host_status_timeout', nextAction: `pd service status did not finish in ${STATUS_TIMEOUT_MS / 1000}s; retry the request.` });
        }, STATUS_TIMEOUT_MS);
        try {
          child = spawn(process.execPath, [entryPath, 'service', 'status', '--json'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settle({ ok: false, reason: `service_host_status_spawn_failed:${message.slice(0, 120)}`, nextAction: 'The pd CLI could not be started; check the installed runtime and retry.' });
          return;
        }
        child.on('error', (error: Error & { code?: string }) => {
          settle({ ok: false, reason: `service_host_status_spawn_failed:${error.code ?? error.message}`, nextAction: 'The pd CLI could not be started; check the installed runtime and retry.' });
        });
        child.stdout?.on('data', (chunk: Buffer) => {
          if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8');
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
        });
        child.on('close', (code) => {
          // cli-1 (task §1 review): stdout must be EXACTLY ONE JSON
          // document — the whole trimmed stdout is parsed. A log line
          // before/after the JSON, an empty stdout, or a truncated document
          // all fail closed and are never reported as a status document.
          const stdoutDoc = stdout.trim();
          if (stdoutDoc === '') {
            settle({
              ok: false,
              reason: `service_host_status_no_json:exit_${code ?? 'null'}${stderr.trim() !== '' ? `:${stderr.trim().slice(0, 160)}` : ''}`,
              nextAction: 'pd service status produced no machine-readable output. The Console stays read-only — run it in a terminal for the full output.',
            });
            return;
          }
          let document: unknown;
          try {
            document = JSON.parse(stdoutDoc);
          } catch {
            settle({ ok: false, reason: 'service_host_status_unparsable', nextAction: 'pd service status stdout was not a single JSON document (log-mixed or truncated output is refused); run it in a terminal to inspect.' });
            return;
          }
          if (typeof document !== 'object' || document === null || Array.isArray(document)) {
            settle({ ok: false, reason: 'service_host_status_schema_violation', nextAction: 'pd service status emitted JSON that is not a status object; run it in a terminal to inspect.' });
            return;
          }
          if (code === 0) {
            const { schemaVersion } = document as { schemaVersion?: unknown };
            if (schemaVersion !== 'pd.service-status.v1') {
              settle({ ok: false, reason: 'service_host_status_schema_violation:schema_version', nextAction: 'pd service status emitted a document with an unknown schemaVersion; the Console refused it rather than guess its shape.' });
              return;
            }
            settle({ ok: true, document });
            return;
          }
          settle({
            ok: false,
            reason: `service_host_status_failed:exit_${code ?? 'null'}${stderr.trim() !== '' ? `:${stderr.trim().slice(0, 160)}` : ''}`,
            nextAction: 'pd service status did not succeed. The Console stays read-only — run it in a terminal for the full output.',
          });
        });
      });
    },
  };
}

export interface ServiceHostRouteOptions {
  readonly subPath: string;
  readonly runtime?: ServiceHostStatusRuntime;
}

export async function handleServiceHostRoute(req: IncomingMessage, res: ServerResponse, options: ServiceHostRouteOptions): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // The Console NEVER owns Service Host lifecycle (SPEC §7) — the route
    // surface is GET-only by construction.
    sendError(res, 405, 'method_not_allowed', 'GET only — the Console never owns Service Host lifecycle (SPEC §7)');
    return;
  }
  if (options.subPath !== '/status') {
    sendError(res, 404, 'not_found', `Unknown service-host path: ${options.subPath}. Only /api/service-host/status exists (read-only).`);
    return;
  }
  const runtime = options.runtime ?? createCliServiceHostStatusRuntime();
  const result = await runtime.readStatus();
  if (result.ok) {
    sendJson(res, 200, result.document);
    return;
  }
  sendError(res, 503, result.reason, result.nextAction);
}
