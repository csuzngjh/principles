// PRI-1002 — production evidence-resolver: Linear-backed Owner decision
// records (PRR B0, owner-directed task 2026-10-23).
//
// AUTHORITATIVE SOURCE: the Owner's structured freeze-approval comment on
// Linear issue PRI-1001. The resolver reads it through the Linear GraphQL API
// (TLS + workspace token — an independent authoritative system), checks the
// comment AUTHOR against the configured Owner identity, parses the structured
// [PRR-FREEZE-APPROVAL] block, and strictly reconciles every field against
// the expectations the runner passes in. Nothing the caller supplies locally
// is ever converted into "verified" — a missing/mismatching attestation
// fails closed.
//
// Signing template (the Owner posts this on PRI-1001 verbatim, filling the
// values produced by generate-prr-freeze.mjs):
//
//   [PRR-FREEZE-APPROVAL]
//   decisionRef: <id>
//   protocolDigest: <64-hex>
//   frozenCommitSha: <40-hex>
//   fixtureHash: <64-hex>
//   costBasisRef: <id>
//   pricingMode: free-tier | zai-coding-plan
//   approved: yes
//
// Usage (wired by run-prr-real.mjs):
//   --evidence-resolver scripts/dev/principle-learning-lab/prr/lib/linear-owner-resolver.mjs
//
// Environment: LINEAR_API_KEY (or ~/.linear_api_key) — read via the existing
// linear-cli client; never logged. LINEAR_OWNER_NAME may override the Owner
// display-name kept for DIAGNOSTICS ONLY (LINEAR_OWNER_NAME) — authorization
// is decided by the STABLE USER ID binding below (owner review round 8).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LINEAR_ISSUE = 'PRI-1001';
export const APPROVAL_MARKER = '[PRR-FREEZE-APPROVAL]';
const LINEAR_ENDPOINT = process.env.LINEAR_GRAPHQL_URL || 'https://api.linear.app/graphql';

/**
 * TRUST ROOT (owner review round 8): the expected Owner's STABLE Linear user
 * id. It MUST come from deployment-level trusted configuration
 * (LINEAR_OWNER_ID env) — never from execution arguments, never from the
 * signing comment itself. Unconfigured = every signature refuses
 * (fail-closed); LINEAR_OWNER_NAME remains display/diagnostic only and can
 * NEVER satisfy the identity check on its own.
 */
export function expectedOwnerId() {
  const id = process.env.LINEAR_OWNER_ID;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/**
 * Minimal Linear read client. Token resolution mirrors the linear-cli order
 * (env → ~/.linear_api_key → ~/.bashrc export) so the run uses the SAME
 * credential the workspace already trusts. The token is never logged.
 */
function resolveToken() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  for (const file of [path.join(os.homedir(), '.linear_api_key'), path.join(os.homedir(), '.config', 'linear', 'api_key')]) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch { /* next source */ }
  }
  try {
    const bashrc = fs.readFileSync(path.join(os.homedir(), '.bashrc'), 'utf8');
    const match = bashrc.match(/^\s*export\s+LINEAR_API_KEY\s*=\s*["']?([^"'\s]+)["']?\s*$/m);
    if (match) return match[1];
  } catch { /* no bashrc */ }
  return null;
}

