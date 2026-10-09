---
"@principles/codex-adapter": patch
---

PRI-943: the pd-hook process boundary is now fail-open by construction, not by convention. The hook promises Codex `exitCode 0` plus exactly one JSON object on stdout, but three terminal paths could still abort the process with exit 1: the write-out tail (`stderr` loop, `stdout` JSON, `process.exitCode`) sat outside `main()`'s try, EPIPE from a host that closed the pipe arrives as an **async `'error'` event** no try/catch can reach (node then dies with "Unhandled 'error' event"), and `void main()` had no rejection handler. Each is now belted on its own — per-write guards, one-shot `'error'` listeners armed only on the entry path, and a last-resort entry `catch` that still emits `{}` when nothing reached stdout — with a single bounded `hook_stream_failed` / `hook_fatal` diagnostic on stderr, never in the machine channel.
