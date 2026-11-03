---
'@principles/host-runtime': patch
---

PRI-988: `INTERNALIZATION_CONSUMER_SKIP` events now carry the queue's `noReadyTasks`, `invalidMetadataCount` and bounded `sampleInvalidTaskIds` diagnostics, so heartbeat telemetry distinguishes an empty queue from hydration failures.
