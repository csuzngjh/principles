---
name: deductive-audit
description: Rigorous safety and logic check of a proposed solution. Evaluates against axioms, system impact, and edge cases.
disable-model-invocation: true
---

# Deductive Audit

**Goal**: Intercept logic errors and potential risks before execution.

Please conduct a three-phase review of the proposed fix:

## 1. Axiom Test
- Are language specifications, library API contracts, or project conventions violated?
- Are input/output types aligned?

## 2. System Test
- Does it introduce new technical debt?
- Does it affect performance, latency, or stability?
- Does it introduce circular dependencies?

## 3. Entropy Audit - *New*
- **Necessity**: Is this modification absolutely necessary? Is there a simpler solution?
- **Minimization**: Does it touch files it shouldn't? (Principle of minimal surface area)
- **Anti-gaming**: Is this a genuine fix, or "formalism" just to pass the gate?

## 4. Via Negativa
- What happens in the worst case (network down, disk full, malicious input)?
- Are there security red line risks (token leak, privilege escalation)?

## 5. Verdict
- **RESULT**: PASS | FAIL
- **Must Fix**: If failed, list points that must be corrected.

---
**Action**: Update the above results to `docs/AUDIT.md`.
