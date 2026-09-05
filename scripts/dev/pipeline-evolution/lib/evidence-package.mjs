// PRI-685 Evidence Foundation — pure derivation library for evidence packages.
//
// Everything here is a pure function of (collected report, manifest): no DB,
// no fs, no clock, no random. That is what makes the package recomputable —
// the same collected JSON always derives the same index/metrics/trace/report
// (SPEC §Problem 3 / AC4), and tests can exercise derivation directly.
//
// Two-layer status vocabulary (audit §3.2 — do not merge them):
//   bucket  (fact layer)   PASS / FAIL / UNKNOWN / PENDING / BLOCKED_OWNER / REPAIR
//                          — bound to tasks.status semantics by collect-evidence
//   status  (claim layer)  CONFIRMED / NOT_CONFIRMED / UNKNOWN / BLOCKED / INVALID
//                          — SPEC §8 vocabulary, derived here from facts + evidence
//
// Layer discipline (SPEC §Problem 2): a stage that was never reached is
// UNKNOWN, never FAIL; missing evidence can never derive a PASS (AC2/AC3).

export const EVIDENCE_INDEX_SCHEMA = 'evidence-index.v1';
export const METRICS_SCHEMA = 'metrics.v1';
export const PIPELINE_TRACE_SCHEMA = 'pipeline-trace.v1';

// ---------------------------------------------------------------------------
// Evidence index — every claim names its evidence or admits it has none.
// ---------------------------------------------------------------------------

function evidence(source, id, detail) {
  return detail === undefined ? { source, id } : { source, id, detail };
}

function chainTasksOfKind(chain, kinds) {
  const set = new Set(kinds);
  return chain.stages.filter((s) => set.has(s.kind));
}

function anyChain(report, predicate) {
  const chains = report.chains ?? [];
  const hit = chains.find(predicate);
  return { hit: hit ?? null, chains };
}

function principleArtifactsOf(report) {
  // phi/plan artifacts surface per chain; artifact export keeps the raw rows —
  // here we only need "did a principle artifact get produced and by which task".
  const out = [];
  for (const chain of report.chains ?? []) {
    for (const art of chain.artifacts ?? []) out.push({ chain: chain.correlation, ...art });
  }
  return out;
}

