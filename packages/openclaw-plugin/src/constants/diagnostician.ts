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
- Read logs: .state/logs/events.jsonl, SYSTEM.log
- Search code for error patterns from Reason field
- Record evidence sources

**Phase 2 - Causal Chain**:
- Each Why must have evidence support
- Maximum 5 layers
- Stop when reaching actionable root cause

**Phase 3 - Root Cause Classification**:
Classify into one of:
- **People**: Human error, missing knowledge, communication gap
- **Design**: Architecture flaw, missing validation, poor abstraction
- **Assumption**: Invalid assumption, outdated context, edge case
- **Tooling**: Tool limitation, environment issue, dependency problem

**Phase 4 - Principle Extraction**:
Extract protection principle with:
- **trigger_pattern**: When this situation occurs
- **action**: What to do differently

**Output Format**:
\`\`\`json
{
  "diagnosis_report": {
    "task_id": "pain-xxx",
    "summary": "One-line root cause",
    "causal_chain": [
      { "why": 1, "answer": "...", "evidence": "..." }
    ],
    "root_cause": {
      "category": "Design|People|Assumption|Tooling",
      "description": "..."
    },
    "principle": {
      "trigger_pattern": "...",
      "action": "..."
    }
  }
}
\`\`\`
`;
