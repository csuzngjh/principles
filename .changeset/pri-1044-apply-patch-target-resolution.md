---
"@principles/host-runtime": patch
"principles-disciple": patch
"create-principles-disciple": patch
---

fix(rulehost): resolve native Codex `apply_patch` targets so managed writes are actually armed

A real `codex exec` session sends the patch body under `tool_input.command`
(`{"command":"*** Begin Patch ... *** End Patch"}`), but the Codex rule-context
provider only read `params.patch` / `params.input`. Target resolution therefore
returned `undefined`, `targetPaths` stayed empty, the `design_approval` fact
degraded to `unknown`, no live candidate was produced and every managed file
write bypassed PD as `no_rules_armed` (`Bash` writes were still gated, which hid
the gap). `patchTargets` now accepts the `command` carrier as well; the three
carriers share the same `*** <op> File:` headers, so no header parsing changed.

Verified on a real Codex host with `gpt-5.6-luna`: the same payload is blocked
(`decision=block`, file not created) while the declaration is `not_approved`,
and allowed (`decision=allow`, file written) once it is `approved`.
Regression: `packages/host-runtime/tests/production-design-gate-pretool.test.ts`
("blocks a native Codex apply_patch payload whose patch body is under
tool_input.command").
