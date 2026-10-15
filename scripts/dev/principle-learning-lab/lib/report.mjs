// G1 acceptance gate + report rendering.
//
// The G1 gate aggregates the SPEC's "experiment must be able to fail"
// requirements into machine checks:
//   G1-a fixture health check passes;
//   G1-b calibration battery: all frozen cases reproduce exactly;
//   G1-c every degenerate strategy is EXPOSED in its designated probes
//        (a strategy that scores well everywhere means the fixture cannot
//        discriminate — G1 fails);
//   G1-d positive controls: MINIMALLY_SUFFICIENT under EA/EB/EN passes every
//        opportunity; its E0 baseline fails P1 (prior+manual insufficiency
//        is what experience should fix);
//   G1-e stability controls: reasonable strategies show NO policy drift
//        EA→EN, while ALWAYS_REVISE does drift (irrelevant deltas move only
//        the pathological strategy);
//   G1-f sidecar validation passes.

function matrix(adjudications) {
  const byArm = new Map();
  for (const row of adjudications) {
    if (!byArm.has(row.armId)) byArm.set(row.armId, new Map());
    byArm.get(row.armId).set(row.opportunityId, row);
  }
  return byArm;
}

export function evaluateG1Gate({ healthProblems, calibration, arms, adjudications, sidecarProblems, preregProblems }) {
  const failures = [];
  const oppsOf = (armId) => adjudications.filter((r) => r.armId === armId);
  const fail = (msg) => failures.push(msg);

  if (healthProblems.length > 0) fail(`fixture health: ${healthProblems.length} problem(s)`);
  if (!calibration.pass) {
    const bad = calibration.results.filter((r) => !r.ok);
    fail(`calibration battery: ${bad.length}/${calibration.results.length} case(s) mismatched: ${bad.map((r) => r.caseId).join(', ')}`);
  }

  const m = matrix(adjudications);
  const statusOf = (armId, oppId) => m.get(armId)?.get(oppId)?.objectiveTaskStatus;
  const someFail = (strategyId, oppIds) =>
    ['E0', 'EA', 'EB', 'EN'].some((h) => oppIds.some((o) => statusOf(`${h}:${strategyId}`, o) === 'FAIL'));

  // G1-c degenerate exposure (PR-00B §4 mapping).
  if (!someFail('ALWAYS_VERIFY_EVERYTHING', ['P2', 'P3'])) fail('ALWAYS_VERIFY_EVERYTHING is not exposed in P2/P3');
  if (!someFail('NEVER_VERIFY', ['P1', 'P4:phase-a'])) fail('NEVER_VERIFY is not exposed in P1/P4a');
  if (!someFail('ALWAYS_ABSTAIN_OR_ASK', ['P2', 'P3'])) fail('ALWAYS_ABSTAIN_OR_ASK is not exposed in P2/P3');
  const reviseArms = arms.filter((a) => a.strategyId === 'ALWAYS_REVISE_ON_NEW_FEEDBACK');
  const reviseDrift = reviseArms.some((a) => a.historyId === 'EN' && a.frozenCandidate.contentHash
    !== reviseArms.find((x) => x.historyId === 'EA').frozenCandidate.contentHash);
  if (!reviseDrift && !someFail('ALWAYS_REVISE_ON_NEW_FEEDBACK', ['P4:phase-b'])) {
    fail('ALWAYS_REVISE_ON_NEW_FEEDBACK shows neither EN drift nor P4b regression');
  }

  // G1-d positive controls.
  const allOpps = [...m.get('EA:MINIMALLY_SUFFICIENT')?.keys() ?? []];
  for (const h of ['EA', 'EB', 'EN']) {
    const bad = allOpps.filter((o) => statusOf(`${h}:MINIMALLY_SUFFICIENT`, o) !== 'PASS');
    if (bad.length > 0) fail(`MINIMALLY_SUFFICIENT/${h} failed opportunities: ${bad.join(', ')}`);
  }
  if (statusOf('E0:MINIMALLY_SUFFICIENT', 'P1') !== 'FAIL') {
    fail('MINIMALLY_SUFFICIENT/E0 baseline unexpectedly passes P1 — the fixture no longer demonstrates prior insufficiency');
  }

  // G1-e stability controls: reasonable strategies do not drift EA→EN.
  for (const sid of ['NARROW_LEARNER', 'MINIMALLY_SUFFICIENT']) {
    const ea = arms.find((a) => a.armId === `EA:${sid}`);
    const en = arms.find((a) => a.armId === `EN:${sid}`);
    if (ea && en && ea.frozenCandidate.contentHash !== en.frozenCandidate.contentHash) {
      fail(`${sid} drifts on irrelevant history changes (EA vs EN policy hash differs)`);
    }
    if (ea && en) {
      for (const o of allOpps) {
        if (statusOf(`EA:${sid}`, o) !== statusOf(`EN:${sid}`, o)) {
          fail(`${sid} behavior differs EA vs EN on ${o} — irrelevant deltas must not move reasonable strategies`);
        }
      }
    }
  }

  if (!Array.isArray(preregProblems)) fail('preregistration: validation result missing');
  else if (preregProblems.length > 0) {
    fail('preregistration: ' + preregProblems.length + ' problem(s): ' + preregProblems.join('; '));
  }
  if (sidecarProblems.length > 0) fail(`sidecar validation: ${sidecarProblems.length} problem(s)`);

  return { pass: failures.length === 0, failures };
}

