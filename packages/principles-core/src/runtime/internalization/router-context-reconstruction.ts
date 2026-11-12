/**
 * Post-restart reconstruction of router invocation evidence
 * (SPEC-PD-RULE-ASSOCIATION-005 v0.6 §5; PRI-1146 P2-01).
 *
 * A receipt is only evidence if a NEW process can re-derive everything the
 * original run submitted and then run the FULL verification
 * (`verifyRouterContextReceipt`), not just a structural read.
 *
 * The reconstruction uses persisted, immutable facts only:
 *   - the run's exact `input_payload` (the router message submitted);
 *   - the Stage A / Stage B predecessor artifacts (`content_json`);
 *   - the profile system-prompt layer from runtime configuration.
 *
 * It never trusts the current Ledger as a substitute for the historical
 * exposure, and it never invents evidence: any inconsistency is a typed
 * failure, never a partial pass.
 */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { DiagRootCauseOutputV1Schema } from '../diagnostician/diag-rootcause-output.js';
import { DiagDistillerOutputV1Schema } from '../diagnostician/diag-distiller-output.js';
import { RouterPromptBuilder } from '../diagnostician/router-prompt-builder.js';
import type { OutputLanguage } from '../language-directive.js';
import { mergeSystemPromptLayers } from '../system-prompt-merge.js';
import { hashContextRefs } from '../runner/context-hash.js';
import {
  RouterTrustedContextSchema,
  type RouterTrustedPrinciple,
  type RouterTrustedContext,
} from './router-context-evidence.js';

/** The exact persisted router message shape (`RouterPromptInput`). */
const PersistedRouterMessageSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  rootCauseArtifactId: Type.String({ minLength: 1 }),
  rootCauseOutput: DiagRootCauseOutputV1Schema,
  distillerArtifactId: Type.String({ minLength: 1 }),
  distillerOutput: DiagDistillerOutputV1Schema,
  trustedContext: RouterTrustedContextSchema,
}, { additionalProperties: false });

/** The exposure a caller can prove from the persisted message itself. */
type ReconstructedExposure =
  | { status: 'available'; principles: readonly RouterTrustedPrinciple[]; evidenceRefs: readonly string[] }
  | { status: 'unavailable'; reason: 'ledger_unavailable' | 'ledger_corrupt' | 'source_not_configured'; nextAction: string; evidenceRefs: readonly string[] };

interface ReconstructedRouterContextEvidence {
  taskId: string;
  runId: string;
  contextHash: string;
  /** The exact message the original run submitted (byte-identical). */
  message: string;
  /** Effective system prompt: base layer merged with the profile layer. */
  systemPrompt: string;
  predecessors: { artifactId: string; content: unknown }[];
  exposed: ReconstructedExposure;
}

interface ReconstructRouterContextEvidenceInput {
  /** Persisted run row — `inputPayload` is the exact submitted message. */
  run: { runId: string; taskId: string; inputPayload?: string };
  /** Persisted Stage A / Stage B artifacts, loaded by artifact id. */
  predecessorArtifacts: readonly { artifactId: string; contentJson: string }[];
  /** Operator-configured profile append layer at verification time. */
  profileSystemPrompt?: string;
  outputLanguage?: OutputLanguage;
}

type ReconstructionResult =
  | { status: 'available'; evidence: ReconstructedRouterContextEvidence }
  | { status: 'unavailable'; reason: string; nextAction: string };

const fail = (reason: string, nextAction: string): ReconstructionResult => ({ status: 'unavailable', reason, nextAction });

/**
 * Rebuild the full invocation evidence for one router run from persisted data.
 *
 * Fail-closed conditions (all typed, never guessed):
 *   - missing run input payload / malformed JSON / schema-invalid message;
 *   - missing, extra, malformed, or schema-invalid predecessor artifacts;
 *   - persisted predecessor content differing from what the message embedded;
 *   - a rebuilt message that is not byte-identical to the submitted message;
 *   - a rebuilt system prompt that is empty.
 */
