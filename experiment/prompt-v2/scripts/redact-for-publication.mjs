/**
 * PD-SPEC-001 — field-level redaction for PUBLIC-repo publication.
 *
 * The frozen dataset/inventory contain verbatim production pain text (Owner
 * words, evidence notes, full pipeline artifacts). The repo is PUBLIC, so the
 * committed copies carry digests instead of verbatim strings; the FULL-fidelity
 * copies stay local (.tmp, gitignored, regenerable from the snapshot DBs via
 * the committed snapshot/freeze scripts). Digests are computed over the exact
 * original string so local/committed equivalence stays verifiable.
 */
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Fields whose string values are verbatim production content → digest placeholder. */
const REDACT_KEYS = new Set([
  'text', 'reason', 'reasonSummary', 'note', 'root_cause',
  'content_json', 'succeededRunOutputPayload', 'routerPersistedInput',
  'title', 'description', 'abstracted_principle', 'trigger_pattern', 'action',
]);

export function redactString(v) {
  return `«redacted sha256:${sha256(v).slice(0, 16)} len:${v.length}»`;
}

export function redactForPublication(value) {
  if (Array.isArray(value)) return value.map((v) => redactForPublication(v));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k) && typeof v === 'string' ? redactString(v) : redactForPublication(v);
    }
    return out;
  }
  return value;
}
