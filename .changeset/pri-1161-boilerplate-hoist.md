---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

feat(principles-core): PRI-1161 hoist the per-block directive boilerplate into the shared header

The shared directive renderer (`renderPrinciplesToDirectives`) no longer repeats "Apply this as an active behavior constraint. Do not treat this as background context." inside every directive block; the instruction is stated once in the shared header ("These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy."). Per-principle body, directive id, authority attribute, escaping and the `<directive>` slice boundaries are unchanged; budget arithmetic stays exact because `measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` derive from the same builders (header +53, each block −86). Selection/refill changes under tight budgets are explained by the unchanged packing rule. Goldens and tuned fixtures updated to the new renderer bytes.
