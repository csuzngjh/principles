// PRI-1152 Path A isolated-host run — the ONE principle fixture.
//
// The fixture is a validated principle artifact plus a prompt activation
// written through the formal stores (seedControlledWorkspace). No approvals row
// is written: the shared prompt route derives `authority="system_policy"` for
// it, which is the truthful annotation for an isolated test fixture. The A1
// golden sample is only the round's USER INPUT; it is never an activation.
//
// The body deliberately carries < > & " so the assembly must XML-escape it
// exactly once. Inspection runs the real host-runtime shared route against the
// seeded workspace (read-only) and freezes the escaped directive slice the
// presence check will look for.

import { createHash } from 'node:crypto';
import { buildActivePrinciplePromptContext } from '@principles/host-runtime';
import { escapeXml } from '@principles/core/prompt-builder';
import { readControlledWorkspaceTarget, seedControlledWorkspace } from './workspace-seed.mjs';
import { SqliteConnection } from '@principles/core/runtime';

export const PRESENCE_FIXTURE = Object.freeze({
  principleId: 'pri1152-presence-fixture',
  artifactId: 'art-pri1152-presence-fixture',
  activationId: 'act_prompt_pri1152-presence-fixture',
  text: 'PRI-1152 隔离验证夹具：交付前必须核对 <presence> 标记、& 符号与 "引号"。',
  authoritySource: 'isolated test fixture via formal stores (SqliteTaskStore/SqlitePIArtifactStore/SqliteActivationStateStore); no approvals row; prompt route derives authority=system_policy',
});

export function sha256Utf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function seedPresenceFixture(workspaceDir, { activatedAt } = {}) {
  return seedControlledWorkspace({
    workspaceDir,
    artifactId: PRESENCE_FIXTURE.artifactId,
    activationId: PRESENCE_FIXTURE.activationId,
    principleId: PRESENCE_FIXTURE.principleId,
    principleText: PRESENCE_FIXTURE.text,
    ...(activatedAt ? { activatedAt } : {}),
  });
}

/** Facts about one escaped directive slice relative to the raw body. */
export function analyzeDirectiveEscaping(directiveSlice, rawText = PRESENCE_FIXTURE.text) {
  const escaped = escapeXml(rawText);
  const doubleEscaped = escapeXml(escaped);
  const count = (haystack, needle) => (needle.length === 0 ? 0 : haystack.split(needle).length - 1);
  return {
    escapedBodySha256: sha256Utf8(escaped),
    escapedBodyOccurrences: count(directiveSlice, escaped),
    rawBodyOccurrences: count(directiveSlice, rawText),
    doubleEscapedOccurrences: count(directiveSlice, doubleEscaped),
    rawSpecialCharsInBody: ['<presence>', '& ', '"引号"'].filter((needle) => directiveSlice.includes(needle)),
    escapedExactlyOnce: count(directiveSlice, escaped) === 1 && count(directiveSlice, doubleEscaped) === 0 && count(directiveSlice, rawText) === 0,
  };
}

function readArtifactFacts(workspaceDir, artifactId) {
  const connection = new SqliteConnection({ workspaceDir, readonly: true, bootstrapIfMissing: false, busyTimeoutMs: 0 });
  try {
    const db = connection.getDb();
    const row = db.prepare('SELECT revision_epoch FROM pi_artifacts WHERE artifact_id = ?').get(artifactId);
    const value = row !== null && typeof row === 'object' ? Reflect.get(row, 'revision_epoch') : undefined;
    const approvals = db.prepare('SELECT COUNT(*) AS n FROM approvals').get();
    const approvalRows = approvals !== null && typeof approvals === 'object' ? Reflect.get(approvals, 'n') : null;
    return { revisionEpoch: Number.isInteger(value) ? value : null, approvalRows: Number.isInteger(approvalRows) ? approvalRows : null };
  } catch {
    return { revisionEpoch: null, approvalRows: null };
  } finally {
    connection.close();
  }
}

