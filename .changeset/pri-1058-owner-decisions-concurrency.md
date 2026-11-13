---
"create-principles-disciple": patch
---

Owner decision inbox (Console) reads each shadow activation's owner review with bounded concurrency instead of one at a time.

- Root cause: `listOwnerDecisionItems` awaited `getOwnerReview()` sequentially, and each review runs two real pd CLI probes with a 15s budget. Wall time therefore grew as `N × probes` against the Console's fixed 10s request budget, so a loaded machine answered `GET /api/governance/owner-decisions` with a 504 while the single-activation route stayed inside budget.
- The read itself is unchanged (same read-only connection scope, same probes, same readiness predicate). Only the interleaving changes: at most 4 reviews are in flight, and outcomes are folded in the original row order, so item order, read-issue counts, sample ids and the first detail string stay identical to the serial projection.
- Not addressed here: the 15s probe budget still exceeds the 10s request budget, so a single very slow probe — or a shadow count well above the concurrency bound — can still exceed the budget. That is the structural half of the issue and stays with its owner.
