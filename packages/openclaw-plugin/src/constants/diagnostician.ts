/**
 * Diagnostician 协议常量
 *
 * 用于 evolution-worker.ts（后台心跳）和 prompt.ts（实时路径）
 * 与 templates/langs/zh/skills/pd-diagnostician/SKILL.md 保持一致
 */

/**
 * 诊断协议摘要（用于 HEARTBEAT.md 注入）
 *
 * 完整版见: templates/langs/zh/skills/pd-diagnostician/SKILL.md
 */
export const DIAGNOSTICIAN_PROTOCOL_SUMMARY = `## Diagnostic Protocol (5 Whys)

**Phase 1 - Evidence Gathering**:
- Read .state/.pain_flag for full pain context
- Read .state/logs/events.jsonl recent entries
- Search codebase for error patterns from Reason field
- Record all evidence sources (file:line)

**Phase 2 - Causal Chain (5 Whys)**:
- Why 1: Surface symptom (what you can see)
- Why 2: Direct cause (what triggered it)
- Why 3: Process gap (what should have caught it)
- Why 4: Design flaw (why the gap exists)
- Why 5: Root cause (systemic issue to fix)
- Each Why MUST have evidence. Stop at actionable root cause.

**Phase 3 - Root Cause Classification**:
Classify into one of:
- **People**: Human error, missing knowledge, communication gap
- **Design**: Architecture flaw, missing validation, poor abstraction
- **Assumption**: Invalid assumption, outdated context, edge case
- **Tooling**: Tool limitation, environment issue, dependency problem
- For Design: analyze why existing hooks/rules didn't catch this

**Phase 4 - Principle Extraction**:
Extract a HIGHLY ABSTRACTED principle (not an operational rule):
- **trigger_pattern**: regex/keywords for when this occurs
- **action**: what to do differently
- **abstracted_principle**: ONE sentence, max 40 chars, cross-scenario applicable
  - ❌ Bad: "写入前检查目录是否存在" (too specific)
  - ✅ Good: "任何写入操作必须确保目标环境的完整性" (abstract, reusable)

**Output Format** (single JSON object):
\`\`\`json
{
  "diagnosis_report": {
    "task_id": "pain-xxx",
    "summary": "One-line root cause",
    "causal_chain": [
      { "why": 1, "answer": "...", "evidence": "file:line" }
    ],
    "root_cause": {
      "category": "Design|People|Assumption|Tooling",
      "description": "..."
    },
    "principle": {
      "trigger_pattern": "...",
      "action": "...",
      "abstracted_principle": "高度抽象的一句话原则"
    }
  }
}
\`\`\`
`;
