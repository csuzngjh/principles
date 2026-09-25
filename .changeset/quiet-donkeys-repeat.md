---
"create-principles-disciple": patch
---

Update apply now survives a transient release-asset download failure (bounded
retry with backoff) and recycles the transaction's staging directory when the
journal reaches a terminal state, so failed and successful updates no longer
leave ~1.3GB per attempt on the customer's disk (PRI-924).
