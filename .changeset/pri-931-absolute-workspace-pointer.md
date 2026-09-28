---
"principles-disciple": patch
"create-principles-disciple": patch
---

A workspace pointer that is not already absolute is now rejected instead of
being resolved. A value that lost its separators in transit — `"D:.openclawworkspace"`
for `D:\.openclaw\workspace` — used to be handed to `path.resolve()`, which
turned it into a plausible absolute path that depends on the process working
directory. The same config could then send governance state
(`.pd/state.db`, `.state/trajectory.db`) to a different directory depending on
which process read it, with no warning.

The plugin now rejects such a candidate and falls through to the next declared
source, and the installer refuses to persist a non-absolute workspace pointer
in the first place. Both directions fail loudly instead of splitting
(PRI-931).