export function buildEvidenceIndex(report, manifest) {
  const claims = [];
  const pains = report.trajectory?.pains ?? [];
  const chains = report.chains ?? [];
  const sessionIds = Array.isArray(manifest?.sessionIds) ? manifest.sessionIds : [];

  // -- pain_captured: a pain_events row exists, bound to an experiment session.
  if (pains.length > 0) {
    claims.push({
      claim: 'pain_captured',
      status: 'CONFIRMED',
      evidence: pains.map((p) =>
        evidence('trajectory.db/pain_events', p.canonical_pain_id ?? p.id ?? null, `session=${p.session_id ?? '?'} score=${p.score ?? '?'}`),
      ),
    });
  } else if (sessionIds.length > 0) {
    claims.push({
      claim: 'pain_captured',
      status: 'NOT_CONFIRMED',
      evidence: [evidence('manifest', null, 'sessionIds bound but no pain_events rows matched the experiment scope')],
    });
  } else {
    claims.push({
      claim: 'pain_captured',
      status: 'UNKNOWN',
      evidence: [evidence('manifest', null, 'no sessionIds in manifest — cannot scope pain_events')],
    });
  }

  // -- pain_admitted: the pain entered the pipeline (a diagnosis task exists).
  // With a scope (sessionIds/painIds) and no diagnosis task, admission did
  // NOT happen → NOT_CONFIRMED; with no scope at all the claim is undecidable.
  const diagnosisTasks = [];
  for (const c of chains) for (const s of chainTasksOfKind(c, ['diagnostician'])) diagnosisTasks.push({ chain: c.correlation, ...s });
  // The diagnosis half of the chain is joined via candidate.task_id, so its
  // presence in chains[] already proves the pain was admitted for that chain.
  if (diagnosisTasks.length > 0) {
    claims.push({
      claim: 'pain_admitted',
      status: 'CONFIRMED',
      evidence: diagnosisTasks.map((t) => evidence('state.db/tasks', t.taskId, `status=${t.status}`)),
    });
  } else if (sessionIds.length > 0 || (manifest?.painIds ?? []).length > 0) {
    claims.push({
      claim: 'pain_admitted',
      status: 'NOT_CONFIRMED',
      evidence: [evidence('state.db/tasks', null, 'scoped experiment has no diagnosis task — pain never entered the pipeline')],
    });
  } else {
    claims.push({
      claim: 'pain_admitted',
      status: 'UNKNOWN',
      evidence: [evidence('state.db/tasks', null, 'no pain scope in manifest — admission undecidable')],
    });
  }

  // -- diagnosis_completed
  const diag = anyChain(report, (c) => c.matrix?.diagnosis === 'PASS');
  if (diag.hit) {
    const tasks = chainTasksOfKind(diag.hit, ['diagnostician', 'diag_rootcause', 'diag_distiller', 'diag_router']);
    claims.push({
      claim: 'diagnosis_completed',
      status: 'CONFIRMED',
      evidence: tasks.map((t) => evidence('state.db/tasks', t.taskId, `status=${t.status}`)),
    });
  } else if (anyChain(report, (c) => c.matrix?.diagnosis === 'FAIL').hit) {
    const failed = [];
    for (const c of diag.chains) for (const s of chainTasksOfKind(c, ['diagnostician', 'diag_rootcause', 'diag_distiller', 'diag_router'])) failed.push(s);
    claims.push({
      claim: 'diagnosis_completed',
      status: 'NOT_CONFIRMED',
      evidence: failed
        .filter((t) => t.status === 'failed')
        .map((t) => evidence('state.db/tasks', t.taskId, 'status=failed')),
    });
  } else {
    claims.push({ claim: 'diagnosis_completed', status: 'UNKNOWN', evidence: [] });
  }

  // -- principle_generated: peer stages produced principle artifacts.
  const principleArts = principleArtifactsOf(report).filter((a) => (a.kind ?? '') === 'principle');
  const principleStage = anyChain(report, (c) => c.matrix?.principle === 'PASS');
  if (principleArts.length > 0 || principleStage.hit) {
    const ev = principleArts.map((a) => evidence('state.db/pi_artifacts', a.id, `kind=principle chain=${a.chain}`));
    if (ev.length === 0 && principleStage.hit) {
      for (const s of chainTasksOfKind(principleStage.hit, ['dreamer', 'philosopher', 'scribe'])) {
        ev.push(evidence('state.db/tasks', s.taskId, `status=${s.status}`));
      }
    }
    claims.push({ claim: 'principle_generated', status: 'CONFIRMED', evidence: ev });
  } else if (anyChain(report, (c) => c.matrix?.principle === 'FAIL').hit) {
    const failedPeer = [];
    for (const c of chains) for (const s of chainTasksOfKind(c, ['dreamer', 'philosopher', 'scribe'])) if (s.status === 'failed') failedPeer.push(s);
    claims.push({ claim: 'principle_generated', status: 'NOT_CONFIRMED', evidence: failedPeer.map((t) => evidence('state.db/tasks', t.taskId, 'status=failed')) });
  } else {
    claims.push({ claim: 'principle_generated', status: 'UNKNOWN', evidence: [] });
  }

  // -- rule_generated
  const ruleStage = anyChain(report, (c) => c.matrix?.rule === 'PASS');
  if (ruleStage.hit) {
    const tasks = chainTasksOfKind(ruleStage.hit, ['artificer', 'artificer-repair', 'artificer_repair']);
    const arts = (ruleStage.hit.artifacts ?? []).filter((a) => (a.kind ?? '').includes('rule'));
    claims.push({
      claim: 'rule_generated',
      status: 'CONFIRMED',
      evidence: [
        ...tasks.filter((t) => t.status === 'succeeded').map((t) => evidence('state.db/tasks', t.taskId, 'status=succeeded')),
        ...arts.map((a) => evidence('state.db/pi_artifacts', a.id, a.kind)),
      ],
    });
  } else if (anyChain(report, (c) => c.matrix?.rule === 'FAIL').hit) {
    const failedArtificer = [];
    for (const c of chains) for (const s of chainTasksOfKind(c, ['artificer'])) if (s.status === 'failed') failedArtificer.push(s);
    claims.push({
      claim: 'rule_generated',
      status: 'NOT_CONFIRMED',
      evidence: [
        ...failedArtificer.map((t) => evidence('state.db/tasks', t.taskId, 'status=failed')),
        ...chains.flatMap((c) => (c.failures ?? []).filter((f) => (f.taskId ?? '').includes('artificer')).map((f) => evidence('state.db/runs', f.taskId, f.reason ?? ''))),
      ],
    });
  } else {
    claims.push({ claim: 'rule_generated', status: 'UNKNOWN', evidence: [] });
  }

  // -- replay_executed: adversarial replay REALLY executed (telemetry is the
  // authority — it distinguishes "gate judged" from "gate unreachable",
  // PRI-634 R4). Absent events can never be FAIL: unreachable ≠ not executed
  // on purpose; it stays UNKNOWN.
  const adv = report.adversarialEvents ?? [];
  if (adv.length > 0) {
    claims.push({
      claim: 'replay_executed',
      status: 'CONFIRMED',
      evidence: adv.map((e) => evidence('.pd/telemetry/critical-events.jsonl', e.eventType ?? null, `${e.timestamp ?? '?'} ${e.payload ?? ''}`)),
    });
  } else {
    claims.push({
      claim: 'replay_executed',
      status: 'UNKNOWN',
      evidence: [evidence('.pd/telemetry/critical-events.jsonl', null, 'no evaluator_adversarial* events in scope — cannot distinguish not-reached from gate-unreachable')],
    });
  }

  // -- owner_decision: resolved decision CONFIRMED; waiting point BLOCKED.
  const approvals = chains.flatMap((c) => c.approvals ?? []);
  const decided = approvals.filter((a) => (a.status ?? '') !== 'pending' && a.decided_at);
  const pending = approvals.filter((a) => (a.status ?? '') === 'pending');
  const waitingTasks = chains.flatMap((c) => c.stages.filter((s) => s.status === 'needs_human_review'));
  if (decided.length > 0) {
    claims.push({
      claim: 'owner_decision',
      status: 'CONFIRMED',
      evidence: decided.map((a) => evidence('state.db/approvals', a.approval_id, `status=${a.status} at=${a.decided_at}`)),
    });
  } else if (pending.length > 0 || waitingTasks.length > 0) {
    claims.push({
      claim: 'owner_decision',
      status: 'BLOCKED',
      evidence: [
        ...pending.map((a) => evidence('state.db/approvals', a.approval_id, 'status=pending')),
        ...waitingTasks.map((t) => evidence('state.db/tasks', t.taskId, 'status=needs_human_review')),
      ],
    });
  } else {
    claims.push({ claim: 'owner_decision', status: 'UNKNOWN', evidence: [] });
  }

  // -- activation
  const totalActivations = chains.reduce((n, c) => n + (c.activationCount ?? 0), 0);
  const rejected = approvals.filter((a) => (a.status ?? '').startsWith('reject'));
  if (totalActivations > 0) {
    claims.push({
      claim: 'activation',
      status: 'CONFIRMED',
      evidence: chains.filter((c) => (c.activationCount ?? 0) > 0).map((c) => evidence('state.db/activations', c.correlation, `count=${c.activationCount}`)),
    });
  } else if (rejected.length > 0) {
    claims.push({
      claim: 'activation',
      status: 'NOT_CONFIRMED',
      evidence: rejected.map((a) => evidence('state.db/approvals', a.approval_id, `status=${a.status} — governed rejection, not a pipeline failure`)),
    });
  } else {
    claims.push({ claim: 'activation', status: 'UNKNOWN', evidence: [] });
  }

  // -- behavior_change: highest tier. Without activation the claim is
  // NOT_REACHED by construction (SPEC §10 — no behavior improvement may be
  // claimed without activation). With activation: only an operator-recorded
  // observation (manifest.behaviorObservation, Phase-4 re-run) can CONFIRM;
  // otherwise INCONCLUSIVE.
  let behavior;
  if (totalActivations === 0) {
    behavior = { status: 'NOT_REACHED', evidence: [evidence('state.db/activations', null, 'no activation in scope — behavior claim not reachable')] };
  } else {
    const obs = manifest?.behaviorObservation;
    if (obs && (obs.status === 'CONFIRMED' || obs.status === 'INCONCLUSIVE')) {
      behavior = { status: obs.status, evidence: (obs.evidence ?? []).map((e) => evidence('manifest.behaviorObservation', e.source ?? null, e.detail ?? '')) };
    } else {
      behavior = { status: 'INCONCLUSIVE', evidence: [evidence('manifest.behaviorObservation', null, 'activation present but no Phase-4 behavior observation recorded')] };
    }
  }
  claims.push({ claim: 'behavior_change', status: behavior.status, evidence: behavior.evidence });

  return {
    schemaVersion: EVIDENCE_INDEX_SCHEMA,
    experimentId: manifest?.experimentId ?? null,
    evidenceIntegrity: evidenceIntegrity(report, manifest),
    claims,
  };
}

