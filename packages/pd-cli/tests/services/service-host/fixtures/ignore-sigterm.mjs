// Fixture: ignore SIGTERM so the bounded ladder must escalate to SIGKILL.
process.on('SIGTERM', () => {
  process.stderr.write('sigterm-ignored\n');
});
setTimeout(() => process.exit(0), 120_000);
