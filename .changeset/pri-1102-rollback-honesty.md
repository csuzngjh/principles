---
'create-principles-disciple': patch
---

PRI-1102: the installer now verifies the restored runtime component tree (Console server + Console web entry, pd-cli entry, plugin bundle, OpenClaw plugin entries) instead of only the runtime root, and reports an honest "NOT usable — incomplete" rollback state naming the missing components. A dangling plugin link is removed only when the missing target is confirmed (ENOENT/ENOTDIR); any other filesystem error fails closed and preserves the link.
