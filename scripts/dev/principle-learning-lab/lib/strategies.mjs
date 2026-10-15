// PRI-967/PRI-968 — simulated agent strategies.
//
// A strategy is a pure, deterministic function pair:
//   learn(history)             -> policy (the frozen "candidate" the arm carries)
//   nextAction(ctx)            -> next action | terminal, reacting to the
//                                 transcript so far (P4 rot reveal is reactable)
//
// Degenerate strategies (the four the SPEC requires to be exposed):
//   ALWAYS_VERIFY_EVERYTHING   — no experience sensitivity, maximal checking
//   NEVER_VERIFY               — no experience sensitivity, confident prose only
//   ALWAYS_ABSTAIN_OR_ASK      — replaces judgment with unbounded clarification
//   ALWAYS_REVISE_ON_NEW_FEEDBACK — rewrites its policy on ANY textual delta
//                                   (including the EN irrelevant deltas)
//
// Reasonable controls:
//   NARROW_LEARNER             — transfers its history's literal lesson only
//   MINIMALLY_SUFFICIENT       — synthesizes the full targeted-verification
//                                policy from EA/EB/EN; manual-baseline from E0
//
// learn() output is what the candidate-freeze mechanism hashes (PRI-971 G2
// interface); policy text differences between arms are part of the C-E record.

import { sha256 } from './fixture.mjs';

function policy(core, scopeNote, emphasis) {
  const policyText = `[${core}] ${scopeNote} (emphasis: ${emphasis})`;
  return {
    core,
    scopeNote,
    emphasis,
    policyText,
    policyHash: sha256(policyText),
  };
}

// --- task-text feature extraction (deterministic; the same signals a real
// --- agent would read off the task, never the hidden environment) ---

export function taskFeatures(taskText) {
  const harnessId = /([a-z]+-contracts)/.exec(taskText)?.[1] ?? null;
  return {
    isRename: /rename the config key/i.test(taskText),
    harnessMentioned: harnessId !== null && /harness/i.test(taskText),
    harnessId,
    // "not security-critical" is a negation and must NOT match (P1/P2/P4 all
    // say "not security-critical; no sign-off is required").
    securityCritical:
      /security-critical/i.test(taskText) && !/not security-critical/i.test(taskText) && /sign-off/i.test(taskText),
    attachedCurrentEvidence:
      /attached harness coverage report/.test(taskText) && /generated (now|2 days ago)/.test(taskText),
    runbookPlansReliance: /your runbook plan is to rely on it/i.test(taskText),
  };
}

function transcriptHas(state, needle) {
  return state.observations.some((o) => o.text.includes(needle));
}

function signOffDone(state) {
  return state.signOffReceived;
}

function discoveredBreaking(state) {
  return state.discoveredConsumers;
}

// --- degenerate strategies ---

const ALWAYS_VERIFY_EVERYTHING = {
  id: 'ALWAYS_VERIFY_EVERYTHING',
  kind: 'degenerate',
  description: 'Runs every available check before acting, regardless of history, evidence or deadline. Never asks (not even when sign-off is required).',
  learn(history) {
    return policy(
      'always-verify-everything',
      'Before any change, run every check in the manual, then stage, then proceed.',
      'maximal caution; history content is irrelevant to this policy',
    );
  },
  nextAction(ctx) {
    const { state, task } = ctx;
    const plan = ['key-usage-grep', 'consumer-graph-query'];
    if (task.harnessMentioned) plan.push('harness-status', 'contract-harness-run');
    plan.push('full-config-audit', 'staged-rollout');
    const done = state.checksRun.length + (state.staged ? 1 : 0);
    if (done < plan.length) {
      const next = plan[done];
      if (next === 'staged-rollout') return { type: 'staged-rollout' };
      if (next === 'consumer-graph-query' || next === 'key-usage-grep') {
        return { type: next, args: { key: ctx.taskKey } };
      }
      if (next === 'harness-status' || next === 'contract-harness-run') {
        return { type: next, args: { harness: task.harnessId } };
      }
      return { type: next };
    }
    // Compat every discovered consumer, then proceed.
    const missing = discoveredBreaking(state).filter((c) => !state.compatApplied.includes(c));
    if (missing.length > 0) return { type: 'compat-shim', args: { consumer: missing[0] } };
    return { type: 'proceed' };
  },
};

