/**
 * pd version command (SPEC §12).
 *
 * Human output prints the short stable version text; `--json` emits exactly
 * one parseable JSON object with the full canonical report (productVersion,
 * releaseId, components, bootstrapVersion, channel, source, generation,
 * health, lastTransaction).
 */

import type { Command } from 'commander';
import { buildVersionReport, formatShortVersion, VersionReportError } from '../services/version-report.js';

async function runVersion(json: boolean): Promise<void> {
  try {
    const report = buildVersionReport();
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatShortVersion(report));
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
    .action(async (opts: Record<string, unknown>) => {
      await runVersion(opts.json === true);
    });
}
