import { createHash, randomUUID } from 'node:crypto';
import {
  SqliteConnection, SqliteActivationSafetyStore, evaluateRuleCodeSafetyCircuit,
  initialRuleCodeSafetyCircuitState,
} from '@principles/core/runtime-v2';
import type { RuleCodeSafetyCircuitState } from '@principles/core/runtime-v2';

const states = new Map<string, RuleCodeSafetyCircuitState>();
const PROTECTED_COMMAND = /\bpd\s+(?:status|activation\s+deactivate|activation\s+emergency-pause|review)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export function observeRuleCodeSafety(input: { workspaceDir: string; activationId?: string; toolName: string; params: Record<string, unknown>; decision: string; matched: boolean; healthFailure?: 'load' | 'compatibility' | 'context' | 'invalid_result' | 'timeout' | 'exception'; logger?: { warn?: (message: string) => void } }): boolean {
  if (!input.activationId) return false;
  const command = typeof input.params.command === 'string' ? input.params.command : typeof input.params.args === 'string' ? input.params.args : '';
  const protectedCapabilityMatched = input.matched && PROTECTED_COMMAND.test(command);
  const key = `${input.workspaceDir}\0${input.activationId}`;
  const current = states.get(key) ?? initialRuleCodeSafetyCircuitState();
  const evaluated = evaluateRuleCodeSafetyCircuit(current, {
    toolName: input.toolName,
    decision: input.decision === 'block' || input.decision === 'requireApproval' || input.decision === 'auto_correct' ? input.decision : 'allow',
    outsideApprovedScope: false,
    protectedCapabilityMatched,
    healthFailure: input.healthFailure,
  });
  states.set(key, evaluated.state);
  if (!evaluated.trip) return false;
  try {
    const connection = new SqliteConnection({ workspaceDir: input.workspaceDir, readonly: false });
    const db = connection.getDb();
    const row: unknown = db.prepare(`SELECT a.artifact_id, a.activation_id, p.content_json, c.version FROM activations a JOIN pi_artifacts p ON p.artifact_id = a.artifact_id JOIN activation_control_states c ON c.activation_id = a.activation_id WHERE a.activation_id = ? AND a.deactivated_at IS NULL`).get(input.activationId);
    if (!isRecord(row)) throw new Error('Circuit-breaker activation facts unavailable');
    const artifactId = Object.hasOwn(row, 'artifact_id') ? row.artifact_id : undefined;
    const contentJson = Object.hasOwn(row, 'content_json') ? row.content_json : undefined;
    const version = Object.hasOwn(row, 'version') ? row.version : undefined;
    if (typeof artifactId !== 'string' || typeof contentJson !== 'string' || typeof version !== 'number') throw new Error('Circuit-breaker activation facts malformed');
    const artifactDigest = `sha256:${createHash('sha256').update(contentJson, 'utf8').digest('hex')}`;
    void new SqliteActivationSafetyStore(connection).safetyIsolate({
      decisionId: `decision-${randomUUID()}`,
      subject: { kind: 'activation', activationId: input.activationId, artifactId, artifactDigest },
      decision: 'safety_isolate', principal: { kind: 'system_safety', policyVersion: 'rulecode-circuit-v1' },
      authentication: { method: 'system' }, reasonCode: evaluated.trip, note: 'Automatic fail-open isolation protected host liveness.',
      evidenceSnapshotId: null, decidedAt: new Date().toISOString(),
    }, version).catch(error => input.logger?.warn?.(`[PD_GATE] Circuit isolation failed: ${String(error)}`)).finally(() => connection.close());
    return true;
  } catch (error: unknown) {
    input.logger?.warn?.(`[PD_GATE] Circuit breaker tripped but durable isolation failed; current host call remains fail-open: ${String(error)}`);
    return true;
  }
}

export function resetRuleCodeSafetyCircuitsForTests(): void { states.clear(); }
