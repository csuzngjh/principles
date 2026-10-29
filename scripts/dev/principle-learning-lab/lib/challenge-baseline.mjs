// SPEC-PD-EXAMINER-001 v0.4 §6.4 / §12 — the FORMAL realHostBaseline entry.
//
// deriveRealHostBaseline (challenge-stage-r-gate.mjs) is the pure classifier;
// THIS module is the official study-level derivation, and it is deliberately
// harder to satisfy than the classifier alone:
//
//   1. the authorization comes from the study's own run-authorization.json
//      (readStageRAuthorization) — no caller-passed record; a study whose
//      authority file is absent / NOT_AUTHORIZED / not F2 has NO formal
//      baseline, whatever its attempt files claim;
//   2. the attempts come from the study's own runs/ files, and each must be
//      lineage-consistent with the freshly recomputed frozen study and the
//      authorization's bound actor identity (deriveRealHostBaseline
//      `expected`);
//   3. every observed hostSessionId is corroborated against the HOST'S OWN
//      rollout files (readRolloutEvidenceForSession over CODEX_HOME/sessions)
//      — record fields alone (a session id string, an identity string, an
//      `identityStatus: 'VERIFIED'` claim) NEVER establish real-host
//      acceptance. A wiring double that fabricates those strings fails here.
//
// Honest boundary (no overclaim): this is corroboration by the host's own
// evidence artifacts, NOT cryptography. An attacker who can write the host's
// rollout files can forge corroboration — that is machine access, beyond the
// cooperative boundary this lab declares (same class as the workspace lease).
// What is machine-enforced: string-level forgery — fake sessions, fake
// identities, fake VERIFIED claims, mock transports — can never produce a
// formal PASS.

import fs from 'node:fs';
import path from 'node:path';
import { readStageRAuthorization, deriveRealHostBaseline } from './challenge-stage-r-gate.mjs';
import { verifyFrozenStudy } from './challenge-runner.mjs';
import { readRolloutEvidenceForSession } from './host-actor.mjs';
import { readOpenClawExecStateTrajectory } from './challenge-openclaw-host.mjs';

function readAttemptFiles(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const attempts = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (parsed && typeof parsed === 'object') attempts.push(parsed);
      } catch { /* torn/corrupt attempt file — never parsed as truth */ }
    }
  };
  walk(runsDir);
  return attempts;
}

/**
 * Formal realHostBaseline for a study directory. Never throws — every
 * failure mode is a structured { status, reasons } verdict.
 *
 * Corroboration dispatch follows the authorization's probe binding hostKind:
 *   - 'openclaw' → each attempt's hostEvidence (kind 'openclaw-exec-state',
 *     recorded at execution time by the F2 actor adapter) is corroborated
 *     against the OpenClaw runtime's OWN per-round state database
 *     (readOpenClawExecStateTrajectory; trustedRoot = the recorded stateDir);
 *   - anything else → the historical codex path (rollout files under
 *     codexHome), unchanged.
 *
 * `codexHome` is REQUIRED for the codex path; the openclaw path needs no
 * home (the exec-state db travels with the attempt evidence).
 */