export function reconstructRouterContextEvidence(
  input: ReconstructRouterContextEvidenceInput,
): ReconstructionResult {
  const { run, predecessorArtifacts, profileSystemPrompt, outputLanguage } = input;
  const invalid = (reason: string) => fail(
    reason,
    'Reload the persisted router run, its Stage A/B predecessor artifacts, and the runtime profile configuration; do not infer a canonical allowlist.',
  );

  if (run.inputPayload === undefined || run.inputPayload.trim() === '') return invalid('run_input_payload_missing');
  if (predecessorArtifacts.length !== 2) return invalid('predecessor_artifacts_incomplete');

  let parsedMessage: unknown;
  try {
    parsedMessage = JSON.parse(run.inputPayload);
  } catch {
    return invalid('run_input_payload_invalid_json');
  }
  if (!Value.Check(PersistedRouterMessageSchema, parsedMessage)) return invalid('run_input_payload_invalid');
  const message = parsedMessage;

  const rootCauseArtifact = predecessorArtifacts.find((artifact) => artifact.artifactId === message.rootCauseArtifactId);
  const distillerArtifact = predecessorArtifacts.find((artifact) => artifact.artifactId === message.distillerArtifactId);
  if (!rootCauseArtifact || !distillerArtifact) return invalid('predecessor_artifact_missing');
  if (rootCauseArtifact.artifactId === distillerArtifact.artifactId) return invalid('predecessor_artifact_duplicate');

  let persistedRootCause: unknown;
  let persistedDistiller: unknown;
  try {
    persistedRootCause = JSON.parse(rootCauseArtifact.contentJson);
    persistedDistiller = JSON.parse(distillerArtifact.contentJson);
  } catch {
    return invalid('predecessor_artifact_invalid_json');
  }
  if (!Value.Check(DiagRootCauseOutputV1Schema, persistedRootCause)
    || !Value.Check(DiagDistillerOutputV1Schema, persistedDistiller)) {
    return invalid('predecessor_artifact_invalid');
  }
  // The message is only reconstructible from these artifacts if they are the
  // SAME content the run embedded — otherwise the digest proof would bind a
  // prompt that never ran.
  if (!Value.Equal(persistedRootCause, message.rootCauseOutput)
    || !Value.Equal(persistedDistiller, message.distillerOutput)) {
    return invalid('predecessor_artifact_mismatch');
  }

  const trustedContext: RouterTrustedContext = message.trustedContext;
  const rebuilt = new RouterPromptBuilder().buildPrompt({
    rootCauseArtifactId: message.rootCauseArtifactId,
    rootCauseOutput: message.rootCauseOutput,
    distillerArtifactId: message.distillerArtifactId,
    distillerOutput: message.distillerOutput,
    trustedContext,
  }, { outputLanguage });

  // Byte equality proves the rebuilt message (and therefore the system prompt
  // input) is the one the run actually submitted.
  if (rebuilt.message !== run.inputPayload) return invalid('message_reconstruction_mismatch');

  const systemPrompt = mergeSystemPromptLayers(rebuilt.systemPrompt, profileSystemPrompt);
  if (systemPrompt === undefined) return invalid('system_prompt_unreconstructible');

  const evidenceRefs = [...new Set(message.rootCauseOutput.evidence.map((entry) => entry.sourceRef))];
  const exposed: ReconstructedExposure = trustedContext.status === 'available'
    ? { status: 'available', principles: trustedContext.principles, evidenceRefs }
    : { status: 'unavailable', reason: trustedContext.reason, nextAction: trustedContext.nextAction, evidenceRefs };

  return {
    status: 'available',
    evidence: {
      taskId: run.taskId,
      runId: run.runId,
      contextHash: hashContextRefs([message.rootCauseArtifactId, message.distillerArtifactId]),
      message: run.inputPayload,
      systemPrompt,
      predecessors: [
        { artifactId: message.rootCauseArtifactId, content: message.rootCauseOutput },
        { artifactId: message.distillerArtifactId, content: message.distillerOutput },
      ],
      exposed,
    },
  };
}
