/**
 * WorkBuddy conversation-ingestion surface (PRI-1171 P2).
 *
 * The per-host thin half of the unified seam: cwd encoding, deterministic
 * transcript location/validation, the flat-record decoder, and the
 * TranscriptSourceAdapter the shared host-runtime pipeline drives.
 */
export { encodeWorkbuddyCwd } from './encode-cwd.js';
export {
  deriveWorkbuddyTranscriptPath,
  validateWorkbuddyTranscriptPath,
  workbuddyProjectsRoot,
  type WorkbuddyTranscriptFileIdentity,
  type WorkbuddyTranscriptPathValidation,
} from './transcript-path.js';
export {
  decodeWorkbuddyTranscriptWindow,
  type DecodedWorkbuddyDelta,
  type DecodeWorkbuddyWindowInput,
} from './transcript-decoder.js';
export {
  createWorkbuddyTranscriptSource,
  WORKBUDDY_SINGLE_SESSION_ALERT_BYTES,
  type WorkbuddyTranscriptSourceContext,
} from './transcript-source.js';
export {
  ingestWorkbuddyConversation,
  workbuddyIngestionHints,
  type WorkbuddyIngestionOptions,
  type WorkbuddyIngestionOutcome,
} from './ingestion.js';
export {
  catchUpWorkbuddyIngestion,
  locateWorkbuddyTranscriptBySessionIdentity,
  type WorkbuddyCatchUpOptions,
  type WorkbuddyCatchUpResult,
} from './catch-up.js';
