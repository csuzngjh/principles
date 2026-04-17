---
phase: "00a"
plan: "03"
type: execute
wave: 2
depends_on: ["00a-01"]
files_modified: [
  "packages/openclaw-plugin/src/core/nocturnal-trinity.ts",
  "packages/openclaw-plugin/src/core/principle-injection.ts",
  "packages/openclaw-plugin/src/hooks/prompt.ts"
]
autonomous: true
requirements: ["SDK-QUAL-02", "SDK-QUAL-04"]
must_haves:
  truths:
    - "nocturnal-trinity.ts validates extracted principles against session trajectory to detect hallucinations"
    - "prompt.ts uses a managed budget for principle injection to prevent context overflow"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/principle-injection.ts"
      provides: "Budget-aware principle selection logic"
---

<objective>
Improve the quality and reliability of principle extraction and application.
- Implement hallucination detection in the Nocturnal Trinity pipeline by cross-referencing extracted principles with session evidence.
- Implement a budget-aware principle injection mechanism to protect the context window while ensuring the most relevant principles are always present.
</objective>

<execution_context>
@$HOME/.gemini/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/REQUIREMENTS.md
@.planning/phases/00a-interface-core/00a-DISCOVERY.md
@packages/openclaw-plugin/src/core/nocturnal-trinity.ts
@packages/openclaw-plugin/src/hooks/prompt.ts
</context>

<tasks>

<task type="auto">
  <name>Implement Hallucination Detection</name>
  <files>packages/openclaw-plugin/src/core/nocturnal-trinity.ts</files>
  <action>
    Modify `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`.
    Add a `validateExtraction` function (or similar) called after the Scribe stage:
    - Verify that the `badDecision` extracted by the LLM corresponds to actual events in the `NocturnalSessionSnapshot` (e.g., failed tool calls, pain events).
    - If no evidence is found for the extracted principle's premise, mark the extraction as "hallucinated" and fail the chain.
    - Log detection details to the Trinity telemetry.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts</automated>
  </verify>
  <done>Hallucination detection implemented in Trinity pipeline.</done>
</task>

<task type="auto">
  <name>Implement Principle Overflow Protection</name>
  <files>
    packages/openclaw-plugin/src/core/principle-injection.ts,
    packages/openclaw-plugin/src/hooks/prompt.ts
  </files>
  <action>
    Create `packages/openclaw-plugin/src/core/principle-injection.ts`.
    Implement `selectPrinciplesForInjection(principles: Principle[], budgetChars: number): Principle[]`:
    - Sort principles by priority (P0 > P1 > P2) and recency.
    - Select principles one by one until the `budgetChars` limit is reached.
    - Ensure at least one P0 principle is included if any exist.
    Update `packages/openclaw-plugin/src/hooks/prompt.ts`:
    - Use `selectPrinciplesForInjection` with a defined budget (e.g., 4000 chars) instead of the hardcoded `slice(-3)` and `slice(0, 5)`.
  </action>
  <verify>
    <automated>npm run test -- packages/openclaw-plugin/tests/core/principle-injection.test.ts</automated>
  </verify>
  <done>Principle overflow protection implemented.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries
| Boundary | Description |
|----------|-------------|
| LLM Output | Model-generated principles may be hallucinated |

## STRIDE Threat Register
| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-00a-03-01 | Tampering | Trinity Pipeline | mitigate | Cross-reference LLM output with trajectory ground truth (NocturnalSessionSnapshot) |
</threat_model>

<success_criteria>
- [ ] Hallucination detection flags synthetic principles.
- [ ] Prompt size remains within safe bounds even with many active principles.
</success_criteria>

<output>
After completion, create `.planning/phases/00a-interface-core/00a-03-SUMMARY.md`
</output>
