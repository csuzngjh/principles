# Phase 12 Discussion Log

**Date:** 2026-04-07  
**Mode:** auto  
**Outcome:** context captured without interactive prompts

## Locked Decisions Captured

1. `Rule Host` enters the gate chain after `GFI` and before `Progressive Gate`.
2. `Progressive Gate` remains in place for v1.9.0 and must not be removed in Phase 12.
3. Code implementations run only through a fixed host contract plus a helper whitelist.
4. Host decisions are restricted to `allow`, `block`, and `requireApproval` plus structured diagnostics.
5. Implementation storage is versioned and lifecycle-aware, but replay/promotion is deferred to Phase 13.
6. Nocturnal code candidate generation is deferred to Phase 14.

## Main Planning Risks To Carry Forward

1. Prevent Phase 12 from smuggling replay/promotion concerns into host/storage work.
2. Keep the host contract strict enough that code implementations cannot become arbitrary plugin patches.
3. Preserve Principle Tree authority while adding a file-system asset layout for code implementations.

## Recommended Planning Shape

- Plan 01: versioned code implementation storage + manifest/entry lifecycle primitives
- Plan 02: Rule Host runtime contract + helper whitelist + decision merge path in `gate.ts`
- Optional plan split only if host wiring and storage prove too coupled during planning

---

*Captured automatically after Phase 11 completion*
