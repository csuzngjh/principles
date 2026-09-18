# PRI-815 Quality-First — Reuse Matrix (Phase 2, SPEC §H)

| Capability | Existing asset | Decision | Reason |
|---|---|---|---|
| Dreamer prompt (instruction + payload shape) | `packages/principles-core/dist/runtime-v2/internalization/dreamer-prompt-builder.js` (`DreamerPromptBuilder`) | REUSE | Byte-faithful Arm A requires the production builder; both arms share it |
| Philosopher prompt | `.../philosopher-prompt-builder.js` (`PhilosopherPromptBuilder`) | REUSE | Same — shared by both arms |
| Scribe prompt (Arm A) | `.../scribe-prompt-builder.js` (`ScribePromptBuilder`) | REUSE | Arm A must replicate current visibility exactly |
| Scribe prompt (Arm B) | harness `buildArmBPrompt` = production systemPrompt + frozen addendum; payload = production payload + 3 evidence blocks | MINIMAL_NEW | The information repair IS the experiment variable; smallest possible delta (additive fields + one addendum), no production file touched |
| Output schemas + validators | `DefaultDreamerValidator` / `DefaultPhilosopherValidator` / `DefaultScribeValidator` (dist, unmodified) | REUSE | Deterministic validation per SPEC §N — failures stay in denominator |
| contextHash | `BasePeerRunner.hashContextRefs` (dist static) | REUSE | Production-visible correlation value |
| Core grounding | injected inside production builders (`coreGrounding: true`) | REUSE | Identical CORE AXIOMS block in A and B (part of both systemPrompts) |
| Real-model runner | ZAI coding endpoint glm-5.3 (production channel on this host); `scripts/pri-815/llm.mjs` thin client | EXTEND | Spike's ab-run client pattern; same endpoint/model family as production agents |
| Fixture loader | `scripts/pri-815/freeze-inputs.mjs` (production state.db read-only → frozen-inputs.json) | MINIMAL_NEW | Input freeze (SPEC §12) must be a committed artifact; DB never opened at run time |
| Sample manifest | `scripts/pri-815/build-sample-manifest.mjs` | MINIMAL_NEW | Spike kept this outside the repo; v0.3 requires a frozen committed manifest |
| Judge | glm-5.3 (same family — bias disclosed); fixed 10-dim rubric | MINIMAL_NEW | All independent channels dead on this host (lmstudio down, deepseek 402, Bai 0-balance, sensenova 401, unorouter 503); GPT6 unavailable → NOT_RUN |
| Downstream replay | production rulehost VM requires Artificer rules (out of H1 scope) | NOT_REUSED | Downstream measured via scenario-gated behavioral judgment (documented approximation) |

No new framework: the whole harness is 6 small scripts under `scripts/pri-815/`, no production source changes.
