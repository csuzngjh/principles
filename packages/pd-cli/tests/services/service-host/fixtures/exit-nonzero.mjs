// Fixture: nonzero exit with an unparseable document (worker crash shape).
process.stdout.write('partial-output-without-json');
process.stderr.write('fixture worker exploded\n');
process.exit(3);
