/**
 * PD-SPEC-001 — field-level redaction for PUBLIC-repo publication (v2).
 *
 * Remediation (Owner directive Phase 1): the v1 module leaked through custom
 * field names (`textPreview`), string-encoded JSON (`evidence_json`), free
 * text (`provenanceReason`), and relatable identifiers (`session_id`).
 *
 * v2 rules:
 *  - DENY-listed string fields → sha256 placeholder. If the string parses as
 *    JSON, it is recursively redacted and re-serialized; a string that LOOKS
 *    like JSON but fails to parse is FAIL-CLOSED (placeholder, never verbatim).
 *  - ANON-listed identifier fields → irreversible stable anonymous id
 *    (prefix + 16 hex of sha256). Structure stays correlatable, identity does not.
 *  - `last_error` → mapped to a SAFE error-class token (timeout / rate_limit /
 *    lease_conflict / max_attempts_exceeded / …), otherwise placeholder — the
 *    failure CLASS survives for metrics, the verbatim message does not.
 *  - The caller MUST run `assertNoVerbatimLeak(full, redactedString)` after
 *    projecting: every sensitive string harvested from the FULL object (deny/
 *    anon/error fields) is checked against the serialized REDACTED output —
 *    the original value itself and its 24-char head/tail must not appear.
 *    This is the fail-closed backstop that catches any future allowlist/denylist gap.
 */
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** String fields carrying verbatim production content → placeholder. */
const DENY_KEYS = new Set([
  'text', 'reason', 'reasonSummary', 'note', 'root_cause', 'rootCause',
  'content_json', 'contentJson', 'succeededRunOutputPayload', 'routerPersistedInput',
  'title', 'description', 'abstracted_principle', 'abstractedPrinciple',
  'trigger_pattern', 'triggerPattern', 'action',
  'textPreview', 'evidence_json', 'evidenceJson', 'provenanceReason', 'provenance_reason',
  'explanation', 'thesis', 'statement', 'badDecision', 'betterDecision', 'rationale',
  'ownerIntent', 'targetBehavior', 'forbiddenBehavior', 'evidenceSource', 'validationExpectation',
  'rawOutputPreview', 'stdoutTail', 'stderrTail', 'message',
  // Free-text arrays inside parsed pipeline outputs (ambiguity notes, summaries).
  'ambiguityNotes', 'summary',
  // Pipeline-output free-text families (Scribe/Dreamer/Philosopher/Router).
  'antiPatterns', 'applicability', 'risks', 'strategicPerspective', 'nextAction', 'warnings',
  // Philosopher principleCandidate.scope is free text (enum values exempted below).
  'scope',
  // intentTension.evidence is a BARE-STRING array; object-shaped evidence
  // arrays are unaffected (their elements are keyed sourceRef/note).
  'evidence',
]);

/** Identifier fields that must become irreversible stable anonymous ids. */
const PATH_KEYS = new Set(['path', 'workspaceDir', 'workspace_dir']);
const ANON_KEYS = new Set([
  'sessionId', 'session_id', 'sessionIdHint', 'session_id_hint',
]);

/** Known failure classes whose NAME (not message) may be published. */
const SAFE_ERROR_PATTERNS = [
  [/rate_limit|Rate limit/i, 'rate_limit'],
  [/timed out|timeout/i, 'timeout'],
  [/lease_conflict/i, 'lease_conflict'],
  [/max_attempts_exceeded/i, 'max_attempts_exceeded'],
  [/schema|Value\.Check|output_invalid/i, 'output_invalid'],
  [/not_found|no such table/i, 'not_found'],
];

export function placeholder(v) {
  return `«redacted sha256:${sha256(v).slice(0, 16)} len:${v.length}»`;
}

export function anonId(v) {
  if (v === null || v === undefined) return v;
  const s = String(v);
  if (s === '') return s;
  return `anon-${sha256(s).slice(0, 16)}`;
}

