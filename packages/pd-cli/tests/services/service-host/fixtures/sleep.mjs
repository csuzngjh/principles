// Fixture: sleep past any test deadline (timeout ladder).
setTimeout(() => process.exit(0), 120_000);