// Linkage integrity (SPEC §11): every experiment pain is session-bound, every
// in-scope candidate links to a diagnosis task, every chain maps to a
// candidate, every artifact's source task exists. A chain that simply ends
// early is NOT an integrity gap (that is UNKNOWN, not INVALID).
function evidenceIntegrity(report, manifest) {
  const gaps = [];
  const pains = report.trajectory?.pains ?? [];
  const sessionIds = new Set(Array.isArray(manifest?.sessionIds) ? manifest.sessionIds : []);

  for (const p of pains) {
    if (!p.session_id) gaps.push(`pain ${p.id ?? '?'} has no session binding`);
    else if (sessionIds.size > 0 && !sessionIds.has(p.session_id)) {
      gaps.push(`pain ${p.id ?? '?'} session ${p.session_id} is outside manifest.sessionIds`);
    }
  }
  for (const c of report.candidates ?? []) {
    if (c.task_id && !String(c.task_id).includes('diagnosis_')) {
      gaps.push(`candidate ${c.candidate_id ?? '?'} task ${c.task_id} is not diagnosis-linked`);
    }
  }
  const knownTaskIds = new Set((report.chains ?? []).flatMap((c) => (c.stages ?? []).map((s) => s.taskId)));
  for (const chain of report.chains ?? []) {
    for (const a of chain.artifacts ?? []) {
      if (a.sourceTaskId && !knownTaskIds.has(a.sourceTaskId)) {
        gaps.push(`artifact ${a.id} source task ${a.sourceTaskId} missing from collected chain tasks`);
      }
    }
  }
  return { status: gaps.length === 0 ? 'VALID' : 'INVALID', gaps };
}

