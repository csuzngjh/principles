---
"@principles/core": patch
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

Allow one budget-safe Adaptive Activation replacement when the workspace explicitly lists the outgoing Owner-approved activation in `adaptiveActivation.replaceableActivationIds`. The selector compares the incoming and outgoing directives for the current task; missing permission, protected directives, or stale authorization preserve the Native prompt.
