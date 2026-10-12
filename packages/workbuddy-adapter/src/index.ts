/**
 * @principles/workbuddy-adapter — the WorkBuddy host adapter for Principles
 * Disciple (ADR-0020 third host, SPEC workbuddy-host-adapter v0.3.0).
 *
 * Public surface mirrors the codex-adapter layout: the HostAdapter
 * implementation, the codec, the governance-workspace resolution, the tool
 * semantic declaration, and the evidence recorder. The process entry lives
 * at ./pd-hook (spawned per hook event by plugin/scripts/wrapper.cjs).
 */
export { WorkBuddyHooksHostAdapter } from './host-adapter.js';
export {
  decodeWorkbuddyInput,
  normalizeWorkbuddyToolResponse,
  encodeWorkbuddyOutput,
  workbuddyOutputFieldsAreWhitelisted,
  WorkBuddyDecoderError,
  WorkBuddyEncoderError,
  WORKBUDDY_EVENT_PRE_TOOL_USE,
  WORKBUDDY_EVENT_POST_TOOL_USE,
  WORKBUDDY_EVENT_POST_TOOL_USE_FAILURE,
  WORKBUDDY_EVENT_USER_PROMPT_SUBMIT,
  WORKBUDDY_EVENT_SESSION_START,
  type WorkBuddyHookOutput,
} from './codec/index.js';
export {
  resolveWorkbuddyWorkspace,
  type WorkbuddyWorkspaceResolution,
} from './workspace-resolution.js';
export {
  WORKBUDDY_TOOL_SEMANTICS,
  WORKBUDDY_TOOL_SEMANTIC_MAPPINGS,
} from './tool-semantics.js';
export {
  recordWorkbuddyPromptDeliveryEvidence,
  recordWorkbuddyDenyEvidence,
  workbuddyCapabilityDeclarations,
  WORKBUDDY_EVIDENCE_ADAPTER_VERSION,
} from './workbuddy-evidence-recorder.js';
export {
  processWorkbuddyHookInvocation,
  annotateContextWarnings,
  type WorkBuddyPdHookResult,
} from './pd-hook.js';
