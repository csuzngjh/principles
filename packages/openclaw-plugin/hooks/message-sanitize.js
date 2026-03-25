const INTERNAL_TAG_PATTERNS = [
    /\[EMOTIONAL_DAMAGE_DETECTED(?::(?:mild|moderate|severe))?\]/gi,
    /\[EMPATHY_ROLLBACK_REQUEST\]/gi,
    /<empathy\s+[^>]*\/?>(?:<\/empathy>)?/gi,
];
export function sanitizeAssistantText(text) {
    let result = text;
    for (const pattern of INTERNAL_TAG_PATTERNS) {
        result = result.replace(pattern, '');
    }
    return result
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export function handleBeforeMessageWrite(event) {
    const msg = event.message;
    if (!msg || msg.role !== 'assistant')
        return;
    if (typeof msg.content === 'string') {
        const sanitized = sanitizeAssistantText(msg.content);
        if (sanitized !== msg.content) {
            return { message: { ...msg, content: sanitized } };
        }
        return;
    }
    if (Array.isArray(msg.content)) {
        const next = msg.content.map((part) => {
            if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                return { ...part, text: sanitizeAssistantText(part.text) };
            }
            return part;
        });
        return { message: { ...msg, content: next } };
    }
    return;
}
