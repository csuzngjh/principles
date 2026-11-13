---
"@principles/pd-cli": patch
---

`pd console open --json` reports `authenticationMode` again (always `no_auth`). Companion builds from before the token removal compare this field with their own expectation, so omitting it made them abort with `console_authentication_mode_mismatch: expected=no_auth, actual=unverified` after the Runtime had already been updated. The value is a verbatim echo of `/api/health` and is not used for any local decision.