export function deriveRealHostBaselineFromStudy(studyDir, { codexHome } = {}) {
  const notEstimable = (reason) => ({ status: 'NOT_ESTIMABLE', reasons: [reason] });

  let bindings;
  try {
    bindings = verifyFrozenStudy(studyDir);
  } catch (e) {
    return notEstimable(`frozen study drift — a formal real-host baseline is not derivable from a drifted study: ${e.message}`);
  }

  const auth = readStageRAuthorization(studyDir);
  if (!auth || auth.status !== 'APPROVED' || auth.executionMode !== 'F2-real-host') {
    return notEstimable('no APPROVED F2-real-host authorization on record (run-authorization.json) — a formal real-host baseline requires an Owner-issued F2 authorization, not attempt-file claims');
  }

  const attempts = readAttemptFiles(path.join(studyDir, 'runs'));
  const verdict = deriveRealHostBaseline({
    attempts,
    expected: { suiteHash: bindings.suiteHash, requestedActorIdentity: typeof auth.requestedActorIdentity === 'string' ? auth.requestedActorIdentity : null },
  });
  if (verdict.status !== 'PASS') return verdict;

  const openclawCorroboration = auth.isolationAcceptance
    && auth.isolationAcceptance.realHostProbe
    && auth.isolationAcceptance.realHostProbe.hostKind === 'openclaw';

  if (openclawCorroboration) {
    const corroborated = new Map();
    for (const attempt of attempts) {
      const evidence = attempt.observedHostEvidence;
      const sessionId = evidence && evidence.hostSessionId;
      if (!sessionId || corroborated.has(sessionId)) continue;
      const loc = evidence.hostEvidence;
      if (!loc || loc.kind !== 'openclaw-exec-state'
        || typeof loc.stateAgentDb !== 'string' || typeof loc.stateDir !== 'string') {
        corroborated.set(sessionId, `host session '${sessionId}' carries no openclaw-exec-state evidence location — record fields alone are never real-host acceptance evidence`);
        continue;
      }
      const state = readOpenClawExecStateTrajectory({ stateAgentDb: loc.stateAgentDb, sessionId, trustedRoot: loc.stateDir });
      if (!state || state.found !== true || state.ambiguous) {
        corroborated.set(sessionId, `host session '${sessionId}' is not corroborated by the OpenClaw runtime's exec-state trajectory — record fields alone are never real-host acceptance evidence (${(state && state.reason) || 'no exec-state evidence'})`);
        continue;
      }
      const observed = evidence.observedModelIdentity;
      if (typeof state.model !== 'string' || state.model.length === 0) {
        corroborated.set(sessionId, `exec-state trajectory for session '${sessionId}' carries no model identity — identity cannot be corroborated`);
      } else if (state.model !== observed && !state.model.endsWith(`/${observed}`) && observed !== state.model.split('/').pop()) {
        corroborated.set(sessionId, `exec-state trajectory for session '${sessionId}' reports model '${state.model}' which conflicts with the attempt's observed identity '${observed}'`);
      }
    }
    const failures = [...corroborated.values()];
    if (failures.length > 0) {
      return { status: 'NOT_ESTIMABLE', reasons: failures };
    }
    return {
      status: 'PASS',
      reasons: [
        `${attempts.length} F2-real-host attempt(s) with approved authorization linkage, lineage-consistent observed host evidence and OpenClaw exec-state-corroborated host sessions (≥1 SUCCEEDED)`,
      ],
    };
  }

  if (typeof codexHome !== 'string' || codexHome.length === 0) {
    return notEstimable('codexHome not provided — host-session corroboration cannot run, so a formal PASS is not claimable (fail-closed)');
  }
  const corroborated = new Map();
  for (const attempt of attempts) {
    const sessionId = attempt.observedHostEvidence && attempt.observedHostEvidence.hostSessionId;
    if (!sessionId || corroborated.has(sessionId)) continue;
    const evidence = readRolloutEvidenceForSession({ codexHome, sessionId });
    if (!evidence || evidence.found !== true || evidence.ambiguous) {
      corroborated.set(sessionId, `host session '${sessionId}' is not corroborated by a rollout under codexHome — record fields alone are never real-host acceptance evidence (${(evidence && evidence.reason) || 'no rollout evidence'})`);
      continue;
    }
    const observed = attempt.observedHostEvidence.observedModelIdentity;
    if (typeof evidence.model !== 'string' || evidence.model.length === 0) {
      corroborated.set(sessionId, `rollout for session '${sessionId}' carries no model identity — identity cannot be corroborated`);
    } else if (evidence.model !== observed && !evidence.model.endsWith(`/${observed}`) && observed !== evidence.model.split('/').pop()) {
      corroborated.set(sessionId, `rollout for session '${sessionId}' reports model '${evidence.model}' which conflicts with the attempt's observed identity '${observed}'`);
    }
  }
  const failures = [...corroborated.values()];
  if (failures.length > 0) {
    return { status: 'NOT_ESTIMABLE', reasons: failures };
  }
  return {
    status: 'PASS',
    reasons: [
      `${attempts.length} F2-real-host attempt(s) with approved authorization linkage, lineage-consistent observed host evidence and rollout-corroborated host sessions (≥1 SUCCEEDED)`,
    ],
  };
}