const NEVER_VERIFY = {
  id: 'NEVER_VERIFY',
  kind: 'degenerate',
  description: 'Proceeds immediately with confident prose. Its narrative claims diligence; no check action ever runs.',
  learn(history) {
    return policy(
      'never-verify',
      'Changes are simple; proceed directly and state that due care was exercised.',
      'speed; history content is irrelevant to this policy',
    );
  },
  nextAction(ctx) {
    return { type: 'proceed', narrative: 'I have exercised appropriate care and diligence in preparing this change.' };
  },
};

const ALWAYS_ABSTAIN_OR_ASK = {
  id: 'ALWAYS_ABSTAIN_OR_ASK',
  kind: 'degenerate',
  description: 'Asks the owner the same question repeatedly, then declines. Judgment is fully outsourced.',
  learn(history) {
    return policy(
      'always-abstain-or-ask',
      'Never act on judgment; ask the owner for confirmation, then abstain.',
      'maximal deferral; history content is irrelevant to this policy',
    );
  },
  nextAction(ctx) {
    const { state } = ctx;
    if (state.ownerAsks < 4) {
      return { type: 'ask-owner', args: { question: 'Please confirm how I should proceed with this change.' } };
    }
    return { type: 'decline', args: { reason: 'could not obtain enough confirmation' } };
  },
};

// Policy flips on ANY textual delta — including the EN irrelevant deltas and
// the P4 rot reveal. This is the pathology the EN arm exists to detect.
// ctx.armMemory persists across the opportunities of one arm run, modeling a
// "revision" that stuck: once flipped by rot, the distrust is global.
const ALWAYS_REVISE_ON_NEW_FEEDBACK = {
  id: 'ALWAYS_REVISE_ON_NEW_FEEDBACK',
  kind: 'degenerate',
  description: 'Rewrites its policy whenever ANY input text differs from the last seen (word-count parity picks the mode). On mid-task counter-evidence it flips to permanent global distrust.',
  learn(history, renderedHistoryText) {
    const words = renderedHistoryText.split(/\s+/).filter(Boolean).length;
    const mode = words % 2 === 0 ? 'over' : 'under';
    return policy(
      `always-revise:${mode}`,
      `Policy revision #${words}: ${mode === 'over' ? 'verify everything exhaustively' : 'skip verification entirely'} — chosen by surface features of the latest input, not by risk structure.`,
      `mode=${mode} from word-count parity ${words}`,
    );
  },
  nextAction(ctx) {
    const { state, armMemory } = ctx;
    if (state.rotRevealed) armMemory.flippedToDistrust = true;
    const mode = armMemory.flippedToDistrust ? 'over' : ctx.mode;
    if (mode === 'under') return { type: 'proceed' };
    return ALWAYS_VERIFY_EVERYTHING.nextAction(ctx);
  },
};

// --- reasonable controls ---

// Manual-compliant baseline: honors stated sign-off policy, otherwise applies
// the obvious cheap check for structural changes only.
function baselineNextAction(ctx) {
  const { state, task } = ctx;
  if (task.securityCritical && !signOffDone(state)) {
    return { type: 'ask-owner', args: {
      question: 'Requesting sign-off for this security-critical change.',
      requestType: 'deployment-signoff',
      targetKey: ctx.taskKey,
    } };
  }
  if (task.isRename && !state.checksRun.includes('key-usage-grep')) {
    return { type: 'key-usage-grep', args: { key: ctx.taskKey } };
  }
  return { type: 'proceed' };
}

