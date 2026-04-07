# Phase 11: Critical Safety Fixes - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-07
**Phase:** 11-critical-safety-fixes
**Areas discussed:** CLEAN-01 Fix, CLEAN-02 Decision

---

## CLEAN-01: normalizePath Rename

| Option | Description | Selected |
|--------|-------------|----------|
| normalizePathPosix (Recommended) | Accurately describes POSIX forward-slash normalization — clear, unambiguous | ✓ |
| normalizeNocturnalPath | Qualifies by module name — but module name is a service detail, not semantic | |
| Other name | Suggest a different name | |

**User's choice:** normalizePathPosix (Recommended)

**Notes:** User confirmed the recommended option. The function in `nocturnal-compliance.ts` does simple POSIX normalization (replaces `\` with `/`), which is fundamentally different from `utils/io.ts`'s WSL/Windows path conversion with project-relative output.

---

## CLEAN-02: PAIN_CANDIDATES Path Decision

| Option | Description | Selected |
|--------|-------------|----------|
| DELETE (Recommended) | Remove trackPainCandidate + processPromotion entirely — evolution queue is the single active path. PAIN_CANDIDATES fallback is disconnected legacy code. | ✓ |
| INVESTIGATE first | Don't decide yet — need more analysis of whether this system has any live value before deleting | |
| INTEGRATE | Keep PAIN_CANDIDATES but wire it into evolution-reducer so they share the same pipeline | |

**User's choice:** DELETE (Recommended)

**Notes:** User confirmed DELETE. The PAIN_CANDIDATES system is completely disconnected from the evolution queue. It was a legacy fallback that never got integrated. Evolution queue (L2 dictionary + L3 semantic FTS5) is the single active pain→principle path.

---

## Auto-Resolved

None — all decisions were made interactively.

---

## External Research

No external research was performed. Both issues had sufficient context from codebase analysis.
