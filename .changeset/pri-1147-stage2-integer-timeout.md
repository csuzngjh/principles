---
'@principles/host-runtime': patch
---

Fix Stage-2 correction review silently consuming attempts under production default budgets: the per-classification timeout derived from the aggregate-budget remainder was fractional (`performance.now()` float arithmetic), and the pi-ai adapter hands it straight to `AbortSignal.timeout`, which rejects non-integer delays with `ERR_OUT_OF_RANGE` before any network I/O. Every classification then failed instantly, each failure consumed a durable attempt via `pending_llm_error`, and after five cycles the pending candidate was abandoned (`llm_error`) without a single real model call. The remainder is now clamped to whole milliseconds at the producer (PRI-1147 real-LLM BDD, ERR-191), with a regression test asserting the classifier receives an integer timeout under the default budgets.
