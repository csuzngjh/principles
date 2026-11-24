---
---

check-installer-lock-specs: tolerate spec drift on workspace-internal deps whose spec is only satisfiable by a version materialized in the same release cohort — the nested lockfile cannot be regenerated before that cohort publishes (e.g. @principles/install-layout ^0.11.0 on a Version Packages PR). CI/tooling-only fix; non-release-affecting.
