# Issue 98 Analysis

## Summary

Issue #98 was caused by conflicting guidance across runtime prompt injection, workspace templates, and long-lived agent memory. The runtime already treated `diagnostician` as an internal worker, but surrounding guidance still taught agents to confuse peer sessions, internal workers, and dispatched subagents.

## Findings

- `pd_run_worker` launches internal workers through the subagent runtime and uses `agent:<type>:<uuid>` session keys.
- `diagnostician` is not a peer session target.
- Prompt injection described peer-session tools and internal-worker startup, but it did not explain that `subagents` is the correct inspection path for already-dispatched internal workers.
- Core templates still contained outdated wording such as `pd_spawn_agent`, which allowed new workspaces to bootstrap stale rules.
- Existing workspaces preserved stale `AGENTS.md` and `TOOLS.md` content because template sync was copy-if-missing only.

## Fix Strategy

1. Update prompt routing rules to explicitly distinguish peer sessions, internal workers, and subagent inspection.
2. Update `pd_run_worker` misuse guidance so status-check flows point to `subagents`.
3. Replace stale core templates with a single routing model in both English and Chinese templates.
4. Warn when an existing workspace keeps outdated `AGENTS.md` or `TOOLS.md` content.
5. Add regression tests for prompt routing, misuse guidance, template content, and stale-guidance warnings.

## Expected Outcome

- Peer-agent communication should consistently use `sessions_*`.
- Internal-worker startup should consistently use `pd_run_worker`.
- Internal-worker inspection should consistently use `subagents`.
- New workspaces should bootstrap correct guidance.
- Existing workspaces should surface a warning instead of silently continuing with stale routing rules.
