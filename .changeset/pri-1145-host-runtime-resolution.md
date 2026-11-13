---
"create-principles-disciple": patch
---

Installed `@principles/host-runtime` now resolves its declared `file:../core` and `file:../install-layout` dependencies as links to the canonical runtime siblings.

- Root cause: `installBundledHostRuntime()` copies the bundled host-runtime into `~/.pd/runtime/host-runtime`, and npm materializes its `file:` dependencies as **physical copies**. Every other installed component (core, pd-cli, console, codex-adapter) had an `ensure*Resolution()` caller that replaced those copies with links; host-runtime — the only component with the same sibling contract and no caller — kept a second copy of `@principles/core` on disk, outside the "one canonical runtime core" invariant.
- Fix reuses the existing `ensureComponentFileDependencyLinks` helper (plan-then-mutate, physical copy → link, wrong target → repaired, missing sibling → fail closed) and invokes it after core and install-layout are deployed.
- Tests: the tri-state contract on a real filesystem (`dependency-link-consolidation`), plus a real `install()` wiring assertion that the deployed `host-runtime/node_modules/@principles/core` is a link to the canonical core (`installed-topology-invariants`). Removing the call site makes the wiring assertion fail with `ENOENT`.
- Not addressed here: the pre-existing declarations are correct, so this is only about applying the existing contract to the one component that was skipped.
