---
"principles-disciple": patch
"create-principles-disciple": patch
---

A workspace pointer that does not name one fixed directory is no longer
resolved. A value that lost its separators in transit —
`"D:.openclawworkspace"` for `D:\.openclaw\workspace` — used to be handed to
`path.resolve()`, which turned it into a plausible absolute path that depends
on the process working directory; a root-relative value such as `\workspace`
was anchored to whichever drive the caller was on. The same config could then
send governance state (`.pd/state.db`, `.state/trajectory.db`) to a different
directory depending on which process read it, with no warning.

The plugin now skips such a candidate, continues with the next declared source
(env > config > default is unchanged), and logs the refusal together with the
source it fell back to. The installer refuses such a workspace before any side
effect, rather than only when writing the config pointer. Values that carry
their own drive, or a UNC share, are unaffected (PRI-931).
