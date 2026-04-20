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

program
  .command('pain')
  .description('Pain signal management')
  .argument('<action>', 'Subcommand: record')
  .argument('[args...]', 'Arguments for the subcommand')
  .action((action: string, args: string[]) => {
    if (action === 'record') {
      handlePainRecord(args);
    } else {
      console.error(`Unknown pain action: ${action}`);
      console.error('Usage: pd pain record --reason <text> [--score N] [--source manual]');
      process.exit(1);
    }
  });

program.parse();
