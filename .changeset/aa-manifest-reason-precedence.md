---
"principles-disciple": patch
"create-principles-disciple": patch
---

PRI-1110 follow-up (P2): the executing-manifest walk now keeps the real read
failure (for example `manifest_too_large`) instead of letting a shallower
directory without a `package.json` replace it with `manifest_ENOENT`. Evidence
notes therefore name the actual reason the plugin version is `unknown`. The
bounded-read and module-load-binding tests now assert the exact byte count,
degradation result and reason code.
