---
'@principles/core': patch
'@principles/host-runtime': patch
'principles-disciple': patch
---

Legacy cleanup batch 1: remove retired code that had zero production consumers.

- Gate A (`PainDiagnosticGate`) finally retired end to end: the core
  `runtime-v2/pain-gate` policy, its 14-name barrel surface, and the archived
  plugin adapter are deleted. Gate B (`TriggerController` + `evidence-triage`)
  remains the only admission authority.
- Delete two orphan plugin core modules with zero production importers:
  `workflow-funnel-loader.ts` (stale duplicate of the core loader) and
  `thinking-os-parser.ts` (only two tests imported it; its pure parser moved
  to a test helper).
- Delete the `@principles/host-runtime` pain-ingress re-export shim; its one
  production consumer now imports the core semantic authority directly, and
  the SPEC §8.2 matrix test moved next to that authority.
- Reduce the deactivated legacy dev install scripts (`scripts/install.mjs`,
  `packages/openclaw-plugin/scripts/sync-plugin.mjs`) to their PRI-868
  refusal guard, deleting the unreachable installer bodies and their
  test-only helper libraries.

No runtime behavior change: every removed module was unreachable or
test-only after PRI-454 and PRI-868.
