---
"@principles/core": patch
---

Read-only bash classifier no longer lets git optional-value options (`--pretty`, `--format`, `--porcelain`, `--untracked-files`, `--ignore-submodules`) swallow the next token, so `git log --pretty --ext-diff` is no longer classified as safe.
