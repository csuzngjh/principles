---
"create-principles-disciple": patch
---

Uninstall no longer tells the user to "manually delete" the personal data it
just promised to preserve. The post-uninstall hint (.principles/.state, MD
files) previously read like a cleanup instruction for the same retained
governance directories, risking accidental deletion of data meant to survive a
reinstall. The hint now states the files are intentionally preserved and need
no manual action (PRI-893).
