# Entry Format

Use this narrative shape for Linear comments and for the Markdown body of a
pattern/occurrence record (`--body-file` of `npm run error:record`):

```markdown
**[ERR-XXX]** | <one-line summary>

- **What happened**: <what the AI assistant did wrong>
- **Why it's wrong**: <violated constraint, unread doc, or root cause>
- **Correct approach**: <what should have been done instead>
- **How to prevent**: <concrete check or rule>
- **Source**: <Linear issue ID, e.g., PRI-147>
- **Date**: <YYYY-MM-DD>
- **Recurrence**: <if same pattern recurred, note date and issue>
```

For an occurrence record the recurrence facts themselves are supplied as
structured CLI flags (`--invariant / --severity / --escaped / --caughtBy /
--guard`) — do not duplicate them in prose beyond the one-sentence narrative.
