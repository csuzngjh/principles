import pc from 'picocolors';

let _quiet = false;

export function setQuietMode(quiet: boolean): void {
  _quiet = quiet;
}

const logger = {
  info: (msg: string) => { if (!_quiet) console.log(`${pc.blue('ℹ')} ${msg}`); },
  success: (msg: string) => { if (!_quiet) console.log(`${pc.green('✔')} ${msg}`); },
  warn: (msg: string) => { if (!_quiet) console.log(`${pc.yellow('⚠')} ${msg}`); },
  error: (msg: string) => { if (!_quiet) console.log(`${pc.red('✖')} ${msg}`); },

  step: (msg: string) => {
    if (!_quiet) console.log(`\n${pc.yellow('📦')} ${msg}\n`);
  },

  list: (title: string, entries: { name: string; value: string }[]) => {
    if (_quiet) return;
    console.log(`\n${pc.bold(title)}`);
    entries.forEach(e => console.log(`  ${pc.cyan(e.name)}: ${e.value}`));
  }
};

const banner = `${pc.blue('╔══════════════════════════════════════════════════════════════╗')}
${pc.blue('║')}     ${pc.bold(pc.red('🦞 Principles Disciple'))} - OpenClaw Plugin Installer      ${pc.blue('║')}
${pc.blue('╚══════════════════════════════════════════════════════════════╝')}`;

export { logger, banner };
