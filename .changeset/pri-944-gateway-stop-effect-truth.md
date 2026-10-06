---
"create-principles-disciple": patch
---

PRI-944 — an update or install no longer aborts because `openclaw gateway stop`
was slow. The gateway stop was decided by the exit code of a 15s `cmd.exe /c`
wrapper: when the wrapper timed out while the service manager was still closing
the gateway, the installer concluded "refused to stop" and refused the whole
run before touching anything — on the reported host that voided a signed-channel
update at the `verified` stage. `stopOpenClawGateway` now decides by the EFFECT:
after a failed stop it waits (bounded, 30s, 1s polls) until the observed gateway
port has no listener and the observed PID has exited, and only then lets the run
proceed. A refusal is classified so the operator instruction matches reality:
`gateway_still_running` (verified still listening — stop it by hand),
`stop_confirmation_timeout` (port cleared, process lingering — wait and retry),
`verification_unavailable` (nothing observable — refused, never assumed). The
start leg is deliberately unchanged: its failure is a notification, and a cold
start measures in minutes.
