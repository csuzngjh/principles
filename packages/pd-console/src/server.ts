import { main } from './server/index.js';

export { main };

// Production entry (installed as <pd-runtime>/console/dist/server.js).
// server/index.ts only self-starts when executed directly, so the packaged
// entry must start the console explicitly.
main().catch((err: unknown) => {
  console.error('[pd-console] Fatal startup error:', err);
  process.exit(1);
});
