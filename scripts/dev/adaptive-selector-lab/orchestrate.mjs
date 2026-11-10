#!/usr/bin/env node
// PRI-1122 isolated orchestration entry. Two modes:
//   native        — current Native assembly only (zero model sends)
//   single-model  — one generic-model selection opportunity feeding the SAME
//                   shared assembly, with a hard single-send transport gate.
//
// Offline evaluation uses --fixture-response to drive the REAL PiAiRuntimeAdapter
// over a fake fetch. A real call additionally requires an explicit approval flag
// and the credential environment variable; without both it refuses before any
// network work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBoundedSelectionInput,
  createSingleModelSelector,
  runSelectionOpportunity,
  LIMITS,
  SELECTOR_SYSTEM,
  hash,
} from './orchestrator.mjs';
export const APPROVAL_FLAG = '--execute-approved-20261110';

function parseArgs(argv) {
  const args = { mode: 'native', workspace: null, currentInput: null, roundKey: 1,
    budgetChars: null, prior: [], fixtureResponse: null, approved: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--mode') { args.mode = value; index += 1; }
    else if (key === '--workspace') { args.workspace = value; index += 1; }
    else if (key === '--current-input') { args.currentInput = value; index += 1; }
    else if (key === '--prior') { args.prior.push(value); index += 1; }
    else if (key === '--round-key') { args.roundKey = Number(value); index += 1; }
    else if (key === '--budget-chars') { args.budgetChars = Number(value); index += 1; }
    else if (key === '--fixture-response') { args.fixtureResponse = value; index += 1; }
    else if (key === '--out') { args.out = value; index += 1; }
    else if (key === APPROVAL_FLAG) { args.approved = true; }
    else throw new Error(`unknown argument: ${key}`);
  }
  if (!['native', 'single-model'].includes(args.mode)) throw new Error('INVALID_MODE');
  if (!args.workspace) throw new Error('--workspace <dir> is required');
  if (!Number.isFinite(args.roundKey) || args.roundKey < 0) throw new Error('INVALID_ROUND_KEY');
  if (args.budgetChars !== null && (!Number.isFinite(args.budgetChars) || args.budgetChars < 1)) throw new Error('INVALID_BUDGET');
  if (args.mode === 'single-model' && typeof args.currentInput !== 'string') throw new Error('--current-input is required');
  return args;
}