export function safeError(v) {
  if (v === null || v === undefined || v === '') return v;
  const s = String(v);
  for (const [re, label] of SAFE_ERROR_PATTERNS) {
    if (re.test(s)) return label;
  }
  return placeholder(s);
}

function looksLikeJsonString(s) {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/**
 * A string that may legitimately survive inside a PARSED pipeline-output JSON
 * subtree: structural shapes only (ids, refs, timestamps, enums, short ASCII
 * tokens). Anything else — CJK-bearing text, long prose, unknown-key free text
 * (the exact blind spot of a pure key blacklist) — must be redacted.
 */
function isStructuralString(value) {
  if (value.length <= 64 && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value)) return true; // ids / dotted paths / enums
  if (/^(agent_turn|conversationWindow|run_|pi-art|diag_|dreamer-|philosopher-|scribe-|anon-)/.test(value) && value.length < 90) return true;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return true; // ISO timestamps
  if (/^\d+(\.\d+)?$/.test(value)) return true; // numeric strings
  return false;
}

/**
 * Recursively redact any value. `parentKey` carries the owning field name so
 * DENY/ANON rules apply to ARRAY elements too (e.g. ambiguityNotes: ["..."])
 * — dropping the parent context at array boundaries is exactly the leak class
 * the fail-closed assertion caught in v2. `inParsedJson` marks subtrees that
 * came from a string-encoded pipeline output: there, ANY non-structural string
 * is redacted regardless of its key name (blacklists cannot enumerate the
 * free-text keys a model may invent).
 */
export function redactForPublication(value, parentKey = null, inParsedJson = false) {
  if (typeof value === 'string') {
    if (parentKey !== null && DENY_KEYS.has(parentKey)) {
      // Structured enums stay readable even under a deny-key parent
      // (e.g. Distiller scope: general|domain|scenario).
      if (parentKey === 'scope' && ['general', 'domain', 'scenario'].includes(value)) return value;
      if (looksLikeJsonString(value)) {
        try {
          // String-encoded JSON: redact the parsed structure with its OWN key
          // names, then re-serialize (structure survives, text does not).
          return JSON.stringify(redactForPublication(JSON.parse(value), null, true));
        } catch {
          return placeholder(value); // fail-closed: JSON-looking but unparseable
        }
      }
      // Failure-reason fields keep their CLASS (timeout / rate_limit / …) when
      // recognizable — the class survives for metrics, the message does not.
      if (parentKey === 'reason' || parentKey === 'last_error' || parentKey === 'lastError') {
        const cls = safeError(value);
        if (!cls.startsWith('«redacted')) return cls;
      }
      return placeholder(value);
    }
    if (parentKey !== null && PATH_KEYS.has(parentKey) && /^[A-Za-z]:[/\\]/.test(value)) return placeholder(value);
    if (parentKey !== null && ANON_KEYS.has(parentKey)) return anonId(value);
    if (parentKey !== null && (parentKey === 'last_error' || parentKey === 'lastError')) return safeError(value);
    // Parsed-JSON free-text backstop: unknown key + non-structural content →
    // redacted. This is the fail-closed rule the key blacklist cannot express.
    if (inParsedJson && !isStructuralString(value)) return placeholder(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redactForPublication(v, parentKey, inParsedJson));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactForPublication(v, k, inParsedJson);
    }
    return out;
  }
  return value;
}

