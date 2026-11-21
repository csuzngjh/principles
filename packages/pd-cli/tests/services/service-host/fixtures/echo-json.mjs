// Fixture: emit one JSON document shaped like a worker cycle result, then exit.
const payload = JSON.stringify({ workspaceDir: process.argv[2], mode: 'ready' });
process.stdout.write(payload);
