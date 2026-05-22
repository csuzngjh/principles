# Entry Format

Use this format for Linear comments and handbook detailed entries:

```markdown
**[ERR-XXX]** | <one-line summary>

- **What happened**: <what the AI assistant did wrong>
- **Why it's wrong**: <violated constraint, unread doc, or root cause>
- **Generalized failure mode**: When <general condition>, assistants must <preventive rule>, otherwise <general risk>
- **Correct approach**: <what should have been done instead>
- **How to prevent**: <concrete check or rule that can be applied during PR review>
- **Regression guard**: <test/static check/review checklist item that catches recurrence>
- **Related ERRs**: <existing ERR IDs in the same pattern group, or "None">
- **Source**: <Linear issue ID, e.g., PRI-147>
- **Date**: <YYYY-MM-DD>
- **Recurrence**: <if same pattern recurred, note date and issue>
```

Quality requirements:

- The summary must describe the reusable failure mode, not just the file or PR.
- "How to prevent" must be actionable in under 30 seconds.
- Do not add a new ERR if an existing entry has the same prevention rule; update recurrence instead.
