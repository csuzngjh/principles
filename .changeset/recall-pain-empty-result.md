---
'@principles/core': patch
---

Fix pain recall silently returning an empty association set when a principle's only pain lives in the workspace state database, and normalize split-pipeline diagnosis task refs (`diagnosis_<pain>`) before resolving them as canonical pain ids. Recall now reports unresolved associations with an explicit reason and next action instead of a clean empty result.