/**
 * Read-only inspection: the formal stores resolve the fixture, and the REAL
 * shared prompt route (host-runtime) assembles it with a frozen, complete,
 * single-escaped expectation. Requires `<workspace>/.pd/config.yaml` to be in
 * place (the route reads features.prompt from it).
 */
export async function inspectPresenceFixture(workspaceDir) {
  const target = await readControlledWorkspaceTarget({
    workspaceDir,
    artifactId: PRESENCE_FIXTURE.artifactId,
    activationId: PRESENCE_FIXTURE.activationId,
  });
  if (!target.ok) return { ok: false, reason: `fixture_unreadable:${target.reason}`, target };
  const assembly = await buildActivePrinciplePromptContext({ workspaceDir });
  const expectations = Array.isArray(assembly.injectedExpectations) ? assembly.injectedExpectations : [];
  const expectation = expectations.find((entry) => entry.activationId === PRESENCE_FIXTURE.activationId) ?? null;
  const violations = [];
  if (target.principleId !== PRESENCE_FIXTURE.principleId) violations.push('resolved principleId differs from the fixture');
  if (target.promptActivationCount !== 1) violations.push(`workspace has ${target.promptActivationCount} prompt activations, expected exactly 1`);
  if (assembly.warnings?.length) violations.push(`shared route warnings: ${assembly.warnings.join(' | ')}`);
  if (!assembly.activationIds?.includes(PRESENCE_FIXTURE.activationId)) violations.push('shared route did not include the fixture activation');
  if (expectation === null) violations.push('shared route froze no expectation for the fixture');
  if (expectation && expectation.bodyComplete !== true) violations.push('frozen expectation is not bodyComplete');
  const escaping = expectation ? analyzeDirectiveEscaping(expectation.bodyText) : null;
  if (escaping && !escaping.escapedExactlyOnce) violations.push('directive body is not escaped exactly once');
  // Read the authority from the fixture's OWN directive tag: the section
  // preamble also mentions authority="owner" as explanatory text.
  const context = typeof assembly.additionalContext === 'string' ? assembly.additionalContext : '';
  const tagStart = context.indexOf(`<directive id="${PRESENCE_FIXTURE.principleId}"`);
  const tag = tagStart === -1 ? '' : context.slice(tagStart, context.indexOf('>', tagStart) + 1);
  const authorityMatch = tag.match(/ authority="([^"]+)"/);
  if (!authorityMatch || authorityMatch[1] !== 'system_policy') violations.push('fixture directive authority is not the derived system_policy');
  const facts = readArtifactFacts(workspaceDir, PRESENCE_FIXTURE.artifactId);
  if (facts.approvalRows !== 0) violations.push(`approvals table must stay empty for the fixture workspace (found ${facts.approvalRows})`);
  return {
    ok: violations.length === 0,
    violations,
    principleId: target.principleId,
    artifactId: PRESENCE_FIXTURE.artifactId,
    activationId: PRESENCE_FIXTURE.activationId,
    stateDbPath: target.stateDbPath,
    stateDbSha256: target.stateDbSha256,
    revisionEpoch: facts.revisionEpoch,
    approvalRows: facts.approvalRows,
    rawTextSha256: sha256Utf8(PRESENCE_FIXTURE.text),
    expectation: expectation ? {
      bodyChars: expectation.bodyChars,
      bodyComplete: expectation.bodyComplete,
      directiveSliceSha256: sha256Utf8(expectation.bodyText),
    } : null,
    escaping,
    renderedAuthority: authorityMatch ? authorityMatch[1] : null,
    sharedRoute: {
      principleIds: assembly.principleIds,
      activationIds: assembly.activationIds,
      selectionPolicy: assembly.selectionPolicy,
      truncated: assembly.truncated,
      budget: assembly.budget,
    },
  };
}
