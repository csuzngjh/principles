import type { ActivationStatusRecord } from './activation-types.js';
import { createHash } from 'node:crypto';

/**
 * Reference principle budget for a 128K-token window (UTF-16 code units).
 *
 * This is the SAME anchor as `PROMPT_BUDGET_BASE_CHARS` (prompt-budget-policy):
 * the historical fixed budget and the current fallback for hosts with no
 * capacity fact. v2 recalibration (PRI-1066) raised it 2000 → 4000 because
 * Owner-visible capacity ran out after a few activations; it is a policy
 * anchor, not a measured optimum. Events computed under the previous value
 * carry the old `policyVersion` and are skipped (and counted) by the reader
 * instead of being silently reinterpreted.
 */
export const RUNTIME_PRINCIPLE_BUDGET = 4000;

export interface ActivatedPrinciple {
  principleId: string;
  /**
   * `ledger_uuid` for formal records; `legacy_title` for activations whose
   * target predates formal UUIDs. Legacy identities may inject (continuity) but
   * must never be written as a new application-ledger receipt.
   */
  identityKind?: 'ledger_uuid' | 'legacy_title';
  text: string;
  artifactId: string;
  activationId: string;
  /** Exact governed artifact content_json bytes, separate from rendered directive hash. */
  artifactContentSha256?: string;
  /**
   * 谁授权了这条激活 (INV-05, P0-G):
   * - owner: 经 approvals 队列 approve (derived join on artifact_id+channel)
   * - system_policy: PRI-811 Phase B 前的存量行 — 旧低风险渠道 policy 自动
   *   激活 (无 approval 行)；Phase B 起不再产生新的 system_policy 激活
   * - undefined: 读取层无法判定 (旧数据/查询失败) — 渲染层不得声称 owner
   */
  authority?: 'owner' | 'system_policy';
  /** owner 授权时的决定者 (approvals.decided_by) */
  approvedBy?: string;
}

