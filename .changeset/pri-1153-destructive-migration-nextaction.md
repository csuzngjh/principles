---
'create-principles-disciple': patch
---

PRI-1153: destructive-migration refusals now carry an executable next action and no longer point at a maintenance workflow that does not exist. The console also surfaces the executor's nested `no_update` result as `update_blocked` instead of reporting it as unresponsive.
