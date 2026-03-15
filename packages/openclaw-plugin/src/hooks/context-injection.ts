/**
 * Context Injection Hook
 * @package openclaw-plugin
 * @description Retrieves and injects relevant principles into system prompt based on current context
 * @author Principles Framework
 * @version 1.0.0
 */

import type { PluginHookAgentContext } from '../openclaw-sdk.js';

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

  // T-08: Pain is Signal (duplicate in original, keeping for compatibility)
  {
    principle: 'T-08',
    scenario: ['tool call failures', 'test failures', 'API call failures', 'timeout errors', 'task execution failures']
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
  'T-08': 'Pain is Signal',
  'T-09': 'Divide and Conquer'
};

/**
 * Identify the current operation type from context
 */
function identifyOperation(ctx: PluginHookAgentContext & { api?: any }): string {
  const trigger = ctx.trigger || 'unknown';
  
  if (trigger === 'user') {
    return 'user_request';
  } else if (trigger === 'heartbeat') {
    return 'heartbeat_check';
  } else if (trigger === 'subagent') {
    return 'subagent_task';
  }
  
  return 'unknown';
}

/**
 * Retrieve relevant principles based on current context
 */
export async function retrieveRelevantPrinciples(
  ctx: PluginHookAgentContext & { api?: any }
): Promise<RetrievedPrinciple[]> {
  const operationType = identifyOperation(ctx);

  // Filter matching scenarios based on operation type
  const relevantPrinciples = PRINCIPLE_MAPPING.filter(mapping => {
    // Match based on operation type keywords
    return mapping.scenario.some(scenario => {
      const scenarioLower = scenario.toLowerCase();
      const opLower = operationType.toLowerCase();
      
      // Direct keyword matching
      if (opLower.includes('user') && scenarioLower.includes('task')) {
        return true;
      }
      if (opLower.includes('heartbeat') && scenarioLower.includes('check')) {
        return true;
      }
      if (opLower.includes('subagent') && scenarioLower.includes('parallel')) {
        return true;
      }
      
      return false;
    });
  });

  // Map to full principle objects
  return relevantPrinciples.map(mapping => ({
    code: mapping.principle,
    name: PRINCIPLE_NAMES[mapping.principle] || 'Unknown Principle',
    scenarioDescription: mapping.scenario
  }));
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
export async function handleContextInjection(
  ctx: PluginHookAgentContext & { api?: any }
): Promise<string> {
  try {
    // Retrieve relevant principles based on context
    const relevantPrinciples = await retrieveRelevantPrinciples(ctx);
    
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
