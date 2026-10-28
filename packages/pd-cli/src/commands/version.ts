/**
 * pd version command (SPEC §12).
 *
 * Human output prints the short stable version text; `--json` emits exactly
 * one parseable JSON object with the full canonical report (productVersion,
 * releaseId, components, bootstrapVersion, channel, source, generation,
 * health, lastTransaction).
 *
 * `--delivery` (PRI-1051) adds the four-surface delivery verdict and makes the
 * exit code the machine-checkable "is this update actually in my hands"
 * signal: every required surface must be `ok`, so `ready_needs_host_restart`
 * also exits non-zero (the bytes arrived, the host has not loaded them yet).
 */

import type { Command } from 'commander';
import { buildVersionReport, formatShortVersion, VersionReportError } from '../services/version-report.js';
import { buildDeliveryReport, formatDeliveryReport } from '../services/delivery-surfaces.js';

async function runVersion(json: boolean, delivery: boolean): Promise<void> {
  try {
    const report = buildVersionReport();
    if (!delivery) {
      if (json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(formatShortVersion(report));
      return;
    }
    const deliveryReport = buildDeliveryReport();
    if (json) {
      console.log(JSON.stringify({ ...report, delivery: deliveryReport }, null, 2));
    } else {
      console.log(formatShortVersion(report));
      console.log('');
      console.log(formatDeliveryReport(deliveryReport));
    }
    if (!deliveryReport.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof VersionReportError) {
      if (json) {
        console.log(JSON.stringify({
          ok: false,
          reason: error.reason,
          message: error.message,
          nextAction: error.nextAction,
        }, null, 2));
      } else {
        console.error(error.message);
        console.error(`Next: ${error.nextAction}`);
      }
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export function registerVersionCommand(program: Command): void {
  program
    .command('version')
    .description('Show the canonical PD product version and installation state')
    .option('--json', 'Emit the full canonical version report as one JSON object', false)
    .option('--delivery', 'Also verify the four delivery surfaces (canonical runtime, OpenClaw extension, Codex plugin, Companion); exits non-zero unless every required surface is ok', false)
    .action(async (opts: Record<string, unknown>) => {
      await runVersion(opts.json === true, opts.delivery === true);
    });
}
