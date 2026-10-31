---
'@principles/pd-cli': patch
---

Make pd-cli startup host-agnostic: the Codex adapter is now imported lazily
inside the pain-explicit and health-codex handlers (with an observable
codex_adapter_unavailable degradation instead of a raw ERR_MODULE_NOT_FOUND),
and classifyCodexVersion is injected into the install health module. A
workbuddy-host install without @principles/codex-adapter can now run every
command, including `pd --help`. (PRI-1061)
