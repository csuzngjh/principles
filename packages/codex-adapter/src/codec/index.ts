/**
 * Codec barrel — input decoder + output encoder for Codex CLI.
 */
export {
  decodeCodexInput,
  CodexDecoderError,
  CODEX_EVENT_PRE_TOOL_USE,
  CODEX_EVENT_POST_TOOL_USE,
  CODEX_EVENT_USER_PROMPT_SUBMIT,
  CODEX_EVENT_SESSION_START,
  CODEX_EVENT_SESSION_END,
} from './input-decoder.js';

export {
  encodeCodexOutput,
  codexOutputFieldsAreWhitelisted,
  CodexEncoderError,
} from './output-encoder.js';

export type {
  CodexPreToolUseOutput,
  CodexPostToolUseOutput,
  CodexUserPromptSubmitOutput,
  CodexSessionStartOutput,
  CodexHookOutput,
} from './output-encoder.js';
