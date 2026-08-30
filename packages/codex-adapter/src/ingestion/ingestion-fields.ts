/**
 * Codex hook payload field extraction (Slice A) — shared by the live
 * observation ingestor and the Slice B admission orchestrator.
 */
export interface PayloadFields {
  transcriptPath: string | null;
  sessionId: string;
  turnId: string | null;
  prompt: string | null;
  toolUseId: string | null;
  toolName: string | null;
  toolInput: unknown;
  toolResponse: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

export function extractFields(raw: unknown): PayloadFields | null {
  if (!isRecord(raw)) return null;
  const transcriptPath = own(raw, 'transcript_path');
  if (transcriptPath !== null && typeof transcriptPath !== 'string') return null;
  const sessionId = own(raw, 'session_id');
  const turnId = own(raw, 'turn_id');
  const prompt = own(raw, 'prompt');
  const toolUseId = own(raw, 'tool_use_id');
  const toolName = own(raw, 'tool_name');
  return {
    transcriptPath: transcriptPath ?? null,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
    turnId: typeof turnId === 'string' ? turnId : null,
    prompt: typeof prompt === 'string' ? prompt : null,
    toolUseId: typeof toolUseId === 'string' ? toolUseId : null,
    toolName: typeof toolName === 'string' ? toolName : null,
    toolInput: own(raw, 'tool_input'),
    toolResponse: own(raw, 'tool_response'),
  };
}
