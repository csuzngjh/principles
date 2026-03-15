/**
 * Context Injection Hook
 * @package openclaw-plugin
 * @description Retrieves and injects relevant principles into system prompt based on current context
 * @author Principles Framework
 * @version 1.0.0
 */

import type { PluginHookAgentContext, PluginHookToolContext } from '../openclaw-sdk.js';

/**
 * Principle-scenario mapping interface
 */
interface PrincipleTrigger {
  /** Principle code (e.g., T-01) */
  principle: string;

  /** Trigger scenarios */
  scenario: string[];
}

/**
 * Retrieved principle with full metadata
 */
interface RetrievedPrinciple {
  /** Principle code */
  code: string;

  /** Principle name */
  name: string;

  /** Applicable scenario description */
  scenarioDescription: string[];
}

/**
 * Tool name to principle code mapping
 * Maps common tool names to their relevant principle scenarios
 */
const TOOL_TO_PRINCIPLES: Record<string, string[]> = {
  // File editing tools
  'edit': ['T-01', 'P-03'],
  'write': ['T-01', 'P-03'],
  'create': ['T-01'],
  'delete': ['T-01', 'T-03'],
  'rename': ['T-01'],
  'move': ['T-01'],

  // Command execution tools
  'bash': ['T-05', 'P-04'],
  'exec': ['T-05', 'P-04'],
  'run': ['T-05', 'P-04'],
  'command': ['T-05', 'P-04'],
  'shell': ['T-05', 'P-04'],

  // Subagent tools
  'pd_spawn_agent': ['T-09', 'P-10'],
  'spawn_agent': ['T-09', 'P-10'],
  'subagent': ['T-09', 'P-10'],

  // Search and read tools
  'read': ['T-01', 'T-04'],
  'search': ['T-04'],
  'grep': ['T-04'],
  'find': ['T-04'],

  // Test tools
  'test': ['T-05', 'P-04'],
  'pytest': ['T-05'],
  'jest': ['T-05'],
  'vitest': ['T-05'],

  // Build tools
  'build': ['T-05', 'P-04'],
  'compile': ['T-05'],
  'bundle': ['T-05'],

  // Git tools
  'git': ['T-01', 'T-03'],
  'commit': ['T-01'],
  'push': ['T-01'],
  'pull': ['T-01'],
  'merge': ['T-03'],

  // Package management
  'npm': ['T-05'],
  'yarn': ['T-05'],
  'pnpm': ['T-05'],
  'pip': ['T-05'],
  'install': ['T-05'],

  // Network tools
  'fetch': ['T-05', 'P-04'],
  'curl': ['T-05'],
  'wget': ['T-05'],
  'http': ['T-05'],

  // Database tools
  'query': ['T-03', 'T-05'],
  'database': ['T-03'],
  'sql': ['T-03'],
  'mongo': ['T-03'],

  // Container tools
  'docker': ['T-05', 'T-09'],
  'container': ['T-05'],
  'kubernetes': ['T-09'],
  'k8s': ['T-09'],

  // Configuration tools
  'config': ['T-01', 'T-03'],
  'env': ['T-01'],
  'secret': ['T-03'],

  // Deployment tools
  'deploy': ['T-03', 'T-05'],
  'release': ['T-03'],
  'publish': ['T-03'],

  // Monitoring tools
  'log': ['T-05'],
  'monitor': ['T-05'],
  'trace': ['T-05'],
  'debug': ['T-04', 'T-05']
};

/**
 * Principle mapping database
 * Maps principle codes to their trigger scenarios
 */
const PRINCIPLE_MAPPING: PrincipleTrigger[] = [
  // T-01: Map Before Territory
  {
    principle: 'T-01',
    scenario: ['editing code files', 'creating new files or modules', 'deleting or renaming core files', 'modifying configuration files']
  },

  // T-02: Divide and Conquer
  {
    principle: 'T-02',
    scenario: ['receiving complex task instructions', 'creating long-term plans', 'breaking down large goals into milestones', 'executing multi-step tasks']
  },

  // T-03: Negative Over Positive
  {
    principle: 'T-03',
    scenario: ['important decisions', 'architecture design', 'technology selection', 'modifying system architecture', 'deleting core files']
  },

  // T-04: Occam's Razor
  {
    principle: 'T-04',
    scenario: ['implementing new features', 'troubleshooting problems', 'optimizing existing implementations']
  },

  // T-05: Pain is Signal
  {
    principle: 'T-05',
    scenario: ['tool call failures', 'test failures', 'API call failures', 'timeout errors', 'task execution failures']
  },

  // T-06: Verify Before Trust
  {
    principle: 'T-06',
    scenario: ['receiving external data', 'parsing user input', 'processing API responses', 'validating configuration']
  },

  // T-07: Document as You Go
  {
    principle: 'T-07',
    scenario: ['creating new modules', 'modifying complex logic', 'adding public APIs', 'refactoring code']
  },

  // T-09: Divide and Conquer (parallel tasks)
  {
    principle: 'T-09',
    scenario: ['executing long-running tasks', 'handling multiple parallel tasks', 'phased implementation']
  }
];

