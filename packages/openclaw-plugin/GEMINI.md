## Gemini Host Integration Layer Instructions

**CRITICAL ARCHITECTURE GUARDRAIL:**
You are currently operating in the `openclaw-plugin` package. This is the **Host Integration Layer**.

1. **No Domain Logic**: You are **ABSOLUTELY PROHIBITED** from writing complex business rules, diagnosis algorithms, or principle evaluation logic in this package. 
2. **Role of Hooks**: Your hooks (e.g., `before_tool_call`, `pain_detected`) must be simple and dumb. Their only job is to capture the external event, format the context, and delegate the actual processing to the Runners and Adapters exposed by `@principles/core`.
3. **Do Not Redefine Schemas**: Do not invent new TypeScript interfaces for Core Domain Entities here. All Types and Schemas (like Principle, Rule, Task) belong in the Core layer and must be imported from `@principles/core`.

> Your primary goal here is to be a clean, thin, and stateless bridge between OpenClaw and the Principles Core.