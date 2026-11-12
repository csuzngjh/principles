# Adaptive Activation: Native-gap integration

The shared packer derives Native once from the current authorized snapshot and
the host's actual budget and round key. Decisions receives only candidates whose
principle IDs are missing from that pack. A fully covered prompt sends zero
requests. The existing cutoffs, additive-only pack and final authorization
checks still apply. The question now asks whether adding the candidate would
improve the next action. Previous real scores cannot validate the revised question.

| Host | Opt-in key | Native identity prerequisite |
| --- | --- | --- |
| Codex | host.codex.adaptive_activation | UserPromptSubmit prompt and turn_id |
| WorkBuddy | host.workbuddy.adaptive_activation | UserPromptSubmit prompt and generation_id |
| OpenClaw | host.openclaw.adaptive_activation | Current admitted user message and currentUserMessageId |

All three are default-off. Use the existing workspace adaptiveActivation endpoint,
model and credential reference. The OpenClaw fixed mapping keeps precedence.
The previously audited ordinary embedded OpenClaw producer lacks the admitted
fields. That mode stays on Native until a host version carries them. No upstream
checkout or installed host is changed here.

The new manifest reuses the original inputs, candidate texts, thresholds, route
and cap. Synthetic fixtures are remapped to the actual gap references. Claims and
results use this directory; earlier batches remain untouched. Run the existing
runner with --preflight after building. Real calls remain unapproved. If needed,
sign against the final commit/tree, manifest/config/build hashes and exact route,
using the existing approval shape. This Codex card does not authorize host tests
or scoring on WorkBuddy or OpenClaw.
