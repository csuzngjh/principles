---
'create-principles-disciple': patch
---

Release-verification fix: the N-1 → N upgrade gate's backup assertion targeted the pd-cli `node_modules/@principles/core` slot, which is a physical copy by construction (npm ci `--install-links` materializes `file:../core`; syncPdCli copies node_modules wholesale; the PRI-665 scenario additionally injects a physical duplicate into exactly that slot) — so the publish release matrix failed with "expected false to be true" on ubuntu-24.04/node 22. The rename-swap junction proof now uses the codex-adapter core link (the one slot the installer guarantees as a canonical link), and the pd-cli core slot instead proves the complementary invariant: the injected physical tree moved verbatim, never traversed. Test-only change; no shipped behavior difference — it unblocks the pending 1.145.31/2.2.6 release cohort. PRI-1037 S9 follow-up.
