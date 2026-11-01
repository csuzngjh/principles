/**
 * Build-time runtime mode.
 *
 * Vite replaces `import.meta.env.DEV` with a boolean literal at build time, so
 * a production bundle resolves this to `false` and dead-code elimination can
 * drop the DEV-only surfaces from the shipped UI. This is a trust boundary in
 * the CLIENT only — the server independently refuses the Examiner API outside
 * a dev runtime (see `examinerDevEnabled` in the examiner route).
 */
export const IS_DEV = (import.meta as unknown as { env: { DEV: boolean } }).env.DEV;
