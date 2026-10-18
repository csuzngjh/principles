---
'@principles/core': minor
---

PRI-966 G2: register the Learning Lab real-actor round contract (`learning-lab-actor-action-v1`) in OUTPUT_SCHEMA_REGISTRY and export its schema — lets the research actor reuse the production PiAiRuntimeAdapter structured-output machinery. Production runners never pass this ref (research-only consumer; wired and rehearsed offline in scripts/dev/principle-learning-lab, no real model calls).