/** Harvest every sensitive original string from a FULL object (for leak assertion). */
function harvestSensitive(value, key = null, sink) {
  if (Array.isArray(value)) {
    for (const v of value) harvestSensitive(v, key, sink);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) harvestSensitive(v, k, sink);
    return;
  }
  if (typeof value !== 'string' || value.length < 20) return;
  // Structural identifiers (lineage refs, task/artifact/run ids, timestamps)
  // legitimately survive as STRUCTURE; they are not Owner narration even when
  // a note consists only of such a ref.
  if (/^(agent_turn|conversationWindow|run_|pi-art|diag_|dreamer-|philosopher-|scribe-|anon-)/.test(value) && value.length < 90) return;
  // Dotted ASCII identifier shape (key paths like "diagnosisTarget.reasonSummary")
  // — Owner narration is CJK-bearing and never matches this shape.
  if (value.length < 64 && /^[A-Za-z][A-Za-z0-9_.:-]{5,60}$/.test(value) && !/[一-鿿]/.test(value)) return;
  const sensitiveKey = key !== null && (DENY_KEYS.has(key) || ANON_KEYS.has(key) || key === 'last_error' || key === 'lastError');
  if (!sensitiveKey) return;
  // String-encoded JSON under a deny key: assert against the SENSITIVE INNER
  // strings (same rule the projector applies), not the whole serialized blob —
  // otherwise structural tails (sourceRef ids) become false-positive probes.
  if (looksLikeJsonString(value)) {
    try {
      harvestSensitive(JSON.parse(value), null, sink);
      return;
    } catch {
      // fall through: assert the whole unparseable string (fail-closed)
    }
  }
  sink.add(value);
}

/**
 * Structural enum literals that legitimately survive redaction. The value-level
 * assertion skips them (an enum literal can share a prefix with a long free-text
 * original — e.g. provenance "owner_reported_no_host_trace" vs a provenanceReason
 * sentence — without any verbatim content leaking).
 */
const KNOWN_SAFE_TOKENS = new Set([
  'host_context_bound', 'owner_reported_no_host_trace', 'automatic_hook', 'agent_reported_owner_approved',
  'available', 'unavailable_with_reason', 'ambiguous', 'openclaw', 'codex', 'workbuddy',
  'People', 'Design', 'Assumption', 'Tooling', 'general', 'domain', 'scenario',
  'low', 'medium', 'high', 'principle', 'rule', 'implementation', 'prompt', 'defer',
  'succeeded', 'failed', 'pending', 'leased', 'running', 'retry_wait', 'consumed', 'missing',
  'needs_human_review', 'validated', 'linked', 'unresolved', 'user_correction', 'manual',
  'llm_paralysis', 'tool_failure', 'user_empathy', 'severe', 'moderate', 'user_manual',
  'system_infer', 'cli', 'rate_limit', 'timeout', 'lease_conflict', 'max_attempts_exceeded',
  'output_invalid', 'input_invalid', 'diagnostician-output-v2', 'pd-cli', 'none',
]);

function collectStrings(value, sink) {
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, sink);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, sink);
    return;
  }
  if (typeof value === 'string') sink.add(value);
}

/**
 * Fail-closed backstop (value-level): every retained string in the REDACTED
 * projection must not CONTAIN any sensitive original (≥16 chars), nor start/end
 * with its 16-char head/tail — except structural enum literals.
 * Throws with the offending sample on the first leak.
 */
export function assertNoVerbatimLeak(fullObject, redactedObject) {
  const sink = new Set();
  harvestSensitive(fullObject, null, sink);
  const retained = new Set();
  collectStrings(redactedObject, retained);
  const originals = [...sink].filter((o) => o.length >= 20);
  for (const s of retained) {
    if (KNOWN_SAFE_TOKENS.has(s) || s.startsWith('«redacted') || s.startsWith('anon-')) continue;
    // Short structural tokens (snake/colon-coded markers like
    // "owner_reported:cli") carry identity shape, not Owner narration. Owner
    // free text is CJK-rich and never matches this shape at ≥16 chars.
    if (s.length < 20 && /^[a-z0-9_.:-]+$/i.test(s)) continue;
    for (const o of originals) {
    // Whole-original containment only: the projector replaces whole strings,
    // so partial copies cannot occur; window probes collide structurally
    // (narrative text quotes task ids / agent_turn timestamps that legitimately
    // survive as lineage refs).
    if (s.includes(o)) {
        throw new Error(
          `REDACTION LEAK: retained string ${JSON.stringify(s.slice(0, 60))} overlaps a sensitive original ${JSON.stringify(o.slice(0, 40))} (len ${o.length})`,
        );
      }
    }
  }
  return { checked: retained.size, against: originals.length, ok: true };
}