/**
 * Principle name lookup table
 */
const PRINCIPLE_NAMES: Record<string, string> = {
  'T-01': 'Map Before Territory',
  'T-02': 'Divide and Conquer',
  'T-03': 'Negative Over Positive',
  'T-04': "Occam's Razor",
  'T-05': 'Pain is Signal',
  'T-06': 'Verify Before Trust',
  'T-07': 'Document as You Go',
  'T-09': 'Divide and Conquer'
};

/**
 * Extract tool name from context
 */
function getToolName(ctx: PluginHookAgentContext | PluginHookToolContext): string | null {
  // Check if context has toolName (PluginHookToolContext)
  if ('toolName' in ctx && typeof ctx.toolName === 'string') {
    return ctx.toolName;
  }
  return null;
}

/**
 * Retrieve relevant principles based on current context
 */
export function retrieveRelevantPrinciples(
  ctx: PluginHookAgentContext | PluginHookToolContext
): RetrievedPrinciple[] {
  const toolName = getToolName(ctx);
  const principleCodes = new Set<string>();

  // If we have a tool name, look up principles from tool mapping
  if (toolName) {
    const toolNameLower = toolName.toLowerCase();

    // Direct tool name match
    if (TOOL_TO_PRINCIPLES[toolNameLower]) {
      TOOL_TO_PRINCIPLES[toolNameLower].forEach(code => principleCodes.add(code));
    }

    // Partial match for tool names containing known patterns
    for (const [pattern, codes] of Object.entries(TOOL_TO_PRINCIPLES)) {
      if (toolNameLower.includes(pattern)) {
        codes.forEach(code => principleCodes.add(code));
      }
    }
  }

  // Convert unique principle codes to full principle objects
  const result: RetrievedPrinciple[] = [];
  principleCodes.forEach(code => {
    const mapping = PRINCIPLE_MAPPING.find(m => m.principle === code);
    if (mapping) {
      result.push({
        code: mapping.principle,
        name: PRINCIPLE_NAMES[mapping.principle] || 'Unknown Principle',
        scenarioDescription: mapping.scenario
      });
    } else if (PRINCIPLE_NAMES[code]) {
      // Handle P-xx principles that may not have scenario mappings yet
      result.push({
        code,
        name: PRINCIPLE_NAMES[code] || 'Unknown Principle',
        scenarioDescription: []
      });
    }
  });

  return result;
}

/**
 * Generate principle reminder message for injection
 */
export function generatePrincipleContext(principles: RetrievedPrinciple[]): string {
  if (principles.length === 0) {
    return '';
  }

  const sections = principles.map(p => {
    const scenarios = p.scenarioDescription.map(s => `      - ${s}`).join('\n');
    return `    <principle id="${p.code}" name="${p.name}">\n      Applicable scenarios:\n${scenarios}\n    </principle>`;
  });

  return `\n<active_principles>\n${sections.join('\n')}\n</active_principles>\n`;
}

/**
 * Context injection handler for before_prompt_build hook
 *
 * This function retrieves relevant principles based on the current context
 * and returns them to be prepended to the system prompt.
 */
export function handleContextInjection(
  ctx: (PluginHookAgentContext | PluginHookToolContext) & { api?: any }
): string {
  try {
    // Retrieve relevant principles based on context
    const relevantPrinciples = retrieveRelevantPrinciples(ctx);

    // Log principle usage for observability
    if (relevantPrinciples.length > 0 && ctx.api?.logger) {
      relevantPrinciples.forEach(p => {
        ctx.api.logger.info(`[context-injection] Activated principle ${p.code}: ${p.name}`);
      });
    }

    // Generate context string for injection
    return generatePrincipleContext(relevantPrinciples);
  } catch (error) {
    if (ctx.api?.logger) {
      ctx.api.logger.error(`[context-injection] Error: ${String(error)}`);
    }
    return '';
  }
}
