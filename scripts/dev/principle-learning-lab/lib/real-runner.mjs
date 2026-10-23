// PRI-966 G2 — real-arm execution engine (SPEC-PD-PL-001 v0.3 §4.2).
//
// Mirrors lib/runner.mjs's G1 flow (learn → freeze → interactive oracle run →
// adjudicate) with the REAL actor in place of a simulated strategy:
//
//   I0 reflection: ONE transport call reads the arm's frozen history and
//                  states the operating policy it will follow → freezeCandidate
//                  (bytes + hash, sourceStage 'i0-reflection'). Never
//                  hand-polished; no candidate (E0 none-arm) is a transparent
//                  sentinel, not fabricated content.
//   Same-channel delivery: the frozen bytes reach the actor ONLY through
//                  deliverPayload() (research-same-channel-v1), position and
//                  budget identical for every arm — C-A can never be confounded
//                  by delivery mechanics.
//   Per opportunity: runRealActorOpportunity() (lib/actor.mjs) drives the
//                  oracle one action per model round under hard caps; the
//                  outcome goes to the SAME three-layer adjudicator.
//
// C-A content conditions (prereg contrastId real-candidate-vs-summary-vs-raw-
// vs-none; SPEC §4.2 抽象对照): besides the default 'policy' arm, runRealArm
// supports 'summary' (ONE summarization call — same transport round shape,
// same token budget as I0, descriptive reference record instead of an
// operating policy), 'raw' (the frozen history bytes themselves, zero
// generation calls) and 'none' (no delivered content — the E0 flow, available
// on any history for the paired contrast). All four differ ONLY in content:
// channel, position and budgetChars stay identical (prereg deliveryInvariance).
//
// Cross-arm isolation: every arm runs on its OWN transport instance supplied
// by transportForArm — no module state, no shared cache. A judge-only leak
// aborts the whole study (pilot-run-config exitConditions), remaining arms
// are not started.
//
// This module never opens a socket itself: the transport decides (fake =
// offline rehearsal, pi-adapter = production adapter behind Owner decisions).

import { allOpportunities, goldFor, renderHistoryText } from './fixture.mjs';
import { ACTION_COSTS } from './oracle.mjs';
import { adjudicate } from './evaluator.mjs';
import { freezeCandidate } from './sidecar.mjs';
import { deliverPayload } from './g2.mjs';
import { DEFAULT_REAL_ACTOR_CAPS, runRealActorOpportunity } from './actor.mjs';
import { auditTokenUsage, createHttpBudgetLedger } from './http-budget.mjs';
import { createHostProcessLedger } from './host-actor.mjs';



export const REAL_ACTOR_STRATEGY_ID = 'REAL_ACTOR_I0';
export { auditTokenUsage };
const KNOWN_ACTION_NAMES = Object.keys(ACTION_COSTS);
const REFLECTION_MAX_TOKENS = 1024;
const NONE_ARM_SENTINEL = '[none-arm: no I0 candidate generated — delivered content is empty by design]';

/** The C-A same-channel content conditions. 'policy' is the default (and the
 * only pre-existing mode); the others exist so the preregistered four-way
 * contrast is executable without touching channel mechanics. */
export const REAL_CONTENT_MODES = ['policy', 'summary', 'raw', 'none'];

/** Stable arm id for one (history, content condition) pairing. The default
 * policy arm keeps its historical unsuffixed id; other conditions append the
 * mode so arm ids stay unique within a study. */
export function realArmId(historyId, contentMode = 'policy') {
  return contentMode === 'policy'
    ? `${historyId}:${REAL_ACTOR_STRATEGY_ID}`
    : `${historyId}:${REAL_ACTOR_STRATEGY_ID}:${contentMode}`;
}

/** One one-shot content-generation round (free-form JSON path, validated
 * lab-side). Shared by the I0 policy prompt and the C-A summary prompt so the
 * two conditions differ ONLY in instruction and output field — never in call
 * count, token budget or transport path. Returns the output string or throws
 * a labeled failure. */
