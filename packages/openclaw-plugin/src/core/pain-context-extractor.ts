/**
 * Pain Context Extractor
 *
 * Extracts conversation context from OpenClaw JSONL session files
 * to provide rich diagnostic context for the pd-diagnostician skill.
 *
 * OpenClaw stores sessions as JSONL files at:
 *   ~/.openclaw/agents/{agent_id}/sessions/{session_id}.jsonl
 *
 * Each line is a JSON object with types: session, model_change, message
 * Message roles: user, assistant, toolResult
 *
 * This module extracts:
 * - Recent conversation (last N turns, user + assistant text only)
 * - Failed tool call context (tool name, arguments, error output)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// =========================================================================
// Types
// =========================================================================

interface JsonlMessage {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: {
    role: 'user' | 'assistant' | 'toolResult';
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      toolCallId?: string;
    }>;
    toolCallId?: string;
    toolName?: string;
    details?: {
      exitCode?: number;
      durationMs?: number;
      isError?: boolean;
      aggregated?: string;
    };
  };
}

interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  toolName?: string;
  isError?: boolean;
}

// =========================================================================
// Constants
// =========================================================================

const MAX_TURNS_DEFAULT = 5;
const MAX_MESSAGE_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 2000;

/**
 * Resolves the agents directory. Can be overridden via environment variable for testing.
 */
function getAgentsDir(): string {
  const envOverride = process.env.PD_TEST_AGENTS_DIR;
  if (envOverride) return envOverride;
  return path.join(os.homedir(), '.openclaw', 'agents');
}

// =========================================================================
// JSONL Parsing
// =========================================================================

/**
 * Parses a JSONL session file into an array of message objects.
 * Skips non-message lines (session, model_change, etc.)
 */
