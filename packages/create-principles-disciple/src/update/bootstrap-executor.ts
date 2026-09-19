/**
 * Bootstrap update executor (SPEC v0.3 §6.1, ADR-0024 §6).
 *
 * The short-lived program the installer deploys to `~/.pd/bootstrap/executor/`.
 * It hosts ReleaseManager operations so an update survives the death of the UI
 * that started it: the Console (or Companion) spawns this process detached and
 * continues querying the transaction journal while the executor works.
 *
 * Two transports, one strict JSON contract (bootstrap-protocol.ts):
 *  - file mode:  `--request-file <path> --result-file <path>` — used by the
 *    Console route; the detached child cannot inherit stdin.
 *  - stdin mode: one JSON object on stdin, one JSON object on stdout — the
 *    SPEC §6.1 wire contract for interactive callers.
 *
 * The executor holds ZERO mutation authority beyond ReleaseManager itself; it
 * never writes installation files directly.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  parseBootstrapRequest,
  serializeBootstrapResponse,
  handleBootstrapRequest,
  type BootstrapResponse,
} from './bootstrap-protocol.js';
import { createReleaseManagerAuthority } from './release-manager-authority.js';

export interface BootstrapExecutorResult {
  readonly response: BootstrapResponse;
  /** Path the response was also written to, when file mode was used. */
  readonly resultFile: string | null;
}
export interface BootstrapExecutorOptions {
  /** Raw request text (already read from stdin or the request file). */
  readonly rawRequest: string;
  /** When set, the response is ALSO written here (one JSON object + newline). */
  readonly resultFile?: string | undefined;
}

export async function runBootstrapExecutor(options: BootstrapExecutorOptions): Promise<BootstrapExecutorResult> {
  let response: BootstrapResponse;
  let resultFile: string | null = null;
  try {
    const request = parseBootstrapRequest(options.rawRequest);
    // PRI-850 review fix: `ping` is a program-liveness self-check — it must
    // answer WITHOUT reading installation state, so a corrupt pending-repair
    // registration can never fail the delivery probe. Install-state-dependent
    // ops construct the authority (whose readiness reflects that state).
    if (request.op === 'ping') {
      response = { ok: true, result: { pong: true } };
    } else {
      const authority = createReleaseManagerAuthority({
        pdHome: path.join(os.homedir(), '.pd'),
        // The executor resolves the metadata source exactly like the Console:
        // process env first, then the durable install.json tier. No guessing.
        metadataBaseUrl: process.env.PD_RELEASE_METADATA_URL,
      });
      // Only apply passes the authority readiness gate — read ops (inspect /
      // check) must answer on ANY installation so the repair flow can see the
      // actual state; check carries its own policy gating.
      if (request.op === 'apply' && !authority.kinds['apply-full'].ready) {
        const readiness = authority.kinds['apply-full'];
        response = {
          ok: false,
          reason: readiness.reasons[0] ?? 'install_state_corrupt',
          message: 'The installation is not ready for a signed release update.',
          nextAction: 'Run the official installer (npx create-principles-disciple) to repair the installation, then retry.',
        };
      } else {
        // handleBootstrapRequest never throws: manager failures come back as
        // structured protocol refusals.
        response = await handleBootstrapRequest(request, authority.manager);
      }
    }
  } catch (error) {
    response = {
      ok: false,
      reason: 'executor_invalid_request',
      message: error instanceof Error ? error.message : String(error),
      nextAction: 'Fix the bootstrap request and retry.',
    };
  }
  const { resultFile: targetResultFile } = options;
  if (targetResultFile !== undefined) {
    resultFile = targetResultFile;
    writeFileSync(targetResultFile, `${JSON.stringify(response)}\n`, 'utf8');
  }
  return { response, resultFile };
}

/**
 * CLI entry: `node bootstrap-entry.js [--request-file <p>] [--result-file <p>]`.
 * Without --request-file the request is read from stdin; without --result-file
 * the response goes to stdout. Exit code: 0 on an ok response, 3 on a refusal
 * (the response itself always carries the structured reason).
 */
export async function main(argv: readonly string[]): Promise<number> {
  let requestFile: string | undefined;
  let resultFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--request-file' && index + 1 < argv.length) {
      requestFile = argv[index + 1];
      index += 1;
    } else if (argument === '--result-file' && index + 1 < argv.length) {
      resultFile = argv[index + 1];
      index += 1;
    }
  }
  const rawRequest = requestFile !== undefined
    ? readFileSync(requestFile, 'utf8')
    : fs.readFileSync(0, 'utf8');
  const { response } = await runBootstrapExecutor({ rawRequest, ...(resultFile !== undefined ? { resultFile } : {}) });
  if (resultFile === undefined) {
    process.stdout.write(serializeBootstrapResponse(response));
  }
  return response.ok ? 0 : 3;
}
