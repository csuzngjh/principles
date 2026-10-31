export interface ApprovalReviewMaterial {
  availability: 'available' | 'missing' | 'unreadable'; artifactId: string;
  statement: string | null; rationale: string | null; scope: string[]; risks: string[] | null; targetBehavior: string | null;
  exactBody: { kind: 'principle' | 'rule_code'; text: string } | null;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value : null; }
/** Whitelisted normative fields only; raw artifact JSON is never returned. */
export function approvalReviewMaterial(artifactId: string, channel: string, contentJson: string | null): ApprovalReviewMaterial {
  const result: ApprovalReviewMaterial = { artifactId, availability: contentJson === null ? 'missing' : 'unreadable', statement: null, rationale: null, scope: [], risks: null, targetBehavior: null, exactBody: null };
  if (contentJson === null) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(contentJson); } catch { return result; }
  if (!record(parsed)) return result;
  if (record(parsed.intentContract)) result.targetBehavior = text(parsed.intentContract.targetBehavior);
  if (Array.isArray(parsed.risks) && parsed.risks.every(item => typeof item === 'string')) result.risks = parsed.risks;
  const draft = record(parsed.principleDraft) ? parsed.principleDraft : parsed;
  result.statement = text(draft.statement);
  result.rationale = text(draft.rationale);
  if (Array.isArray(draft.applicability) && draft.applicability.every(item => typeof item === 'string')) result.scope = draft.applicability;
  const body = channel === 'code_tool_hook' ? text(parsed.implementationCode) : result.statement;
  if (body !== null) {
    result.exactBody = { kind: channel === 'code_tool_hook' ? 'rule_code' : 'principle', text: body };
    result.availability = 'available';
  }
  return result;
}
