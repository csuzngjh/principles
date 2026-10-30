---
'create-principles-disciple': patch
---

PRI-1054: the installer's end-of-run console auto-launch now inherits the
machine's declared authentication posture instead of hardcoding `--no-auth`.

- With a non-empty `PD_CONSOLE_TOKEN` in the environment, the update chain
  spawns `pd console open` without `--no-auth`, so the console it brings up is
  in the same mode the previous one was in. `pd console open` resolves the
  token from the same variable, so nothing new is invented here.
- The readiness probe is two-phase in that mode: a bare probe first, and only a
  responder that answers 401 with the console's own `unauthorized` envelope gets
  `Authorization: Bearer <token>` retried. 200 is accepted only when
  `data.authenticationMode` equals the launched posture — the same fact
  `pd console open` refuses on — so a pre-existing console in the other mode is
  not certified as the one this installer launched, and the token is never
  sprayed across the scan range.
- The manual `pd console open …` instruction surfaced when auto-launch is
  skipped, when the CLI entry is missing, and when the console never becomes
  ready now carries the same posture. A token-configured machine is no longer
  told to start an unauthenticated console.

Why this mattered: PD Companion requests an authenticated console whenever
`PD_CONSOLE_TOKEN` is in its environment, and it restores that token from its
own encrypted state on every launch. The unconditional `--no-auth` therefore
replaced a healthy authenticated console on every release, and the next
Companion start aborted with `console_authentication_mode_mismatch` — anyone who
had configured a console token had the desktop app bricked by every version
bump, and recovering it meant deleting the token, which in turn locks the
governance decision actions.

Machines with no console token (every fresh install) keep the existing
`--no-auth` default, and `PD_SKIP_CONSOLE_AUTOLAUNCH` (release smoke, upgrade
gate) is unchanged.
