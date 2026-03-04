export function handleInitStrategy(_ctx) {
    return {
        text: `🎯 **Strategy Initialization**\n\n` +
            `The Agent will now conduct a deep interview to establish your project's vision and strategic OKRs.\n\n` +
            `**Instructions for Agent:** Read \`docs/okr/\` for existing context. ` +
            `Generate \`docs/okr/CURRENT_FOCUS.md\` with the top 1-3 strategic focus areas based on the user interview. ` +
            `Then update \`docs/USER_CONTEXT.md\` with key user preferences discovered.`,
    };
}
export function handleManageOkr(_ctx) {
    return {
        text: `📊 **OKR Management**\n\n` +
            `The Agent will analyze recent work and align sub-agent objectives.\n\n` +
            `**Instructions for Agent:** Read \`docs/okr/CURRENT_FOCUS.md\` and \`docs/okr/WEEK_STATE.json\`. ` +
            `Compare them against recent session history. ` +
            `Update OKRs as needed and output a brief alignment report. ` +
            `If OKRs are stale (>7 days), prompt the user for a re-alignment conversation.`,
    };
}
