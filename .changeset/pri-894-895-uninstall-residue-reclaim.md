---
"create-principles-disciple": patch
---

PRI-894 + PRI-895 — uninstall reclaims ~/.pd update residue on full shared-runtime teardown. When the last host is uninstalled, `uninstall` now removes staging/, releases/ and backups/ (a GB-scale disk leak) and a dangling active.json that still pointed at a deleted release, after the runtime directory itself is gone and before install.json is removed. Deletion is provably bounded to those three update directories plus the pointer (never a glob of ~/.pd/), so transactions/, logs/, trust/, channels/ and bootstrap/ are left untouched. A corrupt active.json is preserved with an observable note; a partial (single-host) uninstall preserves all residue; and install.json is kept when reclaim fails so a re-run retries instead of stranding the residue.
