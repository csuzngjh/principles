/**
 * WorkBuddy project-directory cwd encoding (PRI-1171 P2; SPEC v0.2 §4.4,
 * tech design §5.1).
 *
 * WorkBuddy stores every session transcript under
 * `<home>/.workbuddy/projects/<encoded-cwd>/<sessionId>.jsonl`. The encoding
 * rule is locked to FORENSIC SAMPLES from this machine's real directory
 * names × the `cwd` fields inside their records (docs/plans/
 * 2026-08-28-workbuddy-session-transcript-access.md §2, re-verified
 * 2026-11-11), not to a prose transcription:
 *
 *   `d:\Code\principles`                          → `d-Code-principles`
 *   `d:\Code\principles-private\aze`              → `d-Code-principles-private-aze`
 *   `c:\Users\Administrator\Desktop\车险`           → `c-Users-Administrator-Desktop-车险`
 *   `c:\Users\Administrator\WorkBuddy\2026-09-01…` → `c-Users-Administrator-WorkBuddy-2026-09-01…`
 *
 * Verified properties: the drive letter lowercases; every RUN of `:`, `\`
 * and `/` collapses to a SINGLE `-` (the `d:\` prefix therefore yields one
 * dash, never two); everything else — dashes, dots, underscores, CJK — is
 * preserved byte-for-byte. No collision-suffix or escaping mechanism was
 * observed on disk. The engine-side rule itself is not documented by the
 * host; the fixtures table in tests/ingestion/encode-cwd.test.ts freezes
 * these pairs against regression.
 */
const SEPARATOR_RUN = /[\\/:]+/g;

export function encodeWorkbuddyCwd(cwd: string): string {
  if (cwd.length === 0) return '';
  // Drive-letter prefix: lowercase it before separator collapsing so `D:\x`
  // and `d:\x` encode identically (records carry the lowercase form, hook
  // payloads may carry either).
  const drivePrefixed = /^[A-Za-z]:/.test(cwd) ? cwd.charAt(0).toLowerCase() + cwd.slice(1) : cwd;
  return drivePrefixed.replace(SEPARATOR_RUN, '-');
}
