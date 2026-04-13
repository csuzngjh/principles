/**
 * Session key parsing utilities.
 *
 * Session key format: "agent:{agentId}:{type}:{uuid}" or "agent:{agentId}:{uuid}"
 */

/**
 * Extract agentId from a sessionKey.
 * Returns `undefined` if sessionKey is missing, malformed, or has whitespace-only agentId.
 */
export function extractAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
    if (!sessionKey) return undefined;
    const match = /^agent:([^:]+):/.exec(sessionKey);
    if (!match) return undefined;
    const agentId = match[1].trim();
    return agentId || undefined;
}
