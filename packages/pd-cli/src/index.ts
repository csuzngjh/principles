#!/usr/bin/env node
/**
 * pd CLI — Principles Disciple command-line interface.
 *
 * Usage:
 *   pd pain record --reason <text> [--score N] [--source manual]
 */

import { Command } from 'commander';
import { handlePainRecord } from './commands/pain-record.js';

const program = new Command();

program
  .name('pd')
  .description('PD CLI — Pain recording, sample management, and evolution tasks')
  .version('0.1.0');

const painCmd = program
  .command('pain')
  .description('Pain signal management');

painCmd
  .command('record')
  .description('Record a pain signal')
  .option('-r, --reason <text>', 'Reason for the pain signal (required)')
  .option('-s, --score <number>', 'Pain score 0-100', parseInt)
  .option('-S, --source <text>', 'Source of the pain signal', 'manual')
  .action(async (opts) => {
    await handlePainRecord(opts);
  });

program.parse();
