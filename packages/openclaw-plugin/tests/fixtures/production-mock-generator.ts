/**
 * Production Mock Data Generator
 * 
 * Extracts patterns from production data to create realistic test fixtures.
 * This ensures tests match real-world scenarios and catches edge cases.
 */

import * as fs from 'fs';
import * as path from 'path';

// Production data paths
const OPENCLAW_HOME = process.env.HOME + '/.openclaw';
const WORKSPACE_MAIN = OPENCLAW_HOME + '/workspace-main';
const STATE_DIR = WORKSPACE_MAIN + '/.state';

// Types extracted from production
export interface ProductionPainFlag {
  is_risky: string;
  reason: string;
  score: string;
  source: string;
  time: string;
  status?: string;
  task_id?: string;
  session_id?: string;  // New field
  agent_id?: string;    // New field
  trace_id?: string;    // From recent changes
}

export interface ProductionEvolutionQueueItem {
  id: string;
  score: number;
  source: string;
  reason: string;
  trigger_text_preview: string;
  timestamp: string;
  enqueued_at: string;
  status: 'pending' | 'in_progress' | 'completed' | 'resolved';
  task?: string;
  started_at?: string;
  completed_at?: string;
  resolved_at?: string;
  assigned_session_key?: string;
  resolution?: string;
  session_id?: string;  // New field
  agent_id?: string;    // New field
}

export interface ProductionPainCandidate {
  count: number;
  status?: string;
  firstSeen: string;
  lastSeen?: string;
  samples: string[];
}

/**
 * Load real pain_flag from production
 */
export function loadProductionPainFlag(): ProductionPainFlag | null {
  const painFlagPath = path.join(STATE_DIR, '.pain_flag');
  if (!fs.existsSync(painFlagPath)) return null;

  const content = fs.readFileSync(painFlagPath, 'utf8');
  const result: ProductionPainFlag = {} as ProductionPainFlag;

  for (const line of content.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      (result as any)[match[1]] = match[2];
    }
  }

  return result;
}

/**
 * Load real evolution queue from production
 */
export function loadProductionEvolutionQueue(): ProductionEvolutionQueueItem[] {
  const queuePath = path.join(STATE_DIR, 'evolution_queue.json');
  if (!fs.existsSync(queuePath)) return [];

  try {
    return JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Load real pain candidates from production
 */
export function loadProductionPainCandidates(): Record<string, ProductionPainCandidate> {
  const candidatesPath = path.join(STATE_DIR, 'pain_candidates.json');
  if (!fs.existsSync(candidatesPath)) return {};

  try {
    const data = JSON.parse(fs.readFileSync(candidatesPath, 'utf8'));
    return data.candidates || {};
  } catch {
    return {};
  }
}

/**
 * Sample a JSONL session file for message patterns
 */
export function sampleSessionMessages(
  sessionId: string,
  agentId: string = 'main',
  limit: number = 10
): Array<{ role: string; content: string; timestamp: number }> {
  const sessionPath = path.join(OPENCLAW_HOME, 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
  if (!fs.existsSync(sessionPath)) return [];

  const messages: Array<{ role: string; content: string; timestamp: number }> = [];

  try {
    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(0, limit * 3)) { // Read more lines to get enough messages
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message;
          let content = '';
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            content = msg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
          }

          // Truncate to reasonable size
          if (content.length > 500) {
            content = content.slice(0, 500) + '...';
          }

          messages.push({
            role: msg.role,
            content,
            timestamp: entry.timestamp || Date.now(),
          });

          if (messages.length >= limit) break;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    return [];
  }

  return messages;
}

/**
 * Generate realistic test fixtures from production patterns
 */
export function generateTestFixtureFromProduction() {
  const painFlag = loadProductionPainFlag();
  const queue = loadProductionEvolutionQueue();
  const candidates = loadProductionPainCandidates();

  // Extract patterns
  const patterns = {
    // Pain sources seen in production
    painSources: [...new Set(queue.map(q => q.source))],
    
    // Common error patterns
    errorPatterns: queue.map(q => ({
      type: q.source,
      reasonPreview: q.reason.slice(0, 100),
    })),
    
    // Score distribution
    scoreDistribution: queue.reduce((acc, q) => {
      acc[q.score] = (acc[q.score] || 0) + 1;
      return acc;
    }, {} as Record<number, number>),
    
    // Status distribution
    statusDistribution: queue.reduce((acc, q) => {
      acc[q.status] = (acc[q.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  return {
    painFlag,
    queue,
    candidates,
    patterns,
  };
}

/**
 * Create a mock evolution queue item based on production patterns
 */
export function createMockQueueItem(overrides: Partial<ProductionEvolutionQueueItem> = {}): ProductionEvolutionQueueItem {
  const queue = loadProductionEvolutionQueue();
  const template = queue[0] || {
    id: 'test-001',
    score: 50,
    source: 'tool_failure',
    reason: 'Tool write failed on test.md. Error: Test error.',
    trigger_text_preview: '',
    timestamp: new Date().toISOString(),
    enqueued_at: new Date().toISOString(),
    status: 'pending',
  };

  return {
    ...template,
    ...overrides,
    id: overrides.id || `test-${Date.now().toString(36)}`,
    timestamp: overrides.timestamp || new Date().toISOString(),
    enqueued_at: overrides.enqueued_at || new Date().toISOString(),
  };
}

/**
 * Create a mock pain flag based on production patterns
 */
export function createMockPainFlag(overrides: Partial<ProductionPainFlag> = {}): ProductionPainFlag {
  const realFlag = loadProductionPainFlag();
  const template = realFlag || {
    is_risky: 'false',
    reason: 'Test pain signal',
    score: '50',
    source: 'tool_failure',
    time: new Date().toISOString(),
  };

  return {
    ...template,
    ...overrides,
    time: overrides.time || new Date().toISOString(),
  };
}

/**
 * Validate that new code handles production data correctly
 */
export function validateProductionCompatibility() {
  const issues: string[] = [];

  // Check if pain_flag has session_id/agent_id (new fields)
  const painFlag = loadProductionPainFlag();
  if (painFlag && !painFlag.session_id) {
    issues.push('pain_flag missing session_id (new field not yet in production)');
  }
  if (painFlag && !painFlag.agent_id) {
    issues.push('pain_flag missing agent_id (new field not yet in production)');
  }

  // Check if queue items have session_id/agent_id
  const queue = loadProductionEvolutionQueue();
  const missingSessionId = queue.filter(q => !q.session_id);
  if (missingSessionId.length > 0) {
    issues.push(`evolution_queue: ${missingSessionId.length}/${queue.length} items missing session_id`);
  }

  return {
    compatible: issues.length === 0,
    issues,
    productionData: {
      painFlag,
      queueCount: queue.length,
    },
  };
}

// Export for use in tests
export const PRODUCTION_FIXTURES = {
  OPENCLAW_HOME,
  WORKSPACE_MAIN,
  STATE_DIR,
};
