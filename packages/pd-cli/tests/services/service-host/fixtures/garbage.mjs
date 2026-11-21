// Fixture: not JSON at all (malformed-output fail-closed path).
process.stdout.write('this is definitely not json {{{');
process.exitCode = 0;