// ---------------------------------------------------------------------------
// Metric contract (SPEC §10) — pipeline / governance / behavior matrix.
// ---------------------------------------------------------------------------

export function buildMetrics(report, index) {
  const byClaim = new Map((index.claims ?? []).map((c) => [c.claim, c]));
  const statusOf = (name) => byClaim.get(name)?.status ?? 'UNKNOWN';

  // Pipeline metrics: CONFIRMED→PASS, NOT_CONFIRMED→FAIL, BLOCKED→WAIT (owner
  // row) — everything else stays UNKNOWN (audit §3.3: never force FAIL when a
  // stage was simply not reached).
  const mapPassFail = (s) => (s === 'CONFIRMED' ? 'PASS' : s === 'NOT_CONFIRMED' ? 'FAIL' : 'UNKNOWN');
  const pipeline = [
    { metric: 'pain_captured', status: statusOf('pain_captured') === 'CONFIRMED' ? 'PASS' : 'UNKNOWN' },
    { metric: 'diagnosis_completed', status: mapPassFail(statusOf('diagnosis_completed')) },
    { metric: 'principle_generated', status: mapPassFail(statusOf('principle_generated')) },
    { metric: 'rule_generated', status: mapPassFail(statusOf('rule_generated')) },
    { metric: 'replay_executed', status: mapPassFail(statusOf('replay_executed')) },
    { metric: 'owner_decision', status: statusOf('owner_decision') === 'CONFIRMED' ? 'PASS' : statusOf('owner_decision') === 'BLOCKED' ? 'WAIT' : 'UNKNOWN' },
    { metric: 'activation', status: mapPassFail(statusOf('activation')) },
  ];

  const chains = report.chains ?? [];
  const governance = {
    // Correct rejections are pipeline WINS, counted separately from failures.
    invalidRuleRejected: chains.filter((c) => c.matrix?.rule === 'FAIL' || c.matrix?.validation === 'FAIL').length,
    ownerApprovalRequired: chains.reduce(
      (n, c) => n + (c.approvalPending ?? 0) + (c.stages ?? []).filter((s) => s.status === 'needs_human_review').length,
      0,
    ),
    needsRevisionTriggered: chains.reduce(
      (n, c) => n + (c.stages ?? []).filter((s) => s.status === 'needs_revision' || (s.taskId ?? '').includes('-repair-')).length,
      0,
    ),
    note: '正确拒绝不是失败 — governance counters describe the governance surface exercised, not defects.',
  };

  const behaviorClaim = byClaim.get('behavior_change');
  return {
    schemaVersion: METRICS_SCHEMA,
    pipeline,
    governance,
    behavior: { status: behaviorClaim?.status ?? 'UNKNOWN' },
  };
}