export interface PromptActivationReaderResult {
  principles: ActivatedPrinciple[];
  warnings: string[];
  source: 'runtime_v2';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function filterPromptActivations(
  activations: ActivationStatusRecord[],
): ActivationStatusRecord[] {
  return activations.filter(
    (a) => a.channel === 'prompt' && a.action === 'prompt_activate' && a.deactivatedAt === null,
  );
}

const LEDGER_PRINCIPLE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Formal principle identity: a ledger UUID, never a generated title. */
function formalPrincipleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!LEDGER_PRINCIPLE_ID_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function activationTargetPrincipleId(targetRef: unknown): { kind: 'preview' | 'invalid' | 'legacy' | 'id'; id?: string; label?: string } {
  if (typeof targetRef !== 'string' || targetRef.trim() === '') return { kind: 'invalid' };
  const trimmed = targetRef.trim();
  // The deliverability preview asks about a candidate that has no activation
  // record yet; it deliberately passes a synthetic pending:// target.
  if (trimmed.startsWith('pending://')) return { kind: 'preview' };
  if (!trimmed.startsWith('ledger://')) return { kind: 'invalid' };
  const raw = trimmed.slice('ledger://'.length).trim();
  const id = formalPrincipleId(raw);
  // Old activations used the principle title as the ledger target. They are
  // kept working as `legacy_title`, but never promoted to a formal UUID.
  return id === null ? { kind: 'legacy', label: raw } : { kind: 'id', id };
}

export function resolvePrincipleFromArtifact(
  artifactRow: unknown,
  activation: ActivationStatusRecord,
): { ok: true; principle: ActivatedPrinciple } | { ok: false; warning: string } {
  if (!isRecord(artifactRow)) {
    return { ok: false, warning: `artifact_query_unexpected: artifactId=${activation.artifactId}; nextAction=check_pi_artifacts_table` };
  }

  const artifact_id = Object.hasOwn(artifactRow, 'artifact_id') && typeof artifactRow.artifact_id === 'string' && artifactRow.artifact_id.length > 0 ? artifactRow.artifact_id : null;
  const artifact_kind = Object.hasOwn(artifactRow, 'artifact_kind') && typeof artifactRow.artifact_kind === 'string' ? artifactRow.artifact_kind : null;
  const raw_content_json = Object.hasOwn(artifactRow, 'content_json') && typeof artifactRow.content_json === 'string' ? artifactRow.content_json : null;
  const validation_status = Object.hasOwn(artifactRow, 'validation_status') && typeof artifactRow.validation_status === 'string' ? artifactRow.validation_status : null;
  const source_principle_id = Object.hasOwn(artifactRow, 'source_principle_id') && typeof artifactRow.source_principle_id === 'string' ? artifactRow.source_principle_id : null;

  if (!artifact_id) {
    return { ok: false, warning: `artifact_not_found: artifactId=${activation.artifactId} activationId=${activation.activationId}; nextAction=verify_artifact_exists_or_remove_stale_activation` };
  }

  if (artifact_kind !== 'principle') {
    return { ok: false, warning: `artifact_not_principle: artifactId=${artifact_id} kind=${artifact_kind ?? 'missing'}; nextAction=skip_non_principle_activations` };
  }

  if (validation_status !== 'validated') {
    return { ok: false, warning: `artifact_not_validated: artifactId=${artifact_id} status=${validation_status ?? 'missing'}; nextAction=skip_unvalidated_artifacts` };
  }

  if (raw_content_json === null) {
    return { ok: false, warning: `artifact_missing_content_json: artifactId=${artifact_id}; nextAction=ensure_artifact_has_content_json` };
  }

  const parsed = safeJsonParse(raw_content_json);
  if (parsed === null) {
    return { ok: false, warning: `artifact_content_json_parse_error: artifactId=${activation.artifactId} reason=invalid_json; nextAction=fix_artifact_content_json` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, warning: `artifact_content_malformed: artifactId=${activation.artifactId} reason=parsed_to_non_object; nextAction=fix_artifact_content_json` };
  }

  const text = Object.hasOwn(parsed, 'text') && typeof parsed.text === 'string' ? parsed.text : undefined;
  const draftObj = Object.hasOwn(parsed, 'principleDraft') && isRecord(parsed.principleDraft) ? parsed.principleDraft : null;
  // principleDraft.title is DISPLAY/LINEAGE ONLY. It is never a formal id:
  // titles fragmented the identity space (principle-identity-reconciliation F1).
  const draftStatement = draftObj && Object.hasOwn(draftObj, 'statement') && typeof draftObj.statement === 'string' ? draftObj.statement : undefined;

  const columnId = formalPrincipleId(source_principle_id);
  const contentRawId = Object.hasOwn(parsed, 'principleId') ? parsed.principleId : undefined;
  const contentAltId = Object.hasOwn(parsed, 'sourcePrincipleId') ? parsed.sourcePrincipleId : undefined;
  const contentId = formalPrincipleId(contentRawId) ?? formalPrincipleId(contentAltId);
  const rawColumnId = typeof source_principle_id === 'string' ? source_principle_id.trim() : '';
  const rawContentId = typeof contentRawId === 'string' && contentRawId.trim() !== ''
    ? contentRawId.trim()
    : typeof contentAltId === 'string' && contentAltId.trim() !== '' ? contentAltId.trim() : '';
  const resolvedPrincipleId = columnId ?? contentId;

  // Two UUID authorities in the same artifact must agree; a conflict is data
  // drift, not an invitation to pick the friendlier one.
  if (columnId !== null && contentId !== null && columnId !== contentId) {
    return { ok: false, warning: `artifact_identity_conflict: artifactId=${artifact_id} column=${columnId} content=${contentId}; nextAction=run_principle_identity_reconciliation` };
  }

  const target = activationTargetPrincipleId(activation.targetRef);
  if (target.kind === 'invalid') {
    return { ok: false, warning: `activation_target_ref_invalid: activationId=${activation.activationId} targetRef=${String(activation.targetRef).slice(0, 120)}; nextAction=repair_activation_target_ref_to_ledger_uuid` };
  }

  // Legacy records (activation targeted by the old title form) still inject so
  // the Owner's already-approved principles keep working, but they are NEVER
  // promoted to a formal identity: no UUID is generated, a UUID on the artifact
  // conflicts with the title target, and the application ledger must not record
  // a new title-keyed receipt (prompt.ts checks identityKind).
  let identityKind: 'ledger_uuid' | 'legacy_title' = 'ledger_uuid';
  let principleIdForResolution: string | null = resolvedPrincipleId;
  if (target.kind === 'legacy') {
    const legacyLabel = typeof target.label === 'string' ? target.label : '';
    if (legacyLabel === '') {
      return { ok: false, warning: `activation_target_ref_invalid: activationId=${activation.activationId}; nextAction=repair_activation_target_ref_to_ledger_uuid` };
    }
    if (resolvedPrincipleId !== null) {
      return { ok: false, warning: `activation_artifact_principle_id_mismatch: activationId=${activation.activationId} target=${legacyLabel} artifact=${resolvedPrincipleId}; nextAction=run_principle_identity_reconciliation` };
    }
    if (rawColumnId !== '' && rawColumnId !== legacyLabel) {
      return { ok: false, warning: `artifact_identity_conflict: artifactId=${artifact_id} column=${rawColumnId.slice(0, 80)} target=${legacyLabel.slice(0, 80)}; nextAction=run_principle_identity_reconciliation` };
    }
    if (rawContentId !== '' && rawContentId !== legacyLabel) {
      return { ok: false, warning: `artifact_identity_conflict: artifactId=${artifact_id} content=${rawContentId.slice(0, 80)} target=${legacyLabel.slice(0, 80)}; nextAction=run_principle_identity_reconciliation` };
    }
    identityKind = 'legacy_title';
    principleIdForResolution = legacyLabel;
  } else if (target.kind === 'preview') {
    // Pre-activation forecast (deliverability precheck): there is no activation
    // record yet, so the candidate is measured under its OWN declared identity.
    // A formal UUID is preferred; a legacy label is used as-is and never
    // upgraded or invented from principleDraft.title, and conflicting sources
    // still refuse. Real activations keep the strict UUID gate below.
    if (rawColumnId !== '' && rawContentId !== '' && rawColumnId !== rawContentId) {
      return { ok: false, warning: `artifact_identity_conflict: artifactId=${artifact_id} column=${rawColumnId.slice(0, 80)} content=${rawContentId.slice(0, 80)}; nextAction=run_principle_identity_reconciliation` };
    }
    const declared = resolvedPrincipleId ?? (rawColumnId !== '' ? rawColumnId : rawContentId);
    identityKind = resolvedPrincipleId !== null ? 'ledger_uuid' : 'legacy_title';
    principleIdForResolution = declared !== '' ? declared : null;
  } else {
    // Formal paths (ledger UUID / preview) require a real UUID and never accept
    // a title in its place.
    if (rawColumnId !== '' && columnId === null) {
      return { ok: false, warning: `artifact_principle_id_not_uuid: artifactId=${artifact_id} value=${rawColumnId.slice(0, 80)}; nextAction=stamp_pi_artifacts_source_principle_id_with_the_ledger_uuid` };
    }
    if (resolvedPrincipleId === null) {
      if (rawColumnId !== '' || rawContentId !== '') {
        return { ok: false, warning: `artifact_principle_id_not_uuid: artifactId=${artifact_id} value=${(rawColumnId || rawContentId).slice(0, 80)}; nextAction=stamp_the_artifact_with_the_ledger_uuid` };
      }
      return { ok: false, warning: `artifact_missing_principle_id: artifactId=${activation.artifactId}; nextAction=ensure_artifact_has_a_ledger_uuid_identity` };
    }
    if (target.kind === 'id' && target.id !== resolvedPrincipleId) {
      return { ok: false, warning: `activation_artifact_principle_id_mismatch: activationId=${activation.activationId} target=${target.id} artifact=${resolvedPrincipleId}; nextAction=run_principle_identity_reconciliation` };
    }
  }

  const resolvedText = text && text.length > 0 ? text : draftStatement;
  if (principleIdForResolution === null) {
    return { ok: false, warning: `artifact_missing_principle_id: artifactId=${activation.artifactId}; nextAction=ensure_artifact_has_a_ledger_uuid_identity` };
  }
  if (!resolvedText || resolvedText.length === 0) {
    return { ok: false, warning: `artifact_missing_text: artifactId=${activation.artifactId} principleId=${principleIdForResolution}; nextAction=ensure_artifact_has_text_or_principleDraft_statement` };
  }

  return {
    ok: true,
    principle: {
      principleId: principleIdForResolution,
      identityKind,
      text: resolvedText,
      artifactContentSha256: createHash('sha256').update(raw_content_json, 'utf8').digest('hex'),
      artifactId: activation.artifactId,
      activationId: activation.activationId,
    },
  };
}

/**
 * PRI-904 (SPEC v0.1): which budget-packing policy produced a selection.
 *
 * - `legacy_fifo_prefix_v1` — the pre-PRI-904 policy and the rollback target:
 *   greedy prefix packing in base order, first non-fit breaks. Also the
 *   characterization baseline reproducing the audited 16→9/1893 behavior.
 * - `fair_rotation_v1` — deterministic rotating start + circular
 *   continue-on-non-fit packing. Eliminates permanent positional starvation
 *   under the fixed budget without randomness or persisted cursors.
 */
export type PromptSelectionPolicy = 'legacy_fifo_prefix_v1' | 'fair_rotation_v1';

export interface TrimToBudgetResult {
  lines: string[];
  injectedIds: Set<string>;
  truncated: boolean;
  /** PRI-904: policy that produced this selection. */
  selectionPolicy: PromptSelectionPolicy;
  /** PRI-904: candidates that reached the budget selector (post eligibility + dedup). */
  eligibleCount: number;
  /** PRI-904: circular scan start; present only under fair_rotation_v1. */
  rotationStartIndex?: number;
  /**
   * PRI-904 (bounded, max 16): activation ids dropped because the remaining
   * budget was insufficient. Ordered by scan position.
   */
  droppedActivationIds: string[];
  /**
   * PRI-904 (bounded, max 16): activation ids whose single entry exceeds the
   * whole principle budget — they can never fit alone and are not starvation.
   */
  oversizedActivationIds: string[];
}

/** PRI-904 SPEC §10: hard cap for diagnostic id lists in telemetry. */
const MAX_INJECTION_DIAGNOSTIC_IDS = 16;

/**
 * PRI-904: the round key is a deterministic session-local user-turn ordinal
 * (see `nextSessionTurnOrdinal` in the registered trajectory-store seam) —
 * NOT a hash of an opaque run identity. Because consecutive recorded user
 * turns yield consecutive ordinals, N consecutive rounds cover all N
 * positions of an N-entry eligible ring: a bounded opportunity window, not a
 * statistical one. Both injection routes read the same fact, so their
 * fairness semantics are identical.
 */
/**
 * The single authority for the list route's serialized entry line format.
 * `trimToBudget` measures entries through this helper; capacity prechecks and
 * status projections must measure through it too instead of re-typing the
 * format (PD_PROMPT_CAPACITY_V1 R-A2: costs come from the production
 * serializer, not an approximation).
 */
export function listEntryLine(
  principle: { principleId: string; text: string },
  escapeFn: (s: string) => string = (s) => s,
): string {
  return `- [${escapeFn(principle.principleId)}] ${escapeFn(principle.text)}`;
}

// PRI-904: the optional roundKey extends the frozen 3-param public surface
// positionally rather than via an options bag — existing callers (plugin hook,
// console projection, tests) pass (principles, budget, escapeFn?) and must not
// be rewritten for a scheduling-policy extension.
// eslint-disable-next-line @typescript-eslint/max-params
export function trimToBudget(
  principles: ActivatedPrinciple[],
  budget: number,
  escapeFn: (s: string) => string = (s) => s,
  roundKey?: number,
): TrimToBudgetResult {
  const lines: string[] = [];
  const injectedIds = new Set<string>();
  let remaining = budget;
  let truncated = false;

  const header = 'Runtime V2 activated principles:';
  lines.push(header);
  remaining -= header.length;

  const eligibleCount = principles.length;
  // The most budget any single entry can ever claim: an otherwise empty payload.
  const emptyPayloadRemaining = remaining;
  const droppedActivationIds: string[] = [];
  const oversizedActivationIds: string[] = [];

  if (roundKey === undefined || principles.length === 0) {
    // legacy_fifo_prefix_v1 — byte-identical to the pre-PRI-904 loop: greedy
    // prefix packing, first non-fit breaks. Rollback = omit the round key.
    for (const p of principles) {
      const entry = listEntryLine(p, escapeFn);
      if (remaining < entry.length + 1) {
        truncated = true;
        // The loop breaks here, so both lists hold at most this one entry —
        // no cap guard needed on the legacy path.
        if (entry.length + 1 > emptyPayloadRemaining) {
          oversizedActivationIds.push(p.activationId);
        } else {
          droppedActivationIds.push(p.activationId);
        }
        break;
      }
      lines.push(entry);
      remaining -= entry.length + 1;
      injectedIds.add(p.principleId);
    }
    return { lines, injectedIds, truncated, selectionPolicy: 'legacy_fifo_prefix_v1', eligibleCount, droppedActivationIds, oversizedActivationIds };
  }

  // fair_rotation_v1 — deterministic rotating start over the base (ASC) order,
  // circular scan, continue-on-non-fit. Entry costs keep the exact legacy
  // arithmetic (serialized entry + 1 newline), so budget accounting is
  // unchanged: every round stays within `budget`.
  const n = principles.length;
  const rotationStartIndex = ((roundKey % n) + n) % n;
  const ring = principles.slice(rotationStartIndex).concat(principles.slice(0, rotationStartIndex));
  for (const p of ring) {
    const entry = listEntryLine(p, escapeFn);
    const cost = entry.length + 1;
    if (cost > emptyPayloadRemaining) {
      // Cannot fit even in an empty payload — oversize, not starvation.
      if (oversizedActivationIds.length < MAX_INJECTION_DIAGNOSTIC_IDS) oversizedActivationIds.push(p.activationId);
      continue;
    }
    if (cost <= remaining) {
      lines.push(entry);
      remaining -= cost;
      injectedIds.add(p.principleId);
    } else {
      // Non-fit no longer terminates the scan: a later, shorter entry may
      // still fit (PRI-904 SPEC §6.5).
      truncated = true;
      if (droppedActivationIds.length < MAX_INJECTION_DIAGNOSTIC_IDS) droppedActivationIds.push(p.activationId);
    }
  }

  return { lines, injectedIds, truncated, selectionPolicy: 'fair_rotation_v1', eligibleCount, rotationStartIndex, droppedActivationIds, oversizedActivationIds };
}

interface RenderDirectivesOptions {
  /** XML-escape function applied to principle ids and texts. */
  escapeFn?: (s: string) => string;
  /**
   * PRI-532 (SPEC §5.2): append the agent self-report instruction footer.
   * When a directive actually changes the agent's behavior this turn, the
   * agent appends one 📌 line echoing the directive id — captured by the
   * plugin's llm_output / before_message_write handlers.
   */
  selfReportInstruction?: boolean;
}

// ── Directive line builders (PRI-1137 final review P1-2) ─────────────────────
//
// The renderer is STRICTLY ADDITIVE over per-principle directive blocks: a
// non-empty render is
//   header lines + Σ per-principle block lines + footer lines + note line,
// all joined with '\n'. Splitting the builders out lets the packer measure
// each principle's exact marginal chars ONCE (instead of re-rendering the
// whole growing prefix per candidate — the retired O(N²) pack loop) while
// keeping the billing arithmetic and the renderer one source of truth: the
// builders below are the ONLY place the lines exist, and
// `measureSharedDirectiveBlockChars` / `sharedDirectiveBaseChars` derive from
// them, so a renderer edit cannot silently fork the measurement.

function sharedDirectiveHeaderLines(): string[] {
  return [
    '',
    // P0-G (MVP_CORE_LOOP_CONTRACT INV-05 / §12): 中性标题。低风险渠道的
    // system-policy 自动激活不得被表示为 Owner-approved; 具体授权逐项标注
    // authority 属性 (owner=审批队列批准, system_policy=策略自动激活)。
    '## 【ACTIVE BEHAVIOR DIRECTIVES】',
    '',
    'Active behavior directives are operating constraints learned from prior owner corrections. Each directive carries its authorization: authority="owner" (approved in the owner approval queue) or authority="system_policy" (auto-activated by low-risk policy).',
    // PRI-1161 (Owner-approved card v0.1): the per-block "Apply this as an
    // active behavior constraint..." line was hoisted HERE, stated once in the
    // shared position, instead of repeating verbatim inside every directive
    // block (86 chars × N blocks; 85-char sentence + one newline).
    // Same instruction, one copy.
    'These directives are mandatory active behavior constraints for this session, not background context, unless they conflict with safety, security, or higher-priority system policy.',
    'For ambiguous coding or file-changing tasks, follow these directives before using mutating tools.',
    '',
  ];
}

function sharedDirectiveBlockLines(
  p: { principleId: string; text: string; authority?: 'owner' | 'system_policy' },
  escapeFn: (s: string) => string,
): string[] {
  // authority 已知才标注; 未知(旧数据/查询失败)宁缺毋假 (INV-05)
  const authorityAttr = p.authority === 'owner' || p.authority === 'system_policy'
    ? ` authority="${p.authority}"`
    : '';
  // PRI-1161: the per-block boilerplate line was hoisted to the shared header
  // (stated once); per-principle fields (id, authority, escaped text) and the
  // `<directive>` boundaries forensics slices on are unchanged.
  return [
    `<directive id="${escapeFn(p.principleId)}" source="runtime_v2_activation"${authorityAttr}>`,
    `MANDATORY: ${escapeFn(p.text)}`,
    '</directive>',
    '',
  ];
}

function sharedDirectiveFooterLines(selfReportInstruction: boolean): string[] {
  if (!selfReportInstruction) return [];
  return [
    'Self-report (OWNER visibility): when a directive above actually changes what you do in this turn, append exactly ONE line at the end of your reply in this format:',
    '📌 应用了你的原则「<directive id>」：<用一句话说明你这次做法有何不同>',
    'Use the directive\'s exact id attribute. At most one line per directive per session. Omit the line entirely if no directive changed your behavior.',
    '',
  ];
}

function sharedDirectiveNoteLines(): string[] {
  return ['Note: These directives do not override safety, security, or core system policy.'];
}

/**
 * PRI-1137 final review P1-2: the EXACT marginal UTF-16 chars one principle's
 * directive block adds to ANY non-empty render — its 5 block line lengths plus
 * the 5 `\n` separators those lines contribute to the join. Derived from the
 * same builders as `renderPrinciplesToDirectives`, so measurement and render
 * cannot drift. Packer decisions computed from this value are byte-identical
 * to re-rendering the candidate prefix (locked by property tests).
 */
export function measureSharedDirectiveBlockChars(
  principle: { principleId: string; text: string; authority?: 'owner' | 'system_policy' },
  options?: RenderDirectivesOptions,
): number {
  const escapeFn = options?.escapeFn ?? ((s) => s);
  const lines = sharedDirectiveBlockLines(principle, escapeFn);
  // `lines.length` block lines join the array: each contributes one preceding '\n'.
  return lines.reduce((sum, line) => sum + line.length, 0) + lines.length;
}

/**
 * PRI-1137 final review P1-2: chars every NON-EMPTY render carries regardless
 * of which/how many principles are injected — header + footer + note line
 * lengths plus their separators. For any non-empty set S:
 *   render(S).length === sharedDirectiveBaseChars(options) + Σ blockChars(p).
 */
export function sharedDirectiveBaseChars(options?: RenderDirectivesOptions): number {
  const lines = [
    ...sharedDirectiveHeaderLines(),
    ...sharedDirectiveFooterLines(options?.selfReportInstruction === true),
    ...sharedDirectiveNoteLines(),
  ];
  return lines.reduce((sum, line) => sum + line.length, 0) + lines.length - 1;
}

export function renderPrinciplesToDirectives(
  principles: { principleId: string; text: string; artifactId: string; activationId: string; authority?: 'owner' | 'system_policy'; approvedBy?: string }[],
  injectedIds: Set<string>,
  options?: RenderDirectivesOptions,
): string {
  if (injectedIds.size === 0) return '';
  const escapeFn = options?.escapeFn ?? ((s) => s);
  const directiveLines: string[] = [
    ...sharedDirectiveHeaderLines(),
  ];
  for (const p of principles) {
    if (!injectedIds.has(p.principleId)) continue;
    directiveLines.push(...sharedDirectiveBlockLines(p, escapeFn));
  }
  directiveLines.push(...sharedDirectiveFooterLines(options?.selfReportInstruction === true));
  directiveLines.push(...sharedDirectiveNoteLines());
  return directiveLines.join('\n');
}