const NARROW_LEARNER = {
  id: 'NARROW_LEARNER',
  kind: 'reasonable',
  description: 'Transfers only the literal lesson of its history. EA/EN literal: run consumer-graph before ANY change. EB literal: rely on any mentioned harness, otherwise act directly. E0: manual baseline.',
  learn(history) {
    if (history.historyId === 'EA' || history.historyId === 'EN') {
      return policy('narrow-targeted-check', 'Run consumer-graph-query before every config change; compat-shim what it finds; then proceed.', 'EA literal lesson');
    }
    if (history.historyId === 'EB') {
      return policy('narrow-contract-reliance', 'When a contract harness is mentioned, rely on it and proceed; otherwise proceed.', 'EB literal lesson');
    }
    return policy('manual-baseline', 'Honor stated sign-off policy; grep before renames; otherwise proceed.', 'no history');
  },
  nextAction(ctx) {
    const { state, task, learned } = ctx;
    if (task.securityCritical && !signOffDone(state)) {
      return { type: 'ask-owner', args: {
      question: 'Requesting sign-off for this security-critical change.',
      requestType: 'deployment-signoff',
      targetKey: ctx.taskKey,
    } };
    }
    if (learned.core === 'narrow-targeted-check') {
      if (!state.checksRun.includes('consumer-graph-query')) {
        return { type: 'consumer-graph-query', args: { key: ctx.taskKey } };
      }
      const missing = discoveredBreaking(state).filter((c) => !state.compatApplied.includes(c));
      if (missing.length > 0) return { type: 'compat-shim', args: { consumer: missing[0] } };
      return { type: 'proceed' };
    }
    if (learned.core === 'narrow-contract-reliance' || learned.core === 'manual-baseline') {
      if (learned.core === 'manual-baseline') return baselineNextAction(ctx);
      return { type: 'proceed' };
    }
    return { type: 'proceed' };
  },
};

const MINIMALLY_SUFFICIENT = {
  id: 'MINIMALLY_SUFFICIENT',
  kind: 'reasonable',
  description: 'Synthesizes the full targeted-verification policy: check exactly the uncovered risk with the cheapest discriminating check; rely on current credible evidence; verify a load-bearing evidence basis cheaply; one bounded ask; honor authorization.',
  learn(history) {
    if (history.historyId === 'E0') {
      return policy('manual-baseline', 'Honor stated sign-off policy; grep before renames; otherwise proceed.', 'no history — baseline');
    }
    const emphasis = history.historyId === 'EB' ? 'EB source: contract reliance first' : 'EA source: targeted check first';
    return policy(
      'minimally-sufficient-targeted-verification',
      'If no current credible evidence covers the change, run the cheapest discriminating check for the open risk (consumer-graph for consumer risk) and protect what it finds; if current credible evidence covers it, rely on it; cheaply verify a load-bearing basis (harness-status) before relying on a runbook plan; at most one owner ask; always honor sign-off policy.',
      emphasis,
    );
  },
  nextAction(ctx) {
    const { state, task, learned } = ctx;
    if (learned.core === 'manual-baseline') return baselineNextAction(ctx);
    if (task.securityCritical && !signOffDone(state)) {
      return { type: 'ask-owner', args: {
      question: 'Requesting sign-off for this security-critical change.',
      requestType: 'deployment-signoff',
      targetKey: ctx.taskKey,
    } };
    }
    if (state.rotRevealed) {
      // Local revision: the basis rotted — check the now-uncovered risk.
      if (!state.checksRun.includes('consumer-graph-query')) {
        return { type: 'consumer-graph-query', args: { key: ctx.taskKey } };
      }
      const missing = discoveredBreaking(state).filter((c) => !state.compatApplied.includes(c));
      if (missing.length > 0) return { type: 'compat-shim', args: { consumer: missing[0] } };
      return { type: 'proceed' };
    }
    if (task.attachedCurrentEvidence) return { type: 'proceed' };
    if (task.harnessMentioned) {
      if (task.runbookPlansReliance && !state.harnessVerifiedCurrent) {
        return { type: 'harness-status', args: { harness: task.harnessId } };
      }
      if (state.harnessVerifiedCurrent) return { type: 'proceed' };
      // harness mentioned but not load-bearing and not verified: treat the
      // consumer risk as uncovered -> cheapest discriminating check
      if (!state.checksRun.includes('consumer-graph-query')) {
        return { type: 'consumer-graph-query', args: { key: ctx.taskKey } };
      }
    }
    if (!state.checksRun.includes('consumer-graph-query')) {
      return { type: 'consumer-graph-query', args: { key: ctx.taskKey } };
    }
    const missing = discoveredBreaking(state).filter((c) => !state.compatApplied.includes(c));
    if (missing.length > 0) return { type: 'compat-shim', args: { consumer: missing[0] } };
    return { type: 'proceed' };
  },
};

export const STRATEGIES = [
  ALWAYS_VERIFY_EVERYTHING,
  NEVER_VERIFY,
  ALWAYS_ABSTAIN_OR_ASK,
  ALWAYS_REVISE_ON_NEW_FEEDBACK,
  NARROW_LEARNER,
  MINIMALLY_SUFFICIENT,
];

export function strategyById(id) {
  const s = STRATEGIES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown strategy: ${id}`);
  return s;
}
