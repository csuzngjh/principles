/**
 * Pain Context Extractor
 *
 * Extracts conversation context from OpenClaw session JSONL files
 * to provide diagnostic context beyond the pain reason.
 *
 * DESIGN PRINCIPLES (from real data analysis):
 * - JSONL files can be 6 lines (HEARTBEAT injection) to 632+ lines (full conversation)
 * - Large files: one line can be 11MB (system prompt) — MUST skip oversized lines
 * - Assistant text appears ONLY in final replies (~3% of assistant messages)
 * - Most assistant messages contain toolCall blocks (what operations were performed)
 * - toolResult contains tool output (success AND failure) — both are useful for diagnosis
 * - Always read from END of file to get most recent context
 *
 * SAFETY:
 * - Never load entire file (tail-only, max 512KB)
 * - Skip lines > 100KB (real files have 11MB single lines)
 * - Cap total output at 1500 chars
 * - All errors caught silently — return empty string on failure
 */

import type * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// =========================================================================
// Safety Limits
// =========================================================================

/** Skip JSONL lines larger than this */
const MAX_LINE_BYTES = 100_000; // 100KB
/** Only read last portion of file */
const TAIL_READ_SIZE = 512_000; // 512KB
/** Max turns to extract */
const MAX_TURNS = 8;
/** Max chars per turn entry */
const MAX_TURN_CHARS = 250;
/** Max total output */
const MAX_OUTPUT_CHARS = 1500;

/** Valid characters for session IDs and agent IDs — prevents path traversal */
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function getAgentsDir(): string {
  return process.env.PD_TEST_AGENTS_DIR || path.join(os.homedir(), '.openclaw', 'agents');
}

// =========================================================================
// Safe File Reading (Async)
// =========================================================================

async function safeTail(filePath: string): Promise<string[]> {
  try {
    // Check existence and stats asynchronously
     
     
    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      return []; // File doesn't exist or can't be accessed
    }
    if (stat.size === 0) return [];

    const isTruncated = stat.size > TAIL_READ_SIZE;
    const readSize = Math.min(stat.size, TAIL_READ_SIZE);
    const buffer = Buffer.alloc(readSize);
    
    // Use async file read
    const fileHandle = await fsPromises.open(filePath, 'r');
    try {
      await fileHandle.read(buffer, 0, readSize, stat.size - readSize);
      await fileHandle.close();
      const content = buffer.toString('utf8');
      // Only strip first line if file was actually truncated (started mid-line)
      const validContent = isTruncated ? content.slice(content.indexOf('\n') + 1) : content;
      return validContent.split('\n').filter(l => l.trim().length > 0);
    } catch (err) {
      // Ensure file handle is closed even on error
      try { await fileHandle.close(); } catch { /* ignore close error */ }
      throw err;
    }
  } catch (err) {
    console.debug(`[pain-context-extractor] safeTail failed: ${String(err)}`);
    return [];
  }
}

// =========================================================================
// Safe JSONL Parsing
// =========================================================================

interface ParsedMessage {
  role: string;
  textParts: string[];
  toolCalls: { id?: string; name?: string; arguments?: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  details?: { exitCode?: number; isError?: boolean; aggregated?: string };
}

function parseSafeMessages(lines: string[]): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of lines) {
    if (line.length > MAX_LINE_BYTES) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'message' || !parsed.message) continue;
      const msg = parsed.message;
      const content = Array.isArray(msg.content) ? msg.content : [];
      messages.push({
        role: msg.role || '',
        textParts: content.filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text || ''),
        toolCalls: content.filter((c: { type: string }) => c.type === 'toolCall').map((c: { id?: string; name?: string; arguments?: Record<string, unknown> }) => ({ id: c.id, name: c.name, arguments: c.arguments })),
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        details: msg.details,
      });
    } catch { /* malformed JSON line, skip silently — expected with corrupted files */ }
  }
  return messages;
}

// =========================================================================
// Turn Extraction
// =========================================================================

/**
 * Extracts a concise turn representation from a message.
 * Returns null if nothing useful to extract.
 */
