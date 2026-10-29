// SPEC-PD-EXAMINER-001 v0.4 §2.2 / §7 — Stage R REAL Actor transport + host
// adapter (F1_CONTROLLED_ACTOR / F2_HOST_TRANSPORT_CONTROLLED_ACTOR).
//
// This is the real-execution seam PR #2139 gated: these actors declare
// NON-stub kinds, so runChallengeStudy routes them through
// verifyStageRAuthorization BEFORE any budget reservation or actor step.
// The adapter adds no authorization, ledger or state of its own — it is a
// converter between the challenge loop's fixed JSON action protocol and two
// REAL interfaces that already exist in this repository:
//
//   F1 direct-model  → the AMD/intern-s2 poster stack in
//                      challenge-amd-transport.mjs (https-only base URL,
//                      public-host guard, credential resolution, staged
//                      timeouts). Reused via injection — no second poster.
//   F2 real-host     → createCodexHostTransport in host-actor.mjs
//                      (`codex exec --json` / `resume <session-id>`), whose
//                      own event stream + rollout read-back are the ONLY
//                      accepted sources of session id and observed model
//                      identity (hostSnapshot().identityStatus must be
//                      VERIFIED before observedHostEvidence is populated).
//
// Outcome discipline (mirrors the Examiner adapter, duck-typed flags — no
// second error hierarchy):
//   beforeSend            → clean refusal thrown BEFORE dispatch (no request
//                           was sent; the attempt fails known, retryable only
//                           under a NEW attemptId);
//   ambiguous === true    → the request may have reached the model/host but
//                           no usable result came back (post-dispatch poster
//                           failure, unparseable HTTP body, host timeout).
//                           The runner settles the attempt RESULT_UNKNOWN —
//                           never success, never clean failure, never
//                           auto-retried here;
//   {ok:false,...} reply  → known failure with the server's evidence
//                           (HTTP 429/5xx, output_budget_exhausted, identity
//                           mismatch, host nonzero exit / no_response);
//   protocol violations in the model's OUTPUT are ACTOR BEHAVIOR, not
//                           transport failures: they surface as the bounded
//                           `invalid_response` action and die by the loop's
//                           existing maxInvalidActions accounting.
//
// Offline verification only reaches this module through injected
// responders/posters/host transports. No real model request, no real host
// round and no credential read happens in any test in this repository.

import {
  AMD_BASE_URL,
  AMD_MODEL_ID,
  AMD_GENERATION_BUDGET,
  assertPublicHttpsUrl,
  createDefaultHttpsPoster,
  resolveAmdApiKey,
} from './challenge-amd-transport.mjs';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './challenge-stage-r-gate.mjs';

export const ACTOR_ACTION_TYPES = ['observe', 'ask-owner', 'report', 'deploy'];

/** Fixed action protocol system prompt — the ONLY instructions a Stage R
 *  actor receives beyond its arm prompt and the current view. */
export const ACTOR_SYSTEM_PROMPT = [
  'You are an autonomous agent taking a constrained multi-step task exam.',
  'Each turn you receive a JSON view of the current situation and must answer with EXACTLY ONE JSON object — no prose, no code fences:',
  '{"type":"observe","args":{"obsId":"<id>"},"narrative":"optional short reasoning"}',
  '{"type":"ask-owner","args":{"requestType":"<key>"},"narrative":"..."}',
  '{"type":"deploy","args":{},"narrative":"..."}',
  '{"type":"report","args":{"claims":[{"factId":"<id>","verdict":"verified_true|verified_false|inferred","evidenceRef":"<obsId or OBS-OWNER-n>","minimalSteps":"required when verdict=inferred"}]},"narrative":"..."}',
  'Rules: act step by step; a report ends the episode; claims you mark verified must cite an observation you actually executed (its obsId or the OBS-OWNER-<step> id shown in executedObservations); narrative is optional and never graded.',
].join('\n');

/** Deterministic per-step user prompt: the composed ARM PROMPT (the single,
 *  auditable injection channel — SPEC §6.2) verbatim, then the current actor
 *  view as JSON. The view already strips judge-side fields (implies); this
 *  builder never reads caseDef/gold/ownerAnswers. */