function sseFetch(payload) {
  return async () => {
    const packets = [
      { id: 'fake', model: 'glm-5.3-flash', choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: null }] },
      { id: 'fake', model: 'glm-5.3-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ];
    return new Response(packets.map((packet) => `data: ${JSON.stringify(packet)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  };
}

function brief(result) {
  return {
    schema: result.schema,
    hookInvocationId: result.hookInvocationId,
    outcome: result.outcome,
    selection: result.selection,
    model: result.model,
    assembly: {
      adaptiveStatus: result.assembly.adaptiveStatus,
      adaptiveReason: result.assembly.adaptiveReason,
      fallback: result.assembly.fallback,
      fallbackReason: result.assembly.fallbackReason,
      selectedButNotPacked: result.assembly.selectedButNotPacked,
      targetSnapshotVerified: result.assembly.targetSnapshotVerified,
      targetChangedDuringWait: result.assembly.targetChangedDuringWait,
      candidateCount: result.assembly.candidateCount,
      candidateRefs: result.assembly.candidateRefs,
      priorDropped: result.assembly.priorDropped,
      nativeActivationIds: result.assembly.nativeActivationIds ?? [],
      finalActivationIds: result.assembly.finalActivationIds ?? [],
      addedTarget: result.assembly.addedTarget ?? false,
      addedOther: result.assembly.addedOther ?? [],
      lostNative: result.assembly.lostNative ?? [],
      orderChanged: result.assembly.orderChanged ?? false,
      mandatoryPreserved: result.assembly.mandatoryPreserved ?? true,
      targetAlreadyInNative: result.assembly.targetAlreadyInNative ?? false,
      targetDirectiveCount: result.assembly.targetDirectiveCount ?? 0,
      nativeChars: result.assembly.nativeChars ?? null,
      finalChars: result.assembly.finalChars ?? null,
      deltaChars: result.assembly.deltaChars ?? null,
      nativeDroppedActivationIds: result.assembly.nativeDroppedActivationIds ?? [],
      nativeOversizedActivationIds: result.assembly.nativeOversizedActivationIds ?? [],
      nativeTruncated: result.assembly.nativeTruncated ?? false,
      readerWarnings: result.assembly.readerWarnings ?? [],
    },
    textSha256: hash(result.additionalContext),
    nativeTextSha256: hash(result.nativeContext),
    textChars: result.additionalContext.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceDir = path.resolve(args.workspace);
  const { resolvePromptBudget } = await import('@principles/core/runtime');
  const defaults = resolvePromptBudget();
  const promptBudget = args.budgetChars === null ? defaults : { ...defaults, budgetChars: args.budgetChars };

  if (args.mode === 'native') {
    const { buildActivePrinciplePromptContext } = await import('@principles/host-runtime');
    const native = await buildActivePrinciplePromptContext({ workspaceDir, roundKey: args.roundKey, promptBudget });
    const output = {
      mode: 'native',
      roundKey: args.roundKey,
      budgetChars: promptBudget.budgetChars,
      activationIds: native.activationIds,
      principleIds: native.principleIds,
      chars: native.additionalContext.length,
      textSha256: hash(native.additionalContext),
      droppedActivationIds: native.droppedActivationIds ?? [],
      oversizedActivationIds: native.oversizedActivationIds ?? [],
      truncated: native.truncated === true,
      warnings: native.warnings,
      modelSends: 0,
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  let fixture = null;
  if (args.fixtureResponse !== null) {
    fixture = args.fixtureResponse.trim().startsWith('{')
      ? JSON.parse(args.fixtureResponse)
      : JSON.parse(fs.readFileSync(path.resolve(args.fixtureResponse), 'utf8'));
    if (!['selected', 'none_applicable', 'uncertain'].includes(fixture.status)) throw new Error('INVALID_FIXTURE_RESPONSE');
    if (fixture.status === 'selected' && typeof fixture.ref !== 'string') throw new Error('INVALID_FIXTURE_RESPONSE');
  }
  const real = fixture === null;
  if (real && !args.approved) throw new Error('EXPLICIT_APPROVAL_REQUIRED');
  if (real && !process.env.ZAI_CODING_CN_API_KEY) throw new Error('MISSING_CREDENTIAL_REFERENCE');

  let payload = null;
  if (!real) {
    const { readPromptActivationCandidates } = await import('@principles/host-runtime');
    const read = await readPromptActivationCandidates({ workspaceDir, includeAuthority: true });
    const bounded = buildBoundedSelectionInput({
      currentInput: args.currentInput,
      priorMessages: args.prior,
      candidates: read.principles,
    });
    if (!bounded.ok) throw new Error(`SELECTION_INPUT_REFUSED:${bounded.reason}`);
    const chosen = fixture.status === 'selected'
      ? bounded.entries.find((entry) => entry.ref === fixture.ref)
      : null;
    if (fixture.status === 'selected' && !chosen) throw new Error('FIXTURE_REFERENCE_INVALID');
    payload = chosen
      ? { status: 'selected', id: chosen.ref, digest: hash(chosen.text) }
      : { status: fixture.status, id: null, digest: null };
  }

  const { PiAiRuntimeAdapter } = await import('../../../packages/principles-core/dist/runtime/adapter/pi-ai-runtime-adapter.js');
  const now = Date.now;
  const deadlineAt = now() + LIMITS.selectTimeoutMs;
  const selector = createSingleModelSelector({
    PiAiRuntimeAdapter,
    fetch: real ? globalThis.fetch : sseFetch(payload),
    now,
    deadlineAt,
  });
  const started = Date.now();
  const result = await runSelectionOpportunity({
    workspaceDir,
    roundKey: args.roundKey,
    promptBudget,
    currentInput: args.currentInput,
    priorMessages: args.prior,
    hookInvocationId: `cli-${started}`,
    deadlineAt,
    select: selector.select,
    selectorReport: selector.report,
  });
  const output = { mode: 'single-model', elapsedMs: Date.now() - started, selectorSystemSha256: hash(SELECTOR_SYSTEM), ...brief(result) };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'failed', reason: typeof error?.message === 'string' ? error.message : 'UNKNOWN' })}\n`);
    process.exitCode = 1;
  });
}
