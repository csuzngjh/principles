---
'@principles/core': patch
'@principles/pd-cli': patch
'create-principles-disciple': patch
---

Governance is ON by default at install time (an explicit enabled:false opt-out
is preserved and stated), the install summary prints a first-class governance
state line via the new optional HostInstallResult.governance field, pd-cli
workspace discovery learns the WorkBuddy governance workspace, and the
global-pd warning names the always-available node invocation. (PRI-1064)