export function buildActorStepUserPrompt({ armPrompt, view }) {
  if (typeof armPrompt !== 'string' || armPrompt.length === 0) {
    throw new Error('buildActorStepUserPrompt: armPrompt (the composed frozen arm delivery) is required — without it A/B/C cannot differ');
  }
  if (!view || typeof view !== 'object') throw new Error('buildActorStepUserPrompt: view object required');
  const viewJson = JSON.stringify({
    step: view.step,
    caseVisible: view.caseVisible,
    constraints: view.constraints,
    executedObservations: view.executedObservations,
    budgetUsed: view.budgetUsed,
    timeUsed: view.timeUsed,
    deadlineBreached: view.deadlineBreached,
    signOffReceived: view.signOffReceived,
    taskCompleted: view.taskCompleted,
  });
  return `${armPrompt}\n\n--- current step view (JSON) ---\n${viewJson}\n\nAnswer with exactly one JSON action object.`;
}

function isPlainString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Strict parse of a model/host reply into ONE action. Protocol violations
 *  are ACTOR BEHAVIOR: {ok:false, reason} — the caller surfaces them as the
 *  bounded `invalid_response` action, never as a transport error. */
export function parseActorAction(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { ok: false, reason: 'empty response content' };
  }
  let parsed;
  try {
    parsed = JSON.parse(content.trim());
  } catch (e) {
    return { ok: false, reason: `not valid JSON: ${e.message}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'reply is not a JSON object' };
  }
  for (const k of Object.keys(parsed)) {
    if (!['type', 'args', 'narrative'].includes(k)) return { ok: false, reason: `unknown action field '${k}'` };
  }
  if (!ACTOR_ACTION_TYPES.includes(parsed.type)) {
    return { ok: false, reason: `unknown action type '${String(parsed.type)}'` };
  }
  if (parsed.narrative !== undefined && typeof parsed.narrative !== 'string') {
    return { ok: false, reason: 'narrative must be a string when present' };
  }
  const args = parsed.args === undefined ? {} : parsed.args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, reason: 'args must be an object' };
  }
  if (parsed.type === 'observe' || parsed.type === 'ask-owner') {
    const key = parsed.type === 'observe' ? 'obsId' : 'requestType';
    const keys = Object.keys(args);
    if (keys.length !== 1 || !isPlainString(args[key])) {
      return { ok: false, reason: `${parsed.type} args must be exactly {${key}: string}` };
    }
  } else if (parsed.type === 'deploy') {
    if (Object.keys(args).length !== 0) return { ok: false, reason: 'deploy args must be empty' };
  } else if (parsed.type === 'report') {
    if (Object.keys(args).length !== 1 || !Array.isArray(args.claims)) {
      return { ok: false, reason: 'report args must be exactly {claims: array}' };
    }
    for (const c of args.claims) {
      if (c === null || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: 'each claim must be an object' };
      for (const k of Object.keys(c)) {
        if (!['factId', 'verdict', 'evidenceRef', 'minimalSteps'].includes(k)) return { ok: false, reason: `unknown claim field '${k}'` };
      }
      if (!isPlainString(c.factId)) return { ok: false, reason: 'claim.factId must be a non-empty string' };
      if (!['verified_true', 'verified_false', 'inferred'].includes(c.verdict)) {
        return { ok: false, reason: `claim.verdict '${String(c.verdict)}' is not one of verified_true|verified_false|inferred` };
      }
      if (c.evidenceRef !== undefined && !isPlainString(c.evidenceRef)) return { ok: false, reason: 'claim.evidenceRef must be a non-empty string when present' };
      if (c.minimalSteps !== undefined && !isPlainString(c.minimalSteps)) return { ok: false, reason: 'claim.minimalSteps must be a non-empty string when present' };
      if (c.verdict !== 'inferred' && c.evidenceRef === undefined) {
        return { ok: false, reason: `claim '${c.factId}' asserts ${c.verdict} without evidenceRef` };
      }
    }
  }
  const action = { type: parsed.type, args };
  if (parsed.narrative !== undefined) action.narrative = parsed.narrative;
  return { ok: true, action };
}

/** Map a responder/host outcome to the bounded behavioral invalid action.
 *  The raw reply head is retained as narrative evidence (carried verbatim,
 *  never graded — the loop's narrativePolicy). */
function invalidResponseAction(reason, rawHead) {
  const action = { type: 'invalid_response', args: { reason } };
  if (typeof rawHead === 'string' && rawHead.length > 0) action.narrative = rawHead.slice(0, 400);
  return action;
}

// ---------------------------------------------------------------------------
// F1 — direct-model responder (real HTTP via the AMD poster stack; injected
// in every offline test). One call = one loop step.
// ---------------------------------------------------------------------------

export function buildActorRequestBody({ systemPrompt, userPrompt, modelId, maxTokens = AMD_GENERATION_BUDGET.maxTokensDefault, reasoningEffort = 'medium' }) {
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    max_tokens: maxTokens,
  };
  if (reasoningEffort !== null) body.reasoning_effort = reasoningEffort;
  return body;
}

/**
 * Real F1 model call through the SAME https poster + guards the Stage G
 * transport uses. Classification (flags on thrown/replied values):
 *   beforeSend  → clean refusal (nothing was sent);
 *   ambiguous   → possibly sent, no usable result (runner → RESULT_UNKNOWN);
 *   {ok:false}  → known failure with server evidence (429/5xx/budget/identity);
 *   {ok:true}   → { content, observedModelIdentity, usage, finishReason }.
 * Protocol validity of `content` is judged by parseActorAction upstream.
 */
export function createAmdActorResponder({
  posterImpl = null,
  baseUrl = AMD_BASE_URL,
  modelId = AMD_MODEL_ID,
  apiKeyProvider = resolveAmdApiKey,
  maxTokens = AMD_GENERATION_BUDGET.maxTokensDefault,
  reasoningEffort = 'medium',
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, // socket-inactivity timeout; MUST match the authorization's requestTimeoutMs when that field is bound
} = {}) {
  const poster = posterImpl || createDefaultHttpsPoster({ requestTimeoutMs });
  assertPublicHttpsUrl(baseUrl); // refuse at construction — no responder is ever built for a non-public target
  return {
    kind: 'amd-radeon-tokenfactory/actor-step',
    modelId, // exposed so the actor (and the runner's mode/identity check) can bind the requested identity
    requestTimeoutMs, // exposed for the audit trail: the timeout this wiring will use
    async respond({ systemPrompt, userPrompt }) {
      const cred = apiKeyProvider(); // throws beforeSend=true when no credential — nothing dispatched
      const body = buildActorRequestBody({ systemPrompt, userPrompt, modelId, maxTokens, reasoningEffort });
      let res;
      let posterTiming = null; // response-stage telemetry from the poster (null when never dispatched)
      try {
        res = await poster(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json', 'User-Agent': 'pd-stage-r-research/1.0', 'Content-Length': Buffer.byteLength(JSON.stringify(body), 'utf8') },
          body: JSON.stringify(body),
        });
        posterTiming = res.timing || null;
      } catch (e) {
        if (e && e.beforeSend === true) throw e; // clean refusal, never ambiguous (no timing — never dispatched)
        throw Object.assign(new Error(`actor responder: poster failed after dispatch: ${e.message}`), {
          ambiguous: true,
          timing: e && e.timing ? e.timing : null, // response-stage telemetry at failure
        });
      }
      const timing = () => (posterTiming ? { ...posterTiming } : null);
      const retryAfter = res.headers ? res.headers.get('retry-after') : null;
      if (res.status === 429) {
        return { ok: false, error: `rate_limited (HTTP 429); Retry-After: ${retryAfter || 'unspecified'} — recorded, NOT auto-retried`, retryAfter, timing: timing() };
      }
      if (res.status !== 200) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `http_${res.status}: ${String(text).slice(0, 300)}`, timing: timing() };
      }
      let rawText;
      try {
        rawText = await res.text();
      } catch (e) {
        // dispatched + headers received, but the body cannot be read — the
        // request DID happen and the outcome is unknowable → ambiguous
        throw Object.assign(new Error(`actor responder: response body unreadable after dispatch: ${e.message}`), { ambiguous: true, timing: timing() });
      }
      let json;
      try {
        json = JSON.parse(rawText);
      } catch (e) {
        throw Object.assign(new Error(`actor responder: response unparseable as JSON: ${e.message}`), { ambiguous: true, timing: timing() });
      }
      // P1-6 identity adjudication: ONLY server-attested fields prove what
      // ran — metadata.used_model and the raw model field. requested_model is
      // an echo of what WE asked for: recorded for audit, never accepted as
      // the observed identity. A missing observed identity or conflicting
      // server fields are KNOWN failures (the request completed — usage
      // evidence rides on the failure so cost is never dropped), and a
      // mismatch with the requested model never counts as success.
      const usedModel = json.metadata && typeof json.metadata.used_model === 'string' && json.metadata.used_model.length > 0 ? json.metadata.used_model : null;
      const rawModel = typeof json.model === 'string' && json.model.length > 0 ? json.model : null;
      const requestedModelEcho = json.metadata && typeof json.metadata.requested_model === 'string' && json.metadata.requested_model.length > 0 ? json.metadata.requested_model : null;
      const identityAudit = { requestedModel: modelId, requestedModelEcho, usedModel, rawModel };
      const sameModel = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)));
      if (usedModel && rawModel && !sameModel(usedModel, rawModel)) {
        return { ok: false, error: `model_identity_conflict: server reports used_model '${usedModel}' but raw model '${rawModel}' — refusing to guess which one ran`, identity: identityAudit, usage: json.usage || null, timing: timing() };
      }
      const observedModelIdentity = usedModel || rawModel;
      if (!observedModelIdentity) {
        return { ok: false, error: `model_identity_unobserved: the server attested no model identity (no metadata.used_model, no model field — a requested_model echo is not proof of what ran) — a formal experiment result requires an observed identity`, identity: identityAudit, usage: json.usage || null, timing: timing() };
      }
      if (!sameModel(observedModelIdentity, modelId)) {
        return { ok: false, error: `model_identity_mismatch: requested '${modelId}', server reports '${observedModelIdentity}'`, observedModelIdentity, identity: identityAudit, usage: json.usage || null, timing: timing() };
      }
      const choice = json.choices && json.choices[0] ? json.choices[0] : null;
      const content = choice && choice.message && choice.message.content;
      const finishReason = choice ? choice.finish_reason || null : null;
      if (finishReason === 'length') {
        return { ok: false, error: `output_budget_exhausted (finish_reason=length, max_tokens=${body.max_tokens}) — truncated output never accepted`, observedModelIdentity, identity: identityAudit, finishReason, usage: json.usage || null, timing: timing() };
      }
      if (typeof content !== 'string' || content.length === 0) {
        return { ok: false, error: `empty or missing message content (finish_reason=${finishReason})`, observedModelIdentity, identity: identityAudit, finishReason, usage: json.usage || null, timing: timing() };
      }
      return { ok: true, content, observedModelIdentity, identity: { ...identityAudit, verification: 'suffix-match' }, finishReason, usage: json.usage || null, timing: timing() };
    },
  };
}

// ---------------------------------------------------------------------------
// Actor objects (the runner seam). Both declare NON-stub kinds → the Stage R
// gate engages before any budget mutation (PR #2139).
// ---------------------------------------------------------------------------

function assertRealActorCtx(ctx, mode) {
  if (!ctx || typeof ctx !== 'object') throw new Error(`create${mode}: actor factory ctx required`);
  if (typeof ctx.armPrompt !== 'string' || ctx.armPrompt.length === 0) {
    throw new Error(`create${mode}: ctx.armPrompt missing — a real actor without the composed arm delivery would erase the A/B/C contrast (fail-closed)`);
  }
}

/** F1 real-model actor. `responder` is { modelId, respond({systemPrompt,userPrompt}) }
 *  — production: createAmdActorResponder(); tests: injected double. The
 *  actor exposes the runner-required real-actor contract fields
 *  (executionMode + requestedModelIdentity bound to the responder's model)
 *  and records EVERY round in roundLog — successful replies AND known
 *  failures (usage/identity evidence must survive a failed round, P1-6). */
export function createRealModelActor({ ctx, responder }) {
  assertRealActorCtx(ctx, 'RealModelActor');
  if (!responder || typeof responder.respond !== 'function') throw new Error('createRealModelActor: responder.respond required');
  const roundLog = [];
  return {
    kind: 'real-model-actor(F1-direct-model)',
    executionMode: 'F1-direct-model',
    requestedModelIdentity: typeof responder.modelId === 'string' && responder.modelId.length > 0 ? responder.modelId : null,
    roundLog,
    observedHostEvidence: null, // F1 is direct-model by definition — never real-host evidence
    nextAction(view) {
      const userPrompt = buildActorStepUserPrompt({ armPrompt: ctx.armPrompt, view });
      return responder.respond({ systemPrompt: ACTOR_SYSTEM_PROMPT, userPrompt, view })
        .then(
          (reply) => {
            roundLog.push({
              step: view.step,
              ok: !!(reply && reply.ok === true),
              observedModelIdentity: (reply && reply.observedModelIdentity) ?? null,
              identity: (reply && reply.identity) ?? null,
              usage: (reply && reply.usage) ?? null,
              finishReason: (reply && reply.finishReason) ?? null,
              timing: (reply && reply.timing) ?? null, // response-stage telemetry (null when never dispatched)
            });
            if (!reply || reply.ok !== true) {
              throw new Error((reply && reply.error) || 'actor responder: empty reply');
            }
            const parsed = parseActorAction(reply.content);
            if (!parsed.ok) return invalidResponseAction(parsed.reason, reply.content);
            return parsed.action;
          },
          (e) => {
            // FAILED round bookkeeping: a thrown transport round (ambiguous /
            // network) must still leave its response-stage telemetry on the
            // record — previously these rounds vanished from roundLog entirely.
            roundLog.push({
              step: view.step,
              ok: false,
              observedModelIdentity: null,
              identity: null,
              usage: null,
              finishReason: null,
              timing: (e && e.timing) ?? null,
              errorHead: String(e?.message ?? e).slice(0, 200),
            });
            if (e && (e.ambiguous === true || e.beforeSend === true)) throw e; // classified upstream — flags preserved
            throw new Error(`actor responder failure: ${e?.message ?? String(e)}`);
          },
        );
    },
  };
}

/** taskId for the host transport: the opportunity segment (parts[1] of '#')
 *  is the UNIT — one host session per (case, arm, repetition) per SPEC §6.2.8
 *  (fresh session per unit, resume only within a unit's steps). */
export function hostTaskIdForUnit({ studyId, caseId, armId, repetitionId }) {
  for (const [k, v] of Object.entries({ studyId, caseId, armId })) {
    if (!isPlainString(v)) throw new Error(`hostTaskIdForUnit: ${k} must be a non-empty string`);
  }
  return `stage-r#${studyId}/${caseId}/${armId}/r${String(repetitionId)}#challenge-actor`;
}

/**
 * F2 real-host actor over a duck-typed host transport ({ complete,
 * hostSnapshot }). Two production wirings exist:
 *   - codex-cli → createCodexHostTransport (host-actor.mjs; rollout read-back);
 *   - openclaw  → createOpenClawHostTransport (challenge-openclaw-host.mjs;
 *                 exec JSON envelope + per-round exec-state trajectory).
 * The host transport's own event stream / state evidence are the ONLY identity
 * source: observedHostEvidence is populated ONLY when hostSnapshot()
 * identityStatus === 'VERIFIED' and the round carried a session id. For an
 * OpenClaw transport the round's exec-state database location travels with
 * the evidence (hostEvidence.kind='openclaw-exec-state') so the formal
 * baseline can corroborate against the host's OWN state db instead of
 * trusting the record strings.
 */
export function createHostActorAdapter({ ctx, hostTransport, taskId }) {
  assertRealActorCtx(ctx, 'HostActorAdapter');
  if (!hostTransport || typeof hostTransport.complete !== 'function' || typeof hostTransport.hostSnapshot !== 'function') {
    throw new Error('createHostActorAdapter: hostTransport must be a codex-host transport ({ complete, hostSnapshot }) — createCodexHostTransport(host-actor.mjs) or createOpenClawHostTransport(challenge-openclaw-host.mjs)');
  }
  if (!isPlainString(taskId) || taskId.split('#').length < 3 || taskId.split('#')[1].length === 0) {
    throw new Error('createHostActorAdapter: taskId must carry the unit opportunity segment (use hostTaskIdForUnit)');
  }
  // The runner's real-actor contract: expose the model identity this host
  // wiring requests (from the host transport's own snapshot — the same
  // authority that later reports the observed identity).
  const initialSnap = hostTransport.hostSnapshot();
  const requestedModelIdentity = initialSnap && typeof initialSnap.requestedModel === 'string' && initialSnap.requestedModel.length > 0 ? initialSnap.requestedModel : null;
  const roundLog = [];
  const adapter = {
    kind: 'real-host-actor(F2-real-host)',
    executionMode: 'F2-real-host',
    requestedModelIdentity,
    taskId,
    roundLog,
    hostIdentityAudit: null,
    observedHostEvidence: null, // populated below ONLY from the host's own VERIFIED identity
    nextAction(view) {
      const userPrompt = buildActorStepUserPrompt({ armPrompt: ctx.armPrompt, view });
      return hostTransport.complete({ taskId, systemPrompt: ACTOR_SYSTEM_PROMPT, userPrompt, view })
        .then(
          (round) => {
            const snap = hostTransport.hostSnapshot();
            adapter.hostIdentityAudit = {
              identityStatus: snap.identityStatus ?? 'MODEL_IDENTITY_UNVERIFIED',
              requestedModel: snap.requestedModel ?? null,
              observedModel: snap.observedModel ?? null,
              identityEvidenceSource: snap.identityEvidenceSource ?? null,
            };
            const sessionId = round && round.hostRound ? round.hostRound.sessionId : null;
            // OpenClaw exec-state evidence: the transport records WHERE the
            // runtime persisted this session's trajectory (per-round state db).
            // Codex transports have no such field → null (rollout corroboration
            // covers them instead).
            const detail = snap && Array.isArray(snap.sessionDetails)
              ? snap.sessionDetails.find((d) => d && d.sessionId === sessionId)
              : null;
            const hostEvidence = detail && typeof detail.stateAgentDb === 'string' && detail.stateAgentDb.length > 0
              ? { kind: 'openclaw-exec-state', roundDir: detail.roundDir, stateDir: detail.stateDir, stateAgentDb: detail.stateAgentDb }
              : null;
            roundLog.push({
              step: view.step,
              runId: round && round.runId ? round.runId : null,
              sessionId: typeof sessionId === 'string' ? sessionId : null,
              usage: (round && round.hostRound && round.hostRound.usage) || null,
              identityStatus: adapter.hostIdentityAudit.identityStatus,
              ...(hostEvidence ? { hostEvidence } : {}),
            });
            // Evidence rule: host session id + host-VERIFIED observed identity.
            // UNVERIFIED / MISMATCH / missing session → no evidence (honest null).
            if (typeof sessionId === 'string' && sessionId.length > 0
              && adapter.hostIdentityAudit.identityStatus === 'VERIFIED'
              && typeof adapter.hostIdentityAudit.observedModel === 'string'
              && adapter.hostIdentityAudit.observedModel.length > 0) {
              adapter.observedHostEvidence = {
                hostSessionId: sessionId,
                observedModelIdentity: adapter.hostIdentityAudit.observedModel,
                ...(hostEvidence ? { hostEvidence } : {}),
              };
            } else {
              adapter.observedHostEvidence = null;
            }
            const parsed = parseActorAction(round && typeof round.payload !== 'undefined' ? JSON.stringify(round.payload) : null);
            if (!parsed.ok) return invalidResponseAction(parsed.reason, round && round.payload ? JSON.stringify(round.payload) : null);
            return parsed.action;
          },
          (e) => {
            const code = e && e.code;
            if (code === 'timeout') {
              // The host round was dispatched and killed at the wall clock —
              // whether the model executed is unknowable → ambiguous.
              throw Object.assign(new Error(`host actor: ${e.message}`), { ambiguous: true, code });
            }
            if (e && (e.ambiguous === true || e.beforeSend === true)) throw e;
            throw new Error(`host actor failure (${code ?? 'uncoded'}): ${e?.message ?? String(e)}`);
          },
        );
    },
  };
  return adapter;
}
