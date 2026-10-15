// PRI-971 — G2 preparation layer: same-channel delivery, memory manifest,
// model stub and cross-arm contamination checks.
//
// Everything here is WIRING-ONLY preparation for the real-agent pilot. It
// proves the plumbing (delivery, isolation, freezing, receipt accounting)
// with a deterministic stub; it deliberately cannot and does not run any real
// model. Real-agent execution stays NOT_RUN until the Owner decisions listed
// in fixtures/pilot-run-config.json are made.
//
// Same-channel contract (SPEC §4.2/§9.1 Pilot-1/2): whatever the arm content
// is (real generated principle, strong summary, raw experience, nothing), it
// reaches the actor ONLY through deliverPayload() — one code path, one
// position, one budget. The C-A contrast can then never be accidentally
// confounded by different delivery mechanics.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DELIVERY_CHANNEL = 'research-same-channel-v1';
export const MEMORY_MANIFEST_SCHEMA = 'memory-manifest.v0.1';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256File(file) {
  return sha256(readFileSync(file, 'utf8'));
}

/**
 * The single delivery path for arm content entering any actor session.
 * `content` is the exact bytes to deliver (frozen candidate policy text,
 * summary text, raw experience text — or null for the no-content arm).
 * Returns an immutable receipt describing what the actor WILL see.
 */
export function deliverPayload({ armId, content, position = 'after-task-text', budgetChars = 2000 }) {
  const payloadText = content === null || content === undefined ? '' : String(content);
  if (payloadText.length > budgetChars) {
    throw new Error(`deliverPayload: arm ${armId} payload exceeds the channel budget (${payloadText.length} > ${budgetChars} chars) — truncate policy belongs to the study design, not to delivery`);
  }
  return {
    channel: DELIVERY_CHANNEL,
    armId,
    payloadText,
    payloadHash: sha256(payloadText),
    deliveredBytes: Buffer.byteLength(payloadText, 'utf8'),
    position,
    budgetChars,
    deliveredAt: null, // stamped by the runner in real runs; stays null in stubs
  };
}

/** What the actor session input looks like: task text + payload in position. */
export function composeActorPrompt({ taskText, delivery }) {
  if (delivery.position === 'after-task-text') {
    return `${taskText}\n\n--- applied context ---\n${delivery.payloadText}`;
  }
  throw new Error(`composeActorPrompt: unsupported position ${delivery.position}`);
}

/**
 * Memory manifest for REAL agent profiles (G2): fingerprint every external
 * rule/memory file the profile could see, so a run can prove which external
 * content existed. G1 simulated arms use the empty embedded variant.
 */
export function buildMemoryManifest({ files }) {
  const entries = files.map((f) => ({
    path: f.path,
    role: f.role,
    sha256: sha256File(f.path),
    bytes: null, // filled by the caller if needed; hash is the identity
  }));
  return { schemaVersion: MEMORY_MANIFEST_SCHEMA, entries, note: 'fingerprint of externally visible rule/memory files at run start' };
}

/**
 * Deterministic model stub — the Actor test interface.
 *
 * `scriptedPlans` maps armId -> plan (actions array, like the calibration
 * battery). The stub faithfully RECORDS everything it received through the
 * channel and replays the scripted plan; it never sees the environment or
 * the gold. This is what proves the wiring end-to-end without any model.
 */
export function createModelStub({ scriptedPlans }) {
  const receipts = [];
  return {
    async runActor({ armId, delivery, taskText }) {
      if (delivery.channel !== DELIVERY_CHANNEL) {
        throw new Error(`model stub: refusing non-${DELIVERY_CHANNEL} delivery`);
      }
      const plan = scriptedPlans[armId];
      if (!plan) throw new Error(`model stub: no scripted plan for arm ${armId}`);
      receipts.push({
        armId,
        payloadHash: delivery.payloadHash,
        promptHash: sha256(composeActorPrompt({ taskText, delivery })),
      });
      return { actions: plan.actions.map((a) => ({ ...a })), narrative: plan.narrative ?? '' };
    },
    receipts() {
      return receipts.slice();
    },
  };
}

/**
 * Cross-arm contamination check: every stub receipt must carry its OWN arm's
 * payload hash, and no foreign payload may appear in any receipt's prompt.
 * `deliveries` maps armId -> delivery receipt produced by deliverPayload.
 */
export function checkNoCrossContamination({ receipts, deliveries }) {
  const problems = [];
  for (const r of receipts) {
    const own = deliveries[r.armId];
    if (!own) {
      problems.push(`receipt for unknown arm ${r.armId}`);
      continue;
    }
    if (r.payloadHash !== own.payloadHash) {
      problems.push(`arm ${r.armId} received payload ${r.payloadHash.slice(0, 8)}… instead of its own ${own.payloadHash.slice(0, 8)}… (cross-arm contamination)`);
    }
  }
  return problems;
}

/**
 * Stricter prompt-level contamination check: recompute each receipt's expected
 * prompt hash from ITS OWN delivery and task text; a mismatch means the stub
 * (or a future real runner) composed the prompt with foreign content.
 */
export function verifyPromptIsolation({ receipts, deliveries, taskTextByArm }) {
  const problems = [];
  for (const r of receipts) {
    const own = deliveries[r.armId];
    const taskText = taskTextByArm[r.armId];
    if (!own || !taskText) {
      problems.push(`missing delivery or task text for arm ${r.armId}`);
      continue;
    }
    const expected = sha256(composeActorPrompt({ taskText, delivery: own }));
    if (r.promptHash !== expected) {
      problems.push(`arm ${r.armId} prompt hash mismatch — session input was not composed from this arm's own delivery (contamination or wiring bug)`);
    }
  }
  return problems;
}
