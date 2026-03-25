/**
 * Agent Definition Loader
 * 
 * Parses agent definitions from agents/*.md files.
 * These definitions are used to construct extraSystemPrompt for subagent runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname with fallback for test environments
let __dirname: string;
try {
  const __filename = fileURLToPath(import.meta.url);
  __dirname = path.dirname(__filename);
} catch {
  // Fallback for test environments where import.meta.url may not work
  __dirname = process.cwd();
}

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
 * Parse markdown file with YAML frontmatter
 */
function parseMarkdown(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const frontmatter: Record<string, unknown> = {};
  const frontmatterText = match[1];
  const body = match[2];
  
  // Simple YAML-like parsing
  let currentKey = '';
  let currentArray: string[] | null = null;
  
  frontmatterText.split('\n').forEach(line => {
    // Array item
    if (line.match(/^\s*-\s+/)) {
      if (currentArray !== null) {
        const value = line.replace(/^\s*-\s+/, '').trim();
        currentArray.push(value);
      }
      return;
    }
    
    // Key-value pair
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      
      if (value === '') {
        // Start of array
        currentKey = key;
        currentArray = [];
        frontmatter[key] = currentArray;
      } else {
        // Simple value
        currentKey = '';
        currentArray = null;
        frontmatter[key] = value;
      }
    }
  });
  
  return { frontmatter, body };
}

/**
 * Resolve the agents directory path
 * Handles both development and installed scenarios
 */
function resolveAgentsDir(): string {
  // Try multiple locations
  const possiblePaths = [
    // Development: relative to dist/core/
    path.resolve(__dirname, '../../agents'),
    // Installed: relative to extension root
    path.resolve(__dirname, '../agents'),
    // Absolute fallback
    path.resolve(process.cwd(), 'agents'),
  ];
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  
  // Return default (may not exist)
  return possiblePaths[0];
}

/**
 * Load agent definition by name
 * 
 * @param name - Agent name (e.g., 'explorer', 'diagnostician')
 * @returns Agent definition or null if not found
 */
export function loadAgentDefinition(name: string): AgentDefinition | null {
  const agentsDir = resolveAgentsDir();
  const mdPath = path.join(agentsDir, `${name}.md`);
  
  if (!fs.existsSync(mdPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(mdPath, 'utf8');
    const { frontmatter, body } = parseMarkdown(content);
    
    // Extract tools as array (support both string and array formats)
    let tools: string[] | undefined;
    if (Array.isArray(frontmatter.tools)) {
      tools = frontmatter.tools as string[];
    } else if (typeof frontmatter.tools === 'string') {
      tools = frontmatter.tools.split(',').map(s => s.trim()).filter(Boolean);
    }
    
    return {
      name: (frontmatter.name as string) || name,
      description: (frontmatter.description as string) || '',
      systemPrompt: body.trim(),
      tools,
      model: frontmatter.model as string | undefined,
      permissionMode: frontmatter.permissionMode as string | undefined,
      skills: frontmatter.skills as string[] | undefined,
    };
  } catch (err) {
    console.error(`[AgentLoader] Failed to load agent ${name}:`, err);
    return null;
  }
}

/**
 * List all available agents
 * 
 * @returns Array of agent names
 */
export function listAvailableAgents(): string[] {
  const agentsDir = resolveAgentsDir();
  
  if (!fs.existsSync(agentsDir)) {
    return [];
  }
  
  try {
    const files = fs.readdirSync(agentsDir);
    return files
      .filter(f => f.endsWith('.md'))
      .map(f => path.basename(f, '.md'));
  } catch {
    return [];
  }
}

/**
 * Load all agent definitions
 * 
 * @returns Map of agent name to definition
 */
export function loadAllAgents(): Map<string, AgentDefinition> {
  const agents = new Map<string, AgentDefinition>();
  
  for (const name of listAvailableAgents()) {
    const def = loadAgentDefinition(name);
    if (def) {
      agents.set(name, def);
    }
  }
  
  return agents;
}