// ---------------------------------------------------------------------------
// Pipeline trace (SPEC §9) — per chain, stage → artifact/evidence anchors.
// ---------------------------------------------------------------------------

const TRACE_STAGES = [
  { stage: 'pain', kinds: ['diagnostician'] },
  { stage: 'diagnosis', kinds: ['diag_rootcause', 'diag_distiller', 'diag_router'] },
  { stage: 'principle', kinds: ['dreamer', 'philosopher', 'scribe'] },
  { stage: 'rule', kinds: ['artificer', 'artificer-repair', 'artificer_repair'] },
  { stage: 'evaluation', kinds: ['evaluator', 'evaluator-repair', 'evaluator_repair', 'rollout_reviewer'] },
];

export function buildPipelineTrace(report) {
  const chains = [];
  for (const c of report.chains ?? []) {
    const stages = [];
    const painRef = c.painId ? [{ source: 'trajectory.db/pain_events', id: c.painId }] : [];
    stages.push({ stage: 'pain', status: c.matrix?.pain ?? 'UNKNOWN', artifactIds: [], evidence: painRef });
    for (const def of TRACE_STAGES.slice(1)) {
      const tasks = chainTasksOfKind(c, def.kinds);
      const worst = tasks.reduce(
        (acc, t) => {
          if (t.bucket === 'FAIL' || acc === 'FAIL') return 'FAIL';
          if (t.bucket === 'BLOCKED_OWNER' || acc === 'BLOCKED_OWNER') return 'BLOCKED_OWNER';
          if (t.bucket === 'PENDING' || acc === 'PENDING') return 'PENDING';
          return tasks.some((x) => x.bucket === 'PASS') ? 'PASS' : acc === 'PASS' ? 'PASS' : 'UNKNOWN';
        },
        'UNKNOWN',
      );
      stages.push({
        stage: def.stage,
        status: tasks.length === 0 ? 'UNKNOWN' : worst,
        artifactIds: (c.artifacts ?? []).filter((a) => tasks.some((t) => a.sourceTaskId === t.taskId)).map((a) => a.id),
        evidence: tasks.map((t) => ({ source: 'state.db/tasks', id: t.taskId })),
      });
    }
    stages.push({ stage: 'owner_decision', status: c.matrix?.validation === 'BLOCKED_OWNER' || (c.approvals ?? []).length ? ((c.approvals ?? []).some((a) => a.status !== 'pending') ? 'PASS' : 'WAIT') : 'UNKNOWN', artifactIds: (c.approvals ?? []).map((a) => a.artifact_id), evidence: (c.approvals ?? []).map((a) => ({ source: 'state.db/approvals', id: a.approval_id })) });
    stages.push({ stage: 'activation', status: (c.activationCount ?? 0) > 0 ? 'PASS' : 'UNKNOWN', artifactIds: [], evidence: (c.activationCount ?? 0) > 0 ? [{ source: 'state.db/activations', id: c.correlation }] : [] });
    stages.push({ stage: 'behavior', status: 'UNKNOWN', artifactIds: [], evidence: [] }); // Phase-4 territory, never derived here
    chains.push({ correlation: c.correlation, painId: c.painId ?? null, failureLayer: c.failureLayer ?? 'unknown', stages });
  }
  return { schemaVersion: PIPELINE_TRACE_SCHEMA, chains };
}

// ---------------------------------------------------------------------------
// Owner review report (SPEC §15) — deterministic markdown from package data.
// ---------------------------------------------------------------------------