async function runOneShotGeneration({ transport, systemPrompt, userPrompt, outputField, taskId, caps, failLabel }) {
  let round;
  try {
    round = await transport.complete({
      systemPrompt,
      userPrompt,
      outputSchemaRef: undefined,
      maxTokens: REFLECTION_MAX_TOKENS,
      timeoutMs: caps.timeoutMsPerRequest,
      taskId,
    });
  } catch (err) {
    const failure = new Error(`${failLabel} transport failure: ${err?.message ?? String(err)}`);
    failure.kind = err?.code === 'no_response' ? 'no_response' : 'transport_error';
    throw failure;
  }
  const payload = round?.payload;
  if (typeof payload !== 'object' || payload === null || typeof payload[outputField] !== 'string' || payload[outputField].length === 0) {
    const failure = new Error(`${failLabel} output invalid: expected {${outputField}: non-empty string}`);
    failure.kind = 'invalid_output';
    throw failure;
  }
  return payload[outputField];
}

const I0_SYSTEM_PROMPT = [
  'You are an agent being onboarded with a learning history before future tasks.',
  'Read the history and state the operating policy you will actually follow in future tasks because of it.',
  'Answer with a single JSON object: {"policyText": "<one paragraph, <= 2000 chars>"} and nothing else.',
].join('\n');

// The summary instruction is deliberately an honestly strong one (prereg:
// "must be honestly strong — no weak strawman"): it keeps every concrete fact
// and any lesson the history itself records. The contrast with 'policy' is
// the representation FORM — descriptive reference record vs operating
// directives — not the information or effort available to the condition.
const SUMMARY_SYSTEM_PROMPT = [
  'You are an agent being onboarded with a learning history before future tasks.',
  'Write the reference record of this history for future lookup: which tasks were attempted, what was done, what the outcomes and costs were, and anything the history itself records as a lesson.',
  'Keep the concrete details (names, config keys, values, consequences) — be as useful as the history allows.',
  'Answer with a single JSON object: {"summaryText": "<one paragraph, <= 2000 chars>"} and nothing else.',
].join('\n');

/**
 * Run one real-actor arm. `contentMode` selects the C-A same-channel condition
 * ('policy' default). Returns { arm, adjudications, actorInputs, usage, fatal }.
 * `fatal` is set only for judge-leak INVALID_PROTOCOL — the caller stops the study.
 */
