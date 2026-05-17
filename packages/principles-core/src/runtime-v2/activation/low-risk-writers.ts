import type { PIArtifactSnapshot, CanActivateResult, ChannelWriter, WriterInput, WriterResult } from './activation-types.js';

function extractPrincipleId(artifact: PIArtifactSnapshot): string | null {
  if (typeof artifact.sourcePrincipleId === 'string') {
    const sourceId = artifact.sourcePrincipleId.trim();
    if (sourceId !== '') return sourceId;
  }
  try {
    const parsed = JSON.parse(artifact.contentJson) as Record<string, unknown>;
    if (typeof parsed.principleId === 'string' && parsed.principleId.trim() !== '') {
      return parsed.principleId.trim();
    }
    if (typeof parsed.sourcePrincipleId === 'string' && parsed.sourcePrincipleId.trim() !== '') {
      return parsed.sourcePrincipleId.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export class PromptWriter implements ChannelWriter {
  readonly channel = 'prompt' as const;

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async canActivate(artifact: PIArtifactSnapshot): Promise<CanActivateResult> {
    if (artifact.artifactKind !== 'principle') {
      return { ok: false, reason: 'artifact_kind_not_principle', riskLevel: 'low' };
    }
    if (artifact.validationStatus !== 'validated') {
      return { ok: false, reason: `artifact_validation_status_${artifact.validationStatus}`, riskLevel: 'low' };
    }
    const principleId = extractPrincipleId(artifact);
    if (!principleId) {
      return { ok: false, reason: 'no_principle_id_in_artifact', riskLevel: 'low' };
    }
    return { ok: true, riskLevel: 'low' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async activate(input: WriterInput, _artifact: PIArtifactSnapshot): Promise<WriterResult> {
    return {
      activationId: `act_prompt_${input.principleId}`,
      action: 'prompt_activate',
      targetRef: `ledger://${input.principleId}`,
    };
  }
}

export class DeferArchiveWriter implements ChannelWriter {
  readonly channel = 'defer_archive' as const;

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async canActivate(artifact: PIArtifactSnapshot): Promise<CanActivateResult> {
    if (artifact.artifactKind !== 'principle') {
      return { ok: false, reason: 'artifact_kind_not_principle', riskLevel: 'low' };
    }
    if (artifact.validationStatus !== 'validated') {
      return { ok: false, reason: `artifact_validation_status_${artifact.validationStatus}`, riskLevel: 'low' };
    }
    const principleId = extractPrincipleId(artifact);
    if (!principleId) {
      return { ok: false, reason: 'no_principle_id_in_artifact', riskLevel: 'low' };
    }
    return { ok: true, riskLevel: 'low' };
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async activate(input: WriterInput, _artifact: PIArtifactSnapshot): Promise<WriterResult> {
    return {
      activationId: `act_archive_${input.principleId}`,
      action: 'defer_archive',
      targetRef: `ledger://${input.principleId}#archived`,
    };
  }
}

export { extractPrincipleId };