function claimRow(c) {
  return `| ${c.claim} | ${c.status} | ${c.evidence.length} |`;
}

export function renderOwnerReview(pkg) {
  const m = pkg.manifest ?? {};
  const idx = pkg.evidenceIndex ?? { claims: [], evidenceIntegrity: { status: 'UNKNOWN', gaps: [] } };
  const metrics = pkg.metrics ?? { pipeline: [], governance: {}, behavior: {} };
  const lines = [];
  lines.push(`# Evidence Package — ${m.experimentId ?? '(unnamed experiment)'}`);
  lines.push('');
  lines.push('## Experiment');
  lines.push('');
  lines.push(`- scenario: ${m.scenarioId ?? '?'}${m.scenarioVersion ? ` (v${m.scenarioVersion})` : ''}`);
  lines.push(`- window: ${m.startedAt ?? '?'} → ${m.finishedAt ?? '(open)'}`);
  lines.push(`- sessions: ${(m.sessionIds ?? []).length ? (m.sessionIds ?? []).join(', ') : '(none recorded)'}`);
  lines.push('');
  lines.push('## Environment');
  lines.push('');
  lines.push(`- PD commit: ${m.pdCommit ?? '?'}`);
  if (m.pdCoreVersion || m.pdPluginVersion) lines.push(`- PD versions: core ${m.pdCoreVersion ?? '?'} / plugin ${m.pdPluginVersion ?? '?'}`);
  lines.push(`- host: ${m.host ?? '?'}${m.hostVersion ? ` ${m.hostVersion}` : ''}`);
  const model = m.model ?? {};
  lines.push(`- model: ${model.provider ?? '?'}/${model.name ?? '?'}${model.thinking ? ` (thinking ${model.thinking})` : ''}`);
  lines.push(`- evidence integrity: **${idx.evidenceIntegrity?.status ?? 'UNKNOWN'}**${(idx.evidenceIntegrity?.gaps ?? []).length ? ` — ${idx.evidenceIntegrity.gaps.length} gap(s)` : ''}`);
  lines.push('');
  lines.push('## Evidence (claim → evidence count)');
  lines.push('');
  lines.push('| claim | status | evidence |');
  lines.push('|---|---|---|');
  for (const c of idx.claims ?? []) lines.push(claimRow(c));
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push('| pipeline metric | status |');
  lines.push('|---|---|');
  for (const p of metrics.pipeline ?? []) lines.push(`| ${p.metric} | ${p.status} |`);
  lines.push('');
  const g = metrics.governance ?? {};
  lines.push(`governance: invalidRuleRejected=${g.invalidRuleRejected ?? 0} · ownerApprovalRequired=${g.ownerApprovalRequired ?? 0} · needsRevisionTriggered=${g.needsRevisionTriggered ?? 0}（正确拒绝不是失败）`);
  lines.push('');
  lines.push(`behavior: ${metrics.behavior?.status ?? 'UNKNOWN'}`);
  lines.push('');
  const confirmed = (idx.claims ?? []).filter((c) => c.status === 'CONFIRMED').map((c) => c.claim);
  const unknown = (idx.claims ?? []).filter((c) => c.status === 'UNKNOWN' || c.status === 'NOT_REACHED').map((c) => c.claim);
  const notConfirmed = (idx.claims ?? []).filter((c) => c.status === 'NOT_CONFIRMED' || c.status === 'BLOCKED').map((c) => c.claim);
  lines.push('## Summary');
  lines.push('');
  lines.push(`- confirmed: ${confirmed.length ? confirmed.join(', ') : '(none)'}`);
  lines.push(`- not confirmed / blocked: ${notConfirmed.length ? notConfirmed.join(', ') : '(none)'}`);
  lines.push(`- unknown / not reached: ${unknown.length ? unknown.join(', ') : '(none)'}`);
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  lines.push(
    idx.evidenceIntegrity?.status === 'INVALID'
      ? '证据链存在关联缺口（见 evidence-index.json gaps）——先修复数据绑定，再谈结论。'
      : '结论以上表为准；UNKNOWN 项按 AC3 如实保留，不得在报告外升级为 PASS。',
  );
  lines.push('');
  return lines.join('\n');
}