export async function parseJsonlMessages(filePath: string): Promise<JsonlMessage[]> {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = await fs.promises.readFile(filePath, 'utf8');
  const messages: JsonlMessage[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as JsonlMessage;
      if (parsed.type === 'message' && parsed.message) {
        messages.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

// =========================================================================
// Conversation Extraction
// =========================================================================

/**
 * Extracts recent conversation turns from a JSONL session file.
 *
 * @param sessionId - OpenClaw session ID
 * @param agentId - Agent ID (e.g., 'main', 'builder')
 * @param maxTurns - Maximum number of turns to extract (default: 5)
 * @returns Formatted conversation string, or empty string if extraction fails
 */
export async function extractRecentConversation(
  sessionId: string,
  agentId: string = 'main',
  maxTurns: number = MAX_TURNS_DEFAULT,
): Promise<string> {
  if (!sessionId) return '';

  const jsonlPath = path.join(getAgentsDir(), agentId, 'sessions', `${sessionId}.jsonl`);
  const messages = await parseJsonlMessages(jsonlPath);

  if (messages.length === 0) return '';

  // Convert messages to conversation turns
  const turns: ConversationTurn[] = [];

  for (const msg of messages) {
    const role = msg.message?.role;
    if (!role || !msg.message?.content) continue;

    if (role === 'user') {
      const text = extractTextContent(msg.message.content);
      if (text) {
        turns.push({
          role: 'user',
          content: truncate(text, MAX_MESSAGE_LENGTH),
        });
      }
    } else if (role === 'assistant') {
      // Only extract text content, skip thinking and toolCall
      const textContent = extractTextContent(msg.message.content);
      if (textContent) {
        turns.push({
          role: 'assistant',
          content: truncate(textContent, MAX_MESSAGE_LENGTH),
        });
      }
    } else if (role === 'toolResult') {
      // Only include error results
      if (msg.message.details?.isError || (msg.message.details?.exitCode !== undefined && msg.message.details.exitCode !== 0)) {
        const errorText = extractTextContent(msg.message.content);
        if (errorText) {
          turns.push({
            role: 'error',
            content: truncate(errorText, MAX_MESSAGE_LENGTH),
            toolName: msg.message.toolName,
            isError: true,
          });
        }
      }
    }
  }

  // Take the last N turns
  const recentTurns = turns.slice(-maxTurns);

  if (recentTurns.length === 0) return '';

  // Format as readable conversation
  return formatConversation(recentTurns);
}

// =========================================================================
// Failed Tool Context Extraction
// =========================================================================

/**
 * Extracts context around a failed tool call from a JSONL session file.
 * Correlates tool calls with their results using toolCallId.
 *
 * @param sessionId - OpenClaw session ID
 * @param agentId - Agent ID
 * @param toolName - Name of the failed tool (e.g., 'write', 'bash')
 * @param filePath - File path involved in the failure (optional)
 * @returns Formatted tool call context string, or empty string if not found
 */
export async function extractFailedToolContext(
  sessionId: string,
  agentId: string = 'main',
  toolName: string,
  filePath?: string,
): Promise<string> {
  if (!sessionId || !toolName) return '';

  const jsonlPath = path.join(getAgentsDir(), agentId, 'sessions', `${sessionId}.jsonl`);
  const messages = await parseJsonlMessages(jsonlPath);

  if (messages.length === 0) return '';

  // Build a map of tool calls by toolCallId for correlation
  const toolCallsById = new Map<string, JsonlMessage>();
  let lastAssistantMsg: JsonlMessage | null = null;

  for (const msg of messages) {
    if (msg.message?.role === 'assistant') {
      lastAssistantMsg = msg;
      for (const content of msg.message.content) {
        if (content.type === 'toolCall' && content.id) {
          toolCallsById.set(content.id, msg);
        }
      }
    }
  }

  // Find the failed tool result by toolCallId
  let failedToolCall: JsonlMessage | null = null;
  let failedResult: JsonlMessage | null = null;

  for (const msg of messages) {
    if (msg.message?.role === 'toolResult' && msg.message.toolName === toolName) {
      if (msg.message.details?.isError || (msg.message.details?.exitCode !== undefined && msg.message.details.exitCode !== 0)) {
        // Check toolCallId correlation
        const toolCallId = msg.message.toolCallId;
        if (toolCallId && toolCallsById.has(toolCallId)) {
          const callMsg = toolCallsById.get(toolCallId);
          // If filePath is provided, verify it matches the tool call arguments
          if (filePath) {
            const callContent = callMsg?.message?.content?.filter(c => c.type === 'toolCall' && c.name === toolName) || [];
            const hasFileMatch = callContent.some(tc => {
              const args = tc.arguments || {};
              return Object.values(args).some(v => typeof v === 'string' && v.includes(filePath));
            });
            if (hasFileMatch) {
              failedToolCall = callMsg;
            }
          } else {
            failedToolCall = callMsg;
          }
        }
        failedResult = msg;
      }
    }
  }

  // Fallback: if no correlated tool call found, find last matching tool call
  if (!failedToolCall && failedResult) {
    for (const msg of messages) {
      if (msg.message?.role === 'assistant') {
        for (const content of msg.message.content) {
          if (content.type === 'toolCall' && content.name === toolName) {
            failedToolCall = msg;
          }
        }
      }
    }
  }

  if (!failedToolCall && !failedResult) return '';

  // Format the failed tool context
  const parts: string[] = [];

  if (failedToolCall?.message) {
    const toolCallContent = failedToolCall.message.content
      .filter(c => c.type === 'toolCall' && c.name === toolName);

    for (const tc of toolCallContent) {
      parts.push(`[Tool Call: ${tc.name}]`);
      if (tc.arguments) {
        parts.push(`Arguments: ${JSON.stringify(tc.arguments, null, 2)}`);
      }
    }
  }

  if (failedResult?.message) {
    parts.push(`\n[Tool Result: ${failedResult.message.toolName || 'unknown'}]`);
    if (failedResult.message.details) {
      parts.push(`Exit Code: ${failedResult.message.details.exitCode ?? 'N/A'}`);
      parts.push(`Duration: ${failedResult.message.details.durationMs ?? 'N/A'}ms`);
    }
    const errorText = failedResult.message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
    if (errorText) {
      parts.push(`Error Output:\n${truncate(errorText, 1000)}`);
    }
  }

  return parts.join('\n');
}

// =========================================================================
// Formatting
// =========================================================================

function formatConversation(turns: ConversationTurn[]): string {
  const parts: string[] = [];

  for (const turn of turns) {
    if (turn.role === 'user') {
      parts.push(`[User]: ${turn.content}`);
    } else if (turn.role === 'assistant') {
      parts.push(`[Assistant]: ${turn.content}`);
    } else if (turn.role === 'error') {
      const toolLabel = turn.toolName ? `[Tool: ${turn.toolName}]` : '[Tool Error]';
      parts.push(`${toolLabel} (FAILED): ${turn.content}`);
    }
  }

  const result = parts.join('\n\n');
  return truncate(result, MAX_OUTPUT_LENGTH);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function extractTextContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text!)
    .join('\n')
    .trim();
}