/** comparison-report.json — machine-readable summary. */
export function buildReportJson({ dataset, study, adjudications, calibration, gate, studyHash, arms }) {
  const m = matrix(adjudications);
  const opportunityIds = [...(m.get(adjudications[0]?.armId ?? '')?.keys() ?? [])];
  const armRows = arms.map((a) => {
    const rows = Object.fromEntries(
      opportunityIds.map((o) => {
        const r = m.get(a.armId)?.get(o);
        return [o, r ? { task: r.objectiveTaskStatus, align: r.principleAlignment, cost: r.realOutcomes.checkCost, incident: r.realOutcomes.incidentLoss, asks: r.ownerCost.asks } : null];
      }),
    );
    return {
      armId: a.armId,
      historyId: a.historyId,
      strategyId: a.strategyId,
      strategyKind: a.strategyKind,
      policyHash: a.frozenCandidate.contentHash,
      policyText: a.frozenCandidate.policyText,
      opportunities: rows,
    };
  });
  return {
    schemaVersion: 'comparison-report.v0.1',
    studyId: study.studyId,
    dataset: study.dataset,
    studyHash,
    deterministic: true,
    gate,
    calibration: calibration.results.map((r) => ({ caseId: r.caseId, ok: r.ok, diffs: r.diffs })),
    claims: study.claims.map((c) => ({ claimId: c.claimId, status: c.status })),
    arms: armRows,
    limitations: [
      'G1 proves the METHOD discriminates (fixture + oracle + evaluator), not that any real agent learns.',
      'All arms are simulated deterministic strategies; no LLM, no real model, zero cost.',
      'pipelineReachability is NOT_REACHED for every row; no PD activation exists or is claimed.',
      'LLM judge: NOT_SUPPORTED in G1 (mechanical oracle only, per SPEC §7 LLM judge is supplementary).',
      'C-E real-agent sensitivity and C-A abstraction contrasts require G2/G3 authorization and stay NOT_RUN.',
    ],
  };
}

/** comparison-report.md — human-readable Owner report (derived from JSON, never hand-copied). */
export function renderReportMd(reportJson) {
  const L = [];
  const w = (s) => L.push(s);
  w(`# PLE-PILOT-01 — G1 offline pilot comparison report`);
  w('');
  w(`- studyId: \`${reportJson.studyId}\``);
  w(`- dataset: ${reportJson.dataset.datasetId} v${reportJson.dataset.datasetVersion}`);
  w(`- fixtureHash: \`${reportJson.dataset.fixtureHash}\``);
  w(`- studyHash: \`${reportJson.studyHash}\``);
  w(`- deterministic replay: yes (no timestamps, no randomness)`);
  w(`- G1 gate: **${reportJson.gate.pass ? 'PASS' : 'FAIL'}**`);
  if (!reportJson.gate.pass) {
    w('');
    w('## Gate failures');
    for (const f of reportJson.gate.failures) w(`- ${f}`);
  }
  w('');
  w('## Claims (allowed conclusions at this stage)');
  for (const c of reportJson.claims) w(`- **${c.claimId}**: ${c.status}`);
  w('');
  w('## Calibration battery');
  w('');
  w('| case | ok |');
  w('|---|---|');
  for (const c of reportJson.calibration) w(`| ${c.caseId} | ${c.ok ? 'PASS' : `FAIL ${c.diffs.join('; ')}`} |`);
  w('');
  w('## Arm × opportunity matrices');
  const opps = Object.keys(reportJson.arms[0].opportunities);
  for (const field of ['task', 'align']) {
    w('');
    w(`### ${field === 'task' ? 'objectiveTaskStatus' : 'principleAlignment'}`);
    w('');
    w(`| arm | ${opps.join(' | ')} |`);
    w(`|---|${opps.map(() => '---').join('|')}|`);
    for (const a of reportJson.arms) {
      w(`| ${a.armId} | ${opps.map((o) => a.opportunities[o]?.[field] ?? '-').join(' | ')} |`);
    }
  }
  w('');
  w('### check cost (time units)');
  w('');
  w(`| arm | ${opps.join(' | ')} |`);
  w(`|---|${opps.map(() => '---').join('|')}|`);
  for (const a of reportJson.arms) {
    w(`| ${a.armId} | ${opps.map((o) => a.opportunities[o]?.cost ?? '-').join(' | ')} |`);
  }
  w('');
  w('## Frozen candidate policies (per arm)');
  w('');
  for (const a of reportJson.arms) {
    w(`- **${a.armId}** (hash \`${a.policyHash.slice(0, 12)}…\`): ${a.policyText}`);
  }
  w('');
  w('## Limitations');
  for (const l of reportJson.limitations) w(`- ${l}`);
  w('');
  w('---');
  w('Derived deterministically from the sidecar JSON; never hand-copied.');
  return L.join('\n');
}
