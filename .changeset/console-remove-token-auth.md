---
'@principles/core': minor
'@principles/pd-cli': minor
'create-principles-disciple': minor
---

Console: remove token/password authentication (local OS session is the credential)

- The Console refuses non-loopback `--host` unconditionally; `/api/*` validates
  `Host` / `Origin` / `Sec-Fetch-Site` (requests with neither header still work
  for CLI and scripts), state-changing routes require a JSON `Content-Type`, and
  HTML responses carry `X-Frame-Options: DENY`.
- Token authentication is gone: `--token`, `--no-auth`, `PD_CONSOLE_TOKEN`, the
  401 path, the login page, browser token storage, the Companion encrypted token
  and its IPC, and the installer auth-posture probe were removed. Legacy flags
  and the env var only print a one-line notice.
- Governance readiness now depends on Owner identity registration instead of
  "token enabled". Owner decisions are recorded as `local_owner_session`
  (schema 003 rebuilds `activation_decisions`'s CHECK); `pd activation promote`
  uses the same criterion and refuses without an identity rather than silently
  degrading to break-glass.
- `authenticationMode` keeps its two enum values on the `/api/health` wire
  contract but no longer participates in readiness.