export async function runRealArm({ dataset, historyId, transport, caps = DEFAULT_REAL_ACTOR_CAPS, studyId, armLedger = null, budgets = null, contentMode = 'policy' }) {
  if (!REAL_CONTENT_MODES.includes(contentMode)) {
    throw new Error(`runRealArm: unknown contentMode '${String(contentMode)}' (C-A conditions: ${REAL_CONTENT_MODES.join('|')})`);
  }
  const armId = realArmId(historyId, contentMode);
  // P1-01: every opportunity runs inside its OWN child scope of the arm
  // ledger; the arm scope itself hangs off the study ledger. cap null =
  // record-only (offline rehearsal); a positive cap is fail-closed at the
  // HTTP boundary. Levels never reset or overwrite each other.
  const opportunityLedgers = [];
  const makeOppLedger = (opportunityId) => {
    if (!armLedger) return null;
    const child = createHttpBudgetLedger({
      scope: `${armId}#${opportunityId}`,
      cap: budgets?.httpRequestsPerOpportunity ?? null,
      parent: armLedger,
    });
    opportunityLedgers.push(child);
    return child;
  };
  const history = dataset.histories[historyId];
  const manualText = dataset.worldManual.manualText.join('\n');
  const historyText = renderHistoryText(history);

  // 1. Content generation per C-A condition → frozen bytes (never
  //    hand-polished). A generation failure is a legal arm outcome: sentinel
  //    freeze, empty-channel delivery, actor still scored (prereg
  //    failureHandling).
  let contentText = NONE_ARM_SENTINEL;
  let generation = { stage: 'none', requests: 0, failure: null };
  let sourceStage = 'i0-reflection';
  let deliveredRepresentation = 'none';
  let deliverable = null; // null = empty same-channel payload
  if (contentMode === 'policy' && historyId !== 'E0') {
    sourceStage = 'i0-reflection';
    deliveredRepresentation = 'real_i0_policy_text';
    generation.stage = 'i0-reflection';
    try {
      contentText = await runOneShotGeneration({
        transport, systemPrompt: I0_SYSTEM_PROMPT, userPrompt: historyText,
        outputField: 'policyText', taskId: `${armId}#i0-reflection`, caps, failLabel: 'I0 reflection',
      });
      generation.requests = 1;
      deliverable = contentText;
    } catch (err) {
      generation.requests = 1;
      generation.failure = { kind: err?.kind ?? 'transport_error', reason: err?.message ?? String(err) };
    }
  } else if (contentMode === 'summary') {
    sourceStage = 'model-summary';
    deliveredRepresentation = 'model_summary_text';
    generation.stage = 'model-summary';
    try {
      contentText = await runOneShotGeneration({
        transport, systemPrompt: SUMMARY_SYSTEM_PROMPT, userPrompt: historyText,
        outputField: 'summaryText', taskId: `${armId}#history-summary`, caps, failLabel: 'history summary',
      });
      generation.requests = 1;
      deliverable = contentText;
    } catch (err) {
      generation.requests = 1;
      generation.failure = { kind: err?.kind ?? 'transport_error', reason: err?.message ?? String(err) };
    }
  } else if (contentMode === 'raw') {
    // The frozen history bytes are the delivered content — no generation call,
    // no researcher rewriting. The fixture sizes (EA 1696 / EB 1739 / EN 1845
    // chars) sit inside the 2000-char channel budget; a larger history fails
    // loudly at the delivery budget gate instead of being truncated.
    sourceStage = 'raw-history';
    deliveredRepresentation = 'raw_history_text';
    generation.stage = 'raw-history';
    contentText = historyText;
    deliverable = historyText;
  }
  // contentMode 'none' (or E0+policy): sentinel freeze, empty delivery by design.
  const frozenCandidate = freezeCandidate({
    policyText: contentText,
    sourceStage,
    deliveredRepresentation,
  });

  // 2. Same-channel delivery. deliverPayload throws loudly when the frozen
  // bytes exceed the channel budget — truncation belongs to study design, not
  // to delivery, so an over-budget candidate is an honest arm failure.
  let delivery;
  try {
    delivery = deliverPayload({ armId, content: deliverable });
  } catch (err) {
    delivery = null;
    generation.failure = { kind: 'delivery_budget', reason: err?.message ?? String(err) };
  }

  // 3. Every opportunity through the interactive real actor + oracle.
  const adjudications = [];
  const actorInputs = [];
  const opportunityUsage = [];
  let fatal = null;
  for (const opp of allOpportunities(dataset)) {
    const taskText = opp.taskInstructions.join('\n');
    const goldRecord = goldFor(dataset, opp.probeId, opp.opportunityId);
    let effectiveDelivery = delivery;
    if (!effectiveDelivery) {
      // Delivery failed at budget gate: still run the actor with an explicit
      // empty-channel receipt so the opportunity is scored, never skipped.
      effectiveDelivery = deliverPayload({ armId, content: null });
    }
    const opportunityLedger = makeOppLedger(opp.opportunityId);
    // P1-01: route the transport-bound fetch's reserves through THIS
    // opportunity scope so per-opportunity caps are enforced at the same
    // outbound boundary (the transport holds the arm ledger's fetch).
    if (armLedger && opportunityLedger) armLedger.setActiveChild(opportunityLedger);
    let result;
    try {
      result = await runRealActorOpportunity({
        transport,
        environment: opp.environment,
        knownActionNames: KNOWN_ACTION_NAMES,
        manualText,
        taskText,
        delivery: effectiveDelivery,
        goldRecord,
        opportunityId: opp.opportunityId,
        caps,
        httpLedger: opportunityLedger,
      });
    } finally {
      if (armLedger) armLedger.clearActiveChild();
    }
    opportunityUsage.push({
      opportunityId: opp.opportunityId,
      ...result.usage,
      actorRunStatus: result.actorRunStatus,
      failure: result.failure,
      budget: opportunityLedger ? opportunityLedger.snapshot() : null,
    });
    actorInputs.push({
      historyId,
      probeId: opp.probeId,
      opportunityId: opp.opportunityId,
      leakageGroupId: dataset.probes[opp.probeId].leakageGroupId,
      historySynthetic: history.synthetic === true,
      visibleText: result.firstRoundPrompt ?? '(no round prompt composed — run failed before the first model call)',
    });
    adjudications.push(
      adjudicate({
        studyId,
        armId,
        probeId: opp.probeId,
        opportunityId: opp.opportunityId,
        goldRecord,
        outcome: result.outcome,
        actorRunStatus: result.actorRunStatus,
      }),
    );
    if (result.failure?.kind === 'invalid_protocol') {
      const row = adjudications[adjudications.length - 1];
      row.dataQualityFlag = 'INVALID_PROTOCOL';
      row.dataQualityReasons.push(result.failure.reason);
      fatal = { armId, opportunityId: opp.opportunityId, reason: result.failure.reason };
      break; // exitConditions: judge leak stops the study — do not proceed
    }
    if (generation.failure) {
      // Content generation failed but the actor still ran: record the
      // generation failure on every row's data quality (visible, not silent).
      const row = adjudications[adjudications.length - 1];
      row.dataQualityReasons.push(`${generation.stage}: ${generation.failure.kind} — ${generation.failure.reason}`);
    }
  }

  const arm = {
    armId,
    historyId,
    contentMode,
    strategyId: REAL_ACTOR_STRATEGY_ID,
    strategyKind: 'real-actor-i0',
    actorKind: 'real',
    allocationUnit: 'episode',
    informationCutoff: dataset.episode.informationCutoff,
    initialMemoryManifest: {
      schemaVersion: 'memory-manifest.v0.1',
      entries: [],
      note: 'lab real-actor arm — no external memory files; OD-authorized runs fingerprint real profiles via buildMemoryManifest before first run',
    },
    frozenCandidate,
    delivery,
    generation,
    usage: {
      caps,
      budgets,
      generationRequests: generation.requests,
      opportunities: opportunityUsage,
      // P1-01: arm-level HTTP budget snapshot (chain: opportunity → arm → study).
      budget: armLedger ? armLedger.snapshot() : null,
      // P1-03: per-request token audit (null usage rows stay explicit).
      tokenAudit: armLedger
        ? auditTokenUsage([...armLedger.requests(), ...opportunityLedgers.flatMap((l) => l.requests())])
        : null,
      // P1-01: retry/repair attribution (authorized Pi transports only — the
      // factory attaches telemetry counters to the ledger; null = not wired).
      retries: armLedger?.telemetry ? armLedger.telemetry.retries : null,
      repairs: armLedger?.telemetry ? armLedger.telemetry.repairs : null,
    },
  };

  return { arm, adjudications, actorInputs, usage: opportunityUsage, fatal };
}

