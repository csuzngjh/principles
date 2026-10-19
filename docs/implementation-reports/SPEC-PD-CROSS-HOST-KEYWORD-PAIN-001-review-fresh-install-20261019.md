# SPEC-PD-CROSS-HOST-KEYWORD-PAIN-001 — Code review & new-install defaults (2026-10-19)

**Status: follow-up review implementation; NOT production sign-off.**

## Review findings

| Severity | Finding | Resolution |
| --- | --- | --- |
| P1 fixed | On a fresh WorkBuddy install, the auto keyword feature remained ineffective even if its quiet feature flag were defaulted ON, because the host.workbuddy gate was OFF. | Fresh installer now writes BOTH host.workbuddy.enabled=true and workbuddy_live_keyword_pain.enabled=true to the NEW governance config in ONE atomic replace. Registry defaults stay OFF for existing sparse workspaces. |
| P1 fixed | Globally changing the feature registry's enabled default would silently activate existing users with features: {} on upgrade. | Registry defaults remain OFF. Installer distinguishes fresh (no prior plugin registration AND no prior governance config) from existing/reinstall; existing explicit false stays false and config bytes are preserved. |
| P1 guarded | New-feature hook must avoid transcript reads / Stage2 LLM; must not mutate full host transcript permissions. | WorkBuddy checks current native UserPromptSubmit only; no new transcript reads or Stage2 LLM. Codex transcript consent gate unchanged. |
| P1 open | WorkBuddy sourceRef=pain_event:<canonicalPainId> points to a canonical Pain row, but a standalone consumer resolver and actual Diagnostician evidence-use E2E remain unverified. | Leave LIVE gate blocked; add consumer evidence-resolver E2E before merge. |
| P1 open | Some WorkBuddy CLI first startup prompts may not emit UserPromptSubmit, and real-installed host delivery is unverified. | Live host probe required; flag ON does not guarantee a missing native hook. |
| P1 open | Complete WorkBuddy hook + SQLite + task p95/p99/lock-contention metrics have not been collected. | SPEC §6 latency gate remains open; scanner-only numbers are not sufficient. |
| scope | Codex live-only P1 does not exist yet; existing Codex automatic correction requires explicit codex_conversation_ingestion consent. | Not default-on for Codex; do NOT enable full transcript ingestion as a shortcut. Requires separate P1 build. |

## New install semantics

- Only WorkBuddy's dedicated official installer changes fresh-install effective defaults; it writes both flags explicitly, rather than modifying central registry defaults.
- Existing governance config present: no changes to any flag even if plugin was never registered.
- Existing plugin already registered: no implicit enable even if governance config was deleted/recreated.
- Reinstall/upgrade after user disables either flag: keep exact configuration.
- No user production workspace or existing installation was modified during this review.

## Tests

- WorkBuddy installer isolated filesystem test suite: 39/39 passed (includes first-install ON + preexisting-config OFF preservation).
- WorkBuddy installer → real wrapper → hook governance chain: 2/2 passed.
- Previous PR P0 regression: 178/178 passed (not rerun all in this follow-up).
- TypeScript: installer package local compilation currently reports an unrelated pre-existing HostRuntimeProfileInput.baseUrl type mismatch in an unmodified source region; final CI on the updated PR is authoritative.
- Remaining: installed-host LIVE E2E, full performance gate, evidence source consumer verification, Codex P1.

**Do not mark SPEC complete or merge-ready solely on these tests.**
