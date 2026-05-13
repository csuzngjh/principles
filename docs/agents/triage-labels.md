# Triage Labels

The skills speak in terms of five canonical triage roles.
This file maps those roles to the actual label strings in our Linear workspace.

| Label in mattpocock/skills | Label in Linear       | Meaning                                  |
| -------------------------- | --------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`        | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`          | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`     | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`     | Requires human implementation            |
| `wontfix`                  | `wontfix`             | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"),
use the corresponding label string from this table and apply it via `save_issue` with `labels`.

To change a label name: update this table AND rename the label in Linear (Settings → Labels).
Both must stay in sync — the table is the source of truth for skills.