/**
 * Run every real-actor arm on its OWN transport (cross-arm isolation), in the
 * given arm order. Stops at the first judge-leak INVALID_PROTOCOL (remaining
 * arms are not started — exitConditions) and reports `stopped`.
 *
 * Arms are given either as `armSpecs` ([{historyId, contentMode='policy'}] —
 * the C-A four-way contrast is four specs on one history) or as the legacy
 * `historyIds` (each implying contentMode 'policy'). The exact arm list and
 * order for a real study is the Owner's OD-3 decision; this runner only makes
 * any preregistered choice executable.
 *
 * TWO MUTUALLY EXCLUSIVE EXECUTION MODES — never mixed within one study
 * (a C-A contrast must not vary execution path across arms):
 *
 * 1. EXTERNAL (default): `transportForArm(historyId, armLedger, contentMode)`
 *    builds a pi-ai transport per arm; `budgets` = explicit HTTP request caps
 *    {httpRequestsPerOpportunity, httpRequestsPerArm, httpRequestsPerStudy,
 *    perRunCostCapUsd, totalCostCapUsd} enforced by the P1-01 HTTP/USD ledger.
 *    Null caps are record-only (offline rehearsal) and are NEVER a
 *    real-experiment authorization (P1-02 gate covers that).
 *
 * 2. HOST (`hostTransportFactory` provided): arms execute on the OWNER'S
 *    Codex CLI via lib/host-actor.mjs. The HTTP/USD ledger is NOT built and
 *    NEVER simulated for this path — the enforceable boundary is the PROCESS
 *    boundary (exec/session pre-spawn caps + observed token/wall feedback),
 *    carried by `hostBudgets`:
 *    {model, maxExecProcessesPerOpportunity, maxExecProcessesPerArm,
 *     maxExecProcessesPerStudy, maxSessionsPerArm, maxTokensPerOpportunity,
 *     maxTokensPerStudy, wallMsPerOpportunity, wallMsPerStudy,
 *     timeoutMsPerCall, profile, outputSchemaFile, extraArgs, threadSource}.
 *    The factory receives {historyId, contentMode, armId, scratchRoot,
 *    hostLedger, hostBudgets} and returns a transport exposing
 *    complete()/hostSnapshot(). Per-arm scratch directories are created under
 *    `scratchBase` (spawn cwd isolation; never the repo, never user data).
 *    An arm whose host snapshot is not identity-VERIFIED gets every row
 *    marked UNCERTAIN — such results are excluded from formal claims.
 */
