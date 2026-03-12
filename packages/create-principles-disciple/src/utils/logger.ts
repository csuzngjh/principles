/**
 * 彩色日志输出工具
 */
import pc from 'picocolors';

const logger = {
  info: (msg: string) => console.log(`${pc.blue('ℹ')} ${msg}`),
  success: (msg: string) => console.log(`${pc.green('✔')} ${msg}`),
  warn: (msg: string) => console.log(`${pc.yellow('⚠')} ${msg}`),
  error: (msg: string) => console.log(`${pc.red('✖')} ${msg}`),
  
  step: (msg: string) => {
    console.log(`\n${pc.yellow('📦')} ${msg}\n`);
  },
  
  list: (title: string, entries: { name: string; value: string }[]) => {
    console.log(`\n${pc.bold(title)}`);
    entries.forEach(e => console.log(`  ${pc.cyan(e.name)}: ${e.value}`));
  }
};

const banner = `${pc.blue('╔══════════════════════════════════════════════════════════════╗')}
${pc.blue('║')}     ${pc.bold(pc.red('🦞 Principles Disciple'))} - OpenClaw Plugin Installer      ${pc.blue('║')}
${pc.blue('╚══════════════════════════════════════════════════════════════╝')}`;

export { logger, banner };