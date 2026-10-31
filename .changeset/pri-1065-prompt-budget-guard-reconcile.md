---
'@principles/core': patch
'principles-disciple': patch
'create-principles-disciple': patch
---

Reconcile the prompt size-guard ceiling with the model-aware principle budget: the total injection limit is now the applied principle budget plus a fixed 7000-char background allowance instead of a hard-coded 9000, so large-window models no longer have every background block stripped in one turn (PRI-1065). The reference window still resolves to 9000, so existing behavior is unchanged. The stripped-context notice also no longer claims a diagnostician-priority session, which was untrue whenever the guard fired outside that mode.