export async function runRealStudy({ dataset, transportForArm, caps = DEFAULT_REAL_ACTOR_CAPS, studyId, historyIds = ['E0', 'EA', 'EB', 'EN'], armSpecs = null, budgets = null, hostTransportFactory = null, hostBudgets = null, scratchBase = null }) {
  if (transportForArm === undefined && hostTransportFactory === null) {
    throw new Error('runRealStudy: transportForArm or hostTransportFactory is required');
  }
  const specs = (armSpecs ?? historyIds.map((historyId) => ({ historyId, contentMode: 'policy' })))
    .map((spec) => (typeof spec === 'string' ? { historyId: spec, contentMode: 'policy' } : spec));
  const seenArmIds = new Set();
  for (const spec of specs) {
    if (!dataset.histories[spec.historyId]) {
      throw new Error(`runRealStudy: unknown historyId '${String(spec.historyId)}'`);
    }
    if (!REAL_CONTENT_MODES.includes(spec.contentMode)) {
      throw new Error(`runRealStudy: unknown contentMode '${String(spec.contentMode)}' for ${spec.historyId} (C-A conditions: ${REAL_CONTENT_MODES.join('|')})`);
    }
    const armId = realArmId(spec.historyId, spec.contentMode);
    if (seenArmIds.has(armId)) {
      throw new Error(`runRealStudy: duplicate arm ${armId} — one (history, condition) pairing may appear at most once`);
    }
    seenArmIds.add(armId);
  }
  const hostMode = hostTransportFactory !== null;
  if (hostMode) {
    if (hostBudgets === null || typeof hostBudgets !== 'object') {
      throw new Error('runRealStudy: host mode requires explicit hostBudgets (process caps are the ONLY cost boundary on the host path — they are never defaulted)');
    }
    if (budgets !== null) {
      throw new Error('runRealStudy: budgets (HTTP/USD caps) and hostTransportFactory are mutually exclusive — the host path must never be dressed up as metered HTTP traffic');
    }
    if (typeof hostBudgets.model !== 'string' || hostBudgets.model.trim().length === 0) {
      throw new Error('runRealStudy: hostBudgets.model (requested host model id) is required');
    }
  }
  const studyLedger = hostMode
    ? null // no HTTP ledger on the host path — and never a simulated one
    : createHttpBudgetLedger({
        scope: `study:${studyId}`,
        cap: budgets?.httpRequestsPerStudy ?? null,
        costCapUsd: budgets?.totalCostCapUsd ?? null,
        reason: 'study-level cumulative HTTP/USD cost cap',
      });
  const studyHostLedger = hostMode
    ? createHostProcessLedger({
        scope: `study:${studyId}:host`,
        caps: {
          maxExecProcesses: hostBudgets.maxExecProcessesPerStudy,
          maxTokens: hostBudgets.maxTokensPerStudy,
          wallMsBudgetMs: hostBudgets.wallMsPerStudy,
        },
        reason: 'study-level host process caps (exec/token-feedback/wall-clock)',
      })
    : null;
  const fs = hostMode ? await import('node:fs') : null;
  const os = hostMode ? await import('node:os') : null;
  const pathMod = hostMode ? await import('node:path') : null;
  const hostArmTransports = new Map();
  const arms = [];
  const adjudications = [];
  const actorInputs = [];
  let stopped = null;
  for (const spec of specs) {
    const armId = realArmId(spec.historyId, spec.contentMode);
    let armLedger = null;
    let transport;
    if (hostMode) {
      const sanitized = armId.replace(/[^A-Za-z0-9._-]+/g, '_');
      const base = scratchBase ?? pathMod.join(os.tmpdir(), 'pl-lab-host-scratch');
      fs.mkdirSync(base, { recursive: true });
      const scratchRoot = fs.mkdtempSync(pathMod.join(base, `${sanitized}-`));
      const armHostLedger = createHostProcessLedger({
        scope: armId,
        caps: {
          maxExecProcesses: hostBudgets.maxExecProcessesPerArm,
          maxSessions: hostBudgets.maxSessionsPerArm,
          maxTokens: hostBudgets.maxTokensPerArm ?? null,
          wallMsBudgetMs: hostBudgets.wallMsPerArm ?? null,
        },
        parent: studyHostLedger,
        reason: 'arm-level host process caps',
      });
      transport = hostTransportFactory({ historyId: spec.historyId, contentMode: spec.contentMode, armId, scratchRoot, hostLedger: armHostLedger, hostBudgets });
      hostArmTransports.set(armId, transport);
    } else {
      armLedger = createHttpBudgetLedger({
        scope: armId,
        cap: budgets?.httpRequestsPerArm ?? null,
        costCapUsd: budgets?.perRunCostCapUsd ?? null,
        parent: studyLedger,
        reason: 'arm-level HTTP/USD cost cap',
      });
      transport = transportForArm(spec.historyId, armLedger, spec.contentMode);
    }
    const r = await runRealArm({
      dataset,
      historyId: spec.historyId,
      contentMode: spec.contentMode,
      transport,
      caps,
      studyId,
      armLedger,
      budgets: hostMode ? null : budgets,
    });
    if (hostMode) {
      // Host audit surfaces ride the arm's usage block; the HTTP fields stay
      // null (no HTTP ledger exists on this path — none is invented).
      const snapshot = typeof transport.hostSnapshot === 'function' ? transport.hostSnapshot() : null;
      r.arm.usage.hostProcessBudget = snapshot;
      // Identity discipline: an arm whose host did not VERIFY the requested
      // model is excluded from formal results — rows stay (denominator rule)
      // but are flagged UNCERTAIN with the reason on every row.
      if (snapshot !== null && snapshot.identityStatus !== 'VERIFIED') {
        for (const row of r.adjudications) {
          row.dataQualityFlag = 'UNCERTAIN';
          row.dataQualityReasons.push(`host model identity ${snapshot.identityStatus} (requested ${snapshot.requestedModel}${snapshot.observedModel ? `, host reported ${snapshot.observedModel}` : ', host reported nothing'}) — excluded from formal results`);
        }
      }
    }
    arms.push(r.arm);
    adjudications.push(...r.adjudications);
    actorInputs.push(...r.actorInputs);
    if (r.fatal) {
      stopped = { atArm: r.arm.armId, ...r.fatal };
      break;
    }
  }
  return {
    arms,
    adjudications,
    actorInputs,
    stopped,
    budget: studyLedger ? studyLedger.snapshot() : null,
    hostBudget: studyHostLedger ? studyHostLedger.snapshot() : null,
  };
}
