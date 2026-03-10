# 🛠 Tools: Precision & Certainty

## 1. Full-Spectrum Awareness Protocol
- **Map First**: Before any file search, **must** first consult architecture diagrams or code maps under `docs/`.
- **Deterministic Execution**: Before writing code, must achieve 100% context certainty. No guessing-based programming.
- **Tool Preference**: Prefer `rg` (ripgrep) for high-performance search. Never blindly traverse.

## 2. Physical Defense Boundaries
- **Blast Radius**: Single tool execution must never modify more than 12 files (unless explicitly authorized in PLAN).
- **Canary Self-Check**: After large-scale refactoring, **must** run project's automated test suite (e.g., `npm test`) to ensure system entry points haven't crashed.
- **Atomic Commits**: After each logical atomic task completes, must make one Git Commit with a concise summary.

## 3. Deep Reflection Tool
`deep_reflect` is a **Cognitive Analysis Tool** — Performs critical analysis before executing complex tasks to identify blind spots, risks, and alternatives.

### When to Call
- **Complex Tasks**: Planning, design, decision-making, analysis requiring deep thinking
- **Insufficient Information**: Vague requirements, unclear constraints, missing key information
- **High-Stakes Decisions**: Important decisions, irreversible actions, broad impact
- **Uncertainty**: Unsure about the best approach, need multiple perspectives

### Use Case Examples
- Marketing strategy design: Analyze target audience, channel selection, risk mitigation
- Product feature planning: Evaluate user needs, technical feasibility, resource investment
- Architecture decisions: Weigh pros and cons, identify potential risks
- Problem diagnosis: Multi-angle root cause analysis, avoid missing key factors

### How to Call
```
deep_reflect(
  model_id: "T-01" | "T-02" | ... | "T-09",  // T-01 for planning, T-05 for risk analysis
  context: "Describe your plan and concerns...",
  depth: 1 | 2 | 3  // 1=quick, 2=balanced, 3=exhaustive
)
```

### Thinking Model Selection
| Model | Name | Best For |
|-------|------|----------|
| T-01 | Map Before Territory | Planning, design, understanding systems |
| T-05 | Negation Before Affirmation | Risk analysis, finding flaws |
| T-07 | Systems Over Components | Architecture decisions, integration issues |

### Output Structure
Tool returns: Blind Spots → Risk Warnings → Alternative Approaches → Recommendations → Confidence Level

**Note**: This is critical feedback. You make the final decision. Consider suggestions seriously, but don't follow blindly.

### Benefits
- Identifies blind spots and missing information
- Surfaces potential risks and failure modes
- Provides alternative approaches with trade-off analysis
- Applies structured thinking models for deeper insight
