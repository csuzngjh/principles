/**
 * Agent Definition Loader
 *
 * Parses agent definitions from agents/*.md files.
 * These definitions are used to construct extraSystemPrompt for subagent runs.
 */
/**
 * Parsed agent definition from markdown file
 */
export interface AgentDefinition {
    /** Agent identifier (e.g., 'explorer', 'diagnostician') */
    name: string;
    /** Human-readable description */
    description: string;
    /** The markdown body (system prompt for subagent) */
    systemPrompt: string;
    /** Tools the agent can use (informational, not enforced by OpenClaw) */
    tools?: string[];
    /** Preferred model (informational, OpenClaw subagents use parent model) */
    model?: string;
    /** Permission mode (informational) */
    permissionMode?: string;
    /** Associated skills */
    skills?: string[];
}
/**
 * Load agent definition by name
 *
 * @param name - Agent name (e.g., 'explorer', 'diagnostician')
 * @returns Agent definition or null if not found
 */
export declare function loadAgentDefinition(name: string): AgentDefinition | null;
/**
 * List all available agents
 *
 * @returns Array of agent names
 */
export declare function listAvailableAgents(): string[];
/**
 * Load all agent definitions
 *
 * @returns Map of agent name to definition
 */
export declare function loadAllAgents(): Map<string, AgentDefinition>;