export async function linearRequest(query, variables) {
  const token = resolveToken();
  if (!token) throw new Error('no Linear API key found (LINEAR_API_KEY / ~/.linear_api_key) — the authoritative Owner-decision record cannot be read');
  const res = await fetch(LINEAR_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`Linear GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
  return json;
}

function ownerName() {
  return process.env.LINEAR_OWNER_NAME || '(display name not configured)';
}

function parseApprovalBlock(body) {
  if (typeof body !== 'string' || !body.includes(APPROVAL_MARKER)) return null;
  const fields = {};
  const patterns = {
    decisionRef: /^\s*decisionRef:\s*(\S+)\s*$/m,
    protocolDigest: /^\s*protocolDigest:\s*([0-9a-f]{64})\s*$/m,
    frozenCommitSha: /^\s*frozenCommitSha:\s*([0-9a-f]{40})\s*$/m,
    fixtureHash: /^\s*fixtureHash:\s*([0-9a-f]{64})\s*$/m,
    costBasisRef: /^\s*costBasisRef:\s*(\S+)\s*$/m,
    pricingMode: /^\s*pricingMode:\s*(free-tier|zai-coding-plan)\s*$/m,
    approved: /^\s*approved:\s*yes\s*$/m,
  };
  for (const [field, re] of Object.entries(patterns)) {
    const match = body.match(re);
    fields[field] = match ? match[1] : null;
  }
  return fields;
}

async function fetchApprovalComments(client) {
  const request = client?.request ?? linearRequest;
  const result = await request(`
    query($id: String!) {
      issue(id: $id) {
        creator { id name active }
        comments(first: 100, orderBy: createdAtDesc) {
          nodes {
            body
            createdAt
            user { id name active }
          }
        }
      }
    }`, { id: LINEAR_ISSUE });
  const issue = result?.data?.issue;
  const nodes = issue?.comments?.nodes;
  if (!Array.isArray(nodes)) throw new Error('Linear returned no comment list for PRI-1001');
  const creatorId = typeof issue?.creator?.id === 'string' && issue.creator.id !== '' ? issue.creator.id : null;
  return { nodes, creatorId };
}

/**
 * Authoritative read: the Owner's freeze-approval comment on PRI-1001.
 *
 * Identity trust root (owner review rounds 8+9):
 *   1. LINEAR_OWNER_ID (deployment-level trusted configuration) when set;
 *   2. otherwise the PRI-1001 ISSUE CREATOR id — a stable fact recorded by
 *      the Linear system itself (the Owner opened this gate ticket), fetched
 *      from the same authoritative API as the comments. Display names never
 *      decide authorization under either root.
 */
export async function fetchOwnerApproval({ client } = {}) {
  const { nodes, creatorId } = await fetchApprovalComments(client);
  const configuredId = expectedOwnerId();
  const expectedId = configuredId ?? creatorId;
  if (expectedId === null) {
    // Fail-closed: no deployment config AND Linear did not report a ticket
    // creator — no signature can be attributed to the Owner.
    return { verified: false, reason: 'cannot establish the expected Owner identity: LINEAR_OWNER_ID is not configured and Linear returned no PRI-1001 creator id (fail-closed)' };
  }
  const identityBasis = configuredId ? 'LINEAR_OWNER_ID (deployment config)' : 'PRI-1001 creator id (Linear-authoritative)';
  const diagnosticName = ownerName();
  const candidates = [];
  for (const node of nodes) {
    const authorId = typeof node?.user?.id === 'string' ? node.user.id : null;
    const authorName = node?.user?.name ?? '(no author)';
    const fields = parseApprovalBlock(node?.body);
    if (!fields) continue;
    candidates.push({ authorId, authorName, createdAt: node.createdAt, active: node.user?.active !== false, fields });
  }
  if (candidates.length === 0) {
    return { verified: false, reason: `no ${APPROVAL_MARKER} comment found on ${LINEAR_ISSUE}` };
  }
  // The LATEST comment authored by the expected Owner id wins. Sort by
  // createdAt ourselves — never trust the transport's ordering.
  const byOwner = candidates.filter((c) => c.active && c.authorId === expectedId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (byOwner.length === 0) {
    const authorsSeen = [...new Set(candidates.map((c) => `${c.authorName}${c.authorId ? ` (id ${c.authorId.slice(0, 8)}…)` : ' (no id)'}`))].join(', ');
    return {
      verified: false,
      reason: `approval-marker comments exist but none by the configured Owner id ${expectedId.slice(0, 8)}… (diagnostic display name: "${diagnosticName}"); authors seen: ${authorsSeen}`,
    };
  }
  const latest = byOwner[0]; // newest first
  const fields = latest.fields;
  const missing = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
  if (fields.approved === null) missing.push('approved:yes');
  if (missing.length > 0) {
    return { verified: false, reason: `the latest Owner approval comment (${latest.createdAt}) is missing/incomplete fields: ${missing.join(', ')}` };
  }
  return {
    verified: true,
    approved: true,
    attestedAt: latest.createdAt,
    authorId: latest.authorId,
    author: latest.authorName,
    decisionRef: fields.decisionRef,
    approvedProtocolDigest: fields.protocolDigest,
    frozenCommitSha: fields.frozenCommitSha,
    frozenFixtureHash: fields.fixtureHash,
    costBasisRef: fields.costBasisRef,
    pricingMode: fields.pricingMode,
  };
}

/**
 * The resolver entry point (run-prr-real.mjs contract).
 * `expectedBudget` is the frozen FZ-06 value used ONLY to shape the pricing
 * attestation (provider/model/max tokens come from the frozen record; the
 * resolver attests the SCHEDULE, which for Owner-authorized free-tier or
 * subscription plans is a $0 marginal rate by Owner decision — never a
 * researched market price).
 */
export async function verify(req) {
  if (!req || typeof req !== 'object') return { verified: false, reason: 'resolver called without a request' };
  const clientOverride = typeof req.client === 'object' ? req.client : undefined; // test injection only

  if (req.kind === 'owner-decision') {
    // Transport/parse failures are part of the fail-closed contract: they
    // become a verified:false refusal with the reason — never an exception
    // that a caller might mishandle into a default-allow.
    let approval;
    try {
      approval = await fetchOwnerApproval(clientOverride ? { client: clientOverride } : {});
    } catch (error) {
      return { verified: false, reason: `authoritative identity lookup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!approval.verified) return { verified: false, reason: approval.reason };

    // Strict reconciliation against the runner's expectations — every field
    // must match; a mismatch refuses (the resolver never adopts local values).
    const mismatches = [];
    if (approval.decisionRef !== req.decisionRef) mismatches.push(`decisionRef (attested ${approval.decisionRef} vs expected ${req.decisionRef})`);
    if (approval.approvedProtocolDigest !== req.expectedProtocolDigest) mismatches.push(`protocolDigest (attested ${String(approval.approvedProtocolDigest).slice(0, 12)}… vs expected ${String(req.expectedProtocolDigest).slice(0, 12)}…)`);
    if (approval.frozenCommitSha !== req.expectedCommitSha) mismatches.push(`frozenCommitSha (attested ${String(approval.frozenCommitSha).slice(0, 12)}… vs expected ${String(req.expectedCommitSha).slice(0, 12)}…)`);
    if (approval.frozenFixtureHash !== req.expectedFixtureHash) mismatches.push(`fixtureHash (attested ${String(approval.frozenFixtureHash).slice(0, 12)}… vs expected ${String(req.expectedFixtureHash).slice(0, 12)}…)`);
    if (mismatches.length > 0) {
      return { verified: false, reason: `the Owner approval does not cover this run: ${mismatches.join('; ')}` };
    }
    return {
      verified: true,
      approved: true,
      decisionRef: approval.decisionRef,
      approvedProtocolDigest: approval.approvedProtocolDigest,
      frozenCommitSha: approval.frozenCommitSha,
      frozenFixtureHash: approval.frozenFixtureHash,
      attestedAt: approval.attestedAt,
      author: approval.author,
    };
  }

  if (req.kind === 'cost-basis') {
    // Same fail-closed contract: lookup failures become verified:false.
    let approval;
    try {
      approval = await fetchOwnerApproval(clientOverride ? { client: clientOverride } : {});
    } catch (error) {
      return { verified: false, reason: `authoritative identity lookup failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!approval.verified) return { verified: false, reason: approval.reason };
    if (approval.costBasisRef !== req.reference) {
      return { verified: false, reason: `the Owner approval does not cover this pricing schedule (attested ${String(approval.costBasisRef)} vs requested ${String(req.reference)})` };
    }
    const frozen = req.expectedBudget?.costBasis;
    if (!frozen || typeof frozen !== 'object') {
      return { verified: false, reason: 'frozen FZ-06 costBasis is missing — cannot shape a pricing attestation' };
    }
    const rates = approval.pricingMode === 'free-tier' || approval.pricingMode === 'zai-coding-plan'
      ? { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }
      : null;
    if (rates === null) {
      return { verified: false, reason: `unrecognized pricingMode ${String(approval.pricingMode)}` };
    }
    return {
      verified: true,
      reference: req.reference,
      provider: frozen.provider,
      model: frozen.model,
      currency: 'USD',
      ...rates,
      maxInputTokensPerRequest: frozen.maxInputTokensPerRequest,
      maxOutputTokensPerRequest: frozen.maxOutputTokensPerRequest,
      effectiveDate: approval.attestedAt.slice(0, 10),
      source: `owner-approved ${approval.pricingMode} (PRI-1001 ${approval.attestedAt}) — marginal rate $0 by Owner authorization, not by market research`,
    };
  }

  return { verified: false, reason: `unknown evidence kind ${String(req?.kind)}` };
}

export default { verify };