function extractTurn(msg: ParsedMessage): string | null {
  if (msg.role === 'user' && msg.textParts.length > 0) {
    // For user messages, skip system prompt injection patterns
    const text = msg.textParts.join(' ').trim();
    if (!text) return null;
    // Skip if it looks like a system injection
    if (text.startsWith('<evolution_task') || text.startsWith('<system_override') ||
        text.startsWith('You are an empathy observer') || text.startsWith('Analyze ONLY') ||
        text.startsWith('{"damageDetected"')) return null;
    // Find the last meaningful user input line
    const lines = text.split('\n');
    let lastInput = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 3 && trimmed.length < 500 &&
          !trimmed.startsWith('<') && !trimmed.startsWith('{') &&
          !trimmed.startsWith('Trust Score:') && !trimmed.startsWith('Hygiene:')) {
        lastInput = trimmed;
      }
    }
    const userInput = lastInput || text;
    return `[User]: ${userInput.substring(0, MAX_TURN_CHARS)}`;
  }

  if (msg.role === 'assistant') {
    // Priority 1: final text reply
    if (msg.textParts.length > 0) {
      const text = msg.textParts.join(' ').trim();
      if (text) return `[Assistant]: ${text.substring(0, MAX_TURN_CHARS)}`;
    }
    // Priority 2: tool call summary (what operations were performed)
    if (msg.toolCalls.length > 0) {
      const tools = msg.toolCalls.map(tc => tc.name).filter(Boolean);
      const uniqueTools = [...new Set(tools)];
      if (uniqueTools.length > 0) {
        return `[Assistant → ${uniqueTools.join(', ')}]`;
      }
    }
  }

  if (msg.role === 'toolResult') {
    const exitCode = msg.details?.exitCode;
    const isError = msg.details?.isError || (exitCode !== undefined && exitCode !== 0);
    const text = msg.textParts.join(' ').trim();
    const toolLabel = msg.toolName || 'tool';

    if (isError) {
      // Failed tool call — important for diagnosis
      const errorPreview = text ? text.substring(0, MAX_TURN_CHARS) : `(exit ${exitCode ?? '?'})`;
      return `[${toolLabel} FAILED]: ${errorPreview}`;
    }

    // Successful tool call — include brief result
    if (text) {
      // For successful results, show first meaningful line
      const lines = text.split('\n').filter(l => l.trim());
      const firstLine = lines[0]?.substring(0, MAX_TURN_CHARS) || '';
      if (firstLine) return `[${toolLabel}]: ${firstLine}`;
    }
  }

  return null;
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Extracts recent conversation context from a session's JSONL file.
 *
 * SAFETY: Tail-only read, skip oversized lines, cap output.
 * Returns empty string on any failure — caller should use pain reason as fallback.
 */
     
export async function extractRecentConversation(
  sessionId: string,
  agentId = 'main',
  maxTurns: number = MAX_TURNS,
): Promise<string> {
  if (!sessionId || sessionId.length < 5 || !SAFE_ID_REGEX.test(sessionId)) return '';
  if (agentId && !SAFE_ID_REGEX.test(agentId)) return '';
  try {
    const jsonlPath = path.join(getAgentsDir(), agentId, 'sessions', `${sessionId}.jsonl`);
    const lines = await safeTail(jsonlPath);
    const messages = parseSafeMessages(lines);
    if (messages.length === 0) return '';

    const turns: string[] = [];
    for (const msg of messages) {
      const turn = extractTurn(msg);
      if (turn) turns.push(turn);
    }

    const recent = turns.slice(-maxTurns);
    if (recent.length === 0) return '';
    const result = recent.join('\n');
    return result.length > MAX_OUTPUT_CHARS ? result.substring(0, MAX_OUTPUT_CHARS - 3) + '...' : result;
  } catch (err) {
    console.debug(`[pain-context-extractor] extractRecentConversation failed for session=${sessionId}, agent=${agentId}: ${String(err)}`);
    return ''; // Fail silently
  }
}

/**
 * Extracts failed tool call context with argument correlation.
 */
 
export async function extractFailedToolContext(
  sessionId: string,
  agentId: string,
  toolName: string,
  filePath?: string,
): Promise<string> {
  if (!sessionId || sessionId.length < 5 || !SAFE_ID_REGEX.test(sessionId) || !toolName) return '';
  if (agentId && !SAFE_ID_REGEX.test(agentId)) return '';
  try {
    const jsonlPath = path.join(getAgentsDir(), agentId, 'sessions', `${sessionId}.jsonl`);
    const lines = await safeTail(jsonlPath);
    const messages = parseSafeMessages(lines);
    if (messages.length === 0) return '';

    // Build toolCallId → arguments map
    // Keep both full args (for matching) and truncated (for display)
    const toolArgsById = new Map<string, { name: string; fullArgs: string; previewArgs: string }>();
    for (const msg of messages) {
      for (const tc of msg.toolCalls) {
        if (tc.id && tc.name) {
          const args = tc.arguments || {};
          const fullArgs = JSON.stringify(args);
          const truncated: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args)) {
            const s = typeof v === 'string' ? v : JSON.stringify(v);
            truncated[k] = s.length > 150 ? s.substring(0, 150) + '...' : s;
          }
          toolArgsById.set(tc.id, {
            name: tc.name,
            fullArgs,
            previewArgs: JSON.stringify(truncated, null, 2),
          });
        }
      }
    }

    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'toolResult' && msg.toolName === toolName) {
        const exitCode = msg.details?.exitCode;
        const isError = msg.details?.isError || (exitCode !== undefined && exitCode !== 0);
        if (!isError) continue;

        const {toolCallId} = msg;
        const correlated = toolCallId ? toolArgsById.get(toolCallId) : null;
        if (filePath && correlated && !correlated.fullArgs.includes(filePath)) continue;

        parts.push(`[Tool Call: ${correlated?.name || toolName}]`);
        if (correlated) parts.push(`Arguments: ${correlated.previewArgs.substring(0, 300)}`);
        parts.push(`Exit Code: ${exitCode ?? 'N/A'}`);
        const errorText = msg.textParts.join(' ').trim();
        if (errorText) parts.push(`Error: ${errorText.substring(0, 500)}`);
        break;
      }
    }
    return parts.length > 0 ? parts.join('\n') : '';
  } catch (err) {
    console.debug(`[pain-context-extractor] extractFailedToolContext failed for tool=${toolName}, session=${sessionId}: ${String(err)}`);
    return '';
  }
}
