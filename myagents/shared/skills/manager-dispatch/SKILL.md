---
name: manager-dispatch
description: Turn incoming issue/proposal/verification signals into explicit routed team tasks.
disable-model-invocation: true
---

# manager-dispatch

Use this skill when `main` needs to:

- classify an incoming signal
- choose the owning role
- create a Repair Task
- escalate for human approval

Output should always include:

- signal type
- chosen owner
- reason
- required artifact
