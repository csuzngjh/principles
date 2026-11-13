---
---

CI only: move the publish npm pin into a shared composite action that installs
`npm@11.19.1` into an isolated `--prefix` (never over the toolcache copy Node
ships with), and add a `Publish toolchain check` workflow that runs on PRs and
on dispatch, prints `node -v` / `npm -v`, and fails unless the resolved npm
parses to >= 11.5.1.

Node 22.22.2 ships npm 10.9.7, which has no OIDC trusted publishing, so the
publish legs silently fell back to `NPM_TOKEN` and the registry rejected
`principles-disciple@4.0.0` with "Two-factor authentication is required to
publish this package" (run 43238870812). Overwriting the toolcache npm with
`npm i -g npm@11.19.1` then broke the runner's own npm (runs 43334905024 and
43342682252), so the pin is isolated instead.

No release intent: workflow + tests only, no package code or version change.
