---
---
Test-only fix in pd-console (PRI-937): two UI source-contract tests now anchor
their file reads to the test file location instead of `process.cwd()`, so they
run from the repo root as well as the package directory. No runtime, build, or
published-artifact behavior changes — no release needed.
