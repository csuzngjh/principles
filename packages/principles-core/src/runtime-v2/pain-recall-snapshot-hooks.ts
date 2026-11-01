/**
 * Pain Recall snapshot test hooks — internal test seam, migrated with the
 * read model from pd-cli services (SPEC-PD-AGENT-CAPABILITY-API-001 v0.5 §6.3).
 *
 * Deterministic fault-injection seam for snapshot-race tests — the same
 * pattern as the runtime's databaseFactory seam (PR #2192). Every field is
 * undefined in production; tests assign, then clear in a finally block.
 *
 * INTERNAL MODULE: this file must never appear in any package exports key.
 * Core tests reference it relatively; the read model references it relatively.
 * The architecture guard (G-2 export-face snapshot) pins its absence from
 * both the read-model and the capability subpaths.
 */

/**
 * Structural stand-in for `fs.Stats` — exactly the members the read model's
 * fingerprint path reads. Structural so this internal module needs no fs
 * import at all (the runtime fs import stays owned by the seam-registered
 * read model). A real `fs.Stats` satisfies this shape structurally.
 */
export interface SnapshotStatsLike {
  isFile(): boolean;
  readonly size: number;
}

export const painRecallSnapshotTestHooks: {
  /** Replaces statSync for fingerprinting/classification (throw to simulate EACCES/EIO). */
  statSync?: (path: string) => SnapshotStatsLike;
  /** Replaces mkdtempSync for staging-root creation (throw to simulate failure). */
  mkdtempSync?: (prefix: string) => string;
  /** Called after each source→staging copyFileSync with (source, staged). */
  afterCopyFile?: (source: string, stagedPath: string) => void;
  /**
   * Called between the T1 main fingerprint read and the T1 wal fingerprint
   * read — the exact window a concurrent writer can hide in when the pair is
   * sampled non-atomically. Tests use it to inject a deterministic
   * commit→checkpoint→close cycle inside the re-check.
   */
  afterT1MainFingerprint?: (sourceDbPath: string) => void;
} = {};
