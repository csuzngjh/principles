/**
 * Diagnostic Pipeline Quality Evaluation Script
 *
 * Tests the split diagnostic pipeline's prompts against multiple SenseNova models
 * to compare output quality with local LM Studio results.
 *
 * Usage:
 *   SENSENOVA_API_KEY=sk-xxx npx tsx scripts/eval-diag-quality.ts
 *
 * DO NOT commit API keys to the repo.
 */

const SENSENOVA_BASE_URL = 'https://token.sensenova.cn/v1/chat/completions';
const API_KEY = process.env.SENSENOVA_API_KEY ?? '';

if (!API_KEY) {
  console.error('ERROR: SENSENOVA_API_KEY env var is required');
  process.exit(1);
}

// ── Model configurations ────────────────────────────────────────────────────

interface ModelConfig {
  id: string;
  label: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
}

const MODELS: ModelConfig[] = [
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    reasoningEffort: 'high',
    temperature: 0.3,
  },
  {
    id: 'sensenova-6.7-flash-lite',
    label: 'SenseNova 6.7 Flash-Lite',
    temperature: 0.3,
  },
];

// ── Test scenarios (realistic pain signals) ──────────────────────────────────

interface TestScenario {
  name: string;
  description: string;
  contextPayload: {
    contextId: string;
    contextHash: string;
    taskId: string;
    workspaceDir: string;
    sourceRefs: string[];
    diagnosisTarget: {
      painId: string;
      painScore: number;
      painCategory: string;
      toolCallId: string;
      toolName: string;
      errorMessage: string;
      evidence: string;
      conversationTurn: string;
    };
    conversationWindow: Array<{ role: string; text: string }>;
  };
}

const SCENARIOS: TestScenario[] = [
  {
    name: 'Type Safety Bypass (as-cast)',
    description: 'Agent used `as` cast to bypass runtime validation on parsed JSON',
    contextPayload: {
      contextId: 'ctx-eval-001',
      contextHash: 'hash-eval-001',
      taskId: 'diag_rootcause-eval-001',
      workspaceDir: '/workspace/project',
      sourceRefs: ['tool_call:parseJson:tc-001', 'error:TypeError:tc-002'],
      diagnosisTarget: {
        painId: 'pain-eval-001',
        painScore: 0.85,
        painCategory: 'type_safety',
        toolCallId: 'tc-001',
        toolName: 'readFile',
        errorMessage: 'Agent parsed JSON response and used `as UserConfig` without runtime validation, then accessed nested property that was undefined at runtime',
        evidence: 'The agent received a JSON response from an API, used `JSON.parse(data) as UserConfig` without checking if the parsed object actually matches the expected shape. When the API returned an unexpected structure, the code proceeded to access `config.database.host` which caused a runtime crash because `database` was undefined.',
        conversationTurn: 'User asked to fix a config loading bug. Agent read the API endpoint, got the JSON, immediately cast it as UserConfig without validation, and deployed.',
      },
      conversationWindow: [
        { role: 'user', text: 'Fix the config loading bug in src/config-loader.ts' },
        { role: 'assistant', text: 'I will read the config from the API endpoint and parse it.' },
        { role: 'tool', text: 'HTTP GET /api/config returned: {"version": 2, "db_url": "postgres://..."}' },
        { role: 'assistant', text: 'const config = JSON.parse(data) as UserConfig;\nconsole.log(config.database.host); // TypeError: Cannot read property "host" of undefined' },
        { role: 'user', text: 'That crashed. The API returned a different format than expected.' },
      ],
    },
  },
  {
    name: 'Silent Fallback (ERR-002 pattern)',
    description: 'Agent silently returned empty result instead of surfacing an error',
    contextPayload: {
      contextId: 'ctx-eval-002',
      contextHash: 'hash-eval-002',
      taskId: 'diag_rootcause-eval-002',
      workspaceDir: '/workspace/project',
      sourceRefs: ['tool_call:queryDB:tc-003', 'error:QueryTimeout:tc-004'],
      diagnosisTarget: {
        painId: 'pain-eval-002',
        painScore: 0.75,
        painCategory: 'silent_failure',
        toolCallId: 'tc-003',
        toolName: 'queryDatabase',
        errorMessage: 'Database query timed out, agent returned empty array to caller instead of reporting the timeout error',
        evidence: 'The agent caught a database timeout error in a try-catch block but instead of logging the error and surfacing it, returned an empty array []. The calling code interpreted this as "no records found" and proceeded with default behavior, hiding a real infrastructure issue.',
        conversationTurn: 'User asked to generate a report from database data. Agent ran the query, it timed out, agent silently returned empty results, report showed zero data.',
      },
      conversationWindow: [
        { role: 'user', text: 'Generate the monthly sales report' },
        { role: 'assistant', text: 'Let me query the sales database for last month\'s data.' },
        { role: 'tool', text: 'Error: Query timeout after 30s. Connection pool exhausted.' },
        { role: 'assistant', text: 'try { const results = await db.query(sql); return results; } catch { return []; }' },
        { role: 'user', text: 'The report says 0 sales, that can\'t be right for last month.' },
      ],
    },
  },
];

// ── Prompt builders (inline, matching production logic) ─────────────────────

function buildRootCauseInstruction(): string {
  return `You are a root cause analyst. Your job is to perform a structured 5-Whys analysis on a pain signal (an observed behavior deviation).

PHASE 1 — Evidence Review:
Review all sourceRefs, diagnosisTarget.evidence, and conversationWindow entries. Identify the observable facts.

PHASE 2 — Causal Chain (5 Whys):
Starting from the observed failure, construct a 5-level causal chain:
- Why-1: What directly caused the observed failure?
- Why-2: What enabled the direct cause?
- Why-3: What allowed that enabling condition?
- Why-4: What assumption or gap underlay that condition?
- Why-5: What systemic root cause produced that assumption?
Each level MUST reference at least one evidenceRef.

PHASE 3 — Root Cause Classification:
Classify the root cause into one of:
- People: Human error, skill gap, or knowledge deficit
- Design: Architectural or design-level flaw in the system/agent
- Assumption: Incorrect assumption built into the approach
- Tooling: Infrastructure, tool, or environment limitation

OUTPUT REQUIREMENTS:
Your output MUST match the following JSON schema exactly:
{
  "valid": true,
  "diagnosisId": "diag-<unique-id>",
  "taskId": "<provided taskId>",
  "summary": "<concise diagnosis summary, 1-2 sentences>",
  "causalChain": [
    { "why": 1, "statement": "...", "evidenceRefs": ["ref1"] },
    { "why": 2, "statement": "...", "evidenceRefs": ["ref2"] },
    { "why": 3, "statement": "...", "evidenceRefs": ["ref3"] },
    { "why": 4, "statement": "...", "evidenceRefs": ["ref4"] },
    { "why": 5, "statement": "...", "evidenceRefs": ["ref5"] }
  ],
  "rootCause": "<Category>: <description>",
  "rootCauseCategory": "People|Design|Assumption|Tooling",
  "evidence": [
    { "sourceRef": "...", "note": "..." }
  ],
  "confidence": 0.85,
  "ambiguityNotes": ["..."]
}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences
- Do NOT read files, call tools, or write to any database
- rootCause MUST include the category prefix (e.g., "Design: The agent lacks runtime validation...")
- causalChain MUST have exactly 5 entries with consecutive why numbers (1-5)
- Each causalChain entry MUST have at least one evidenceRef
- confidence MUST be between 0 and 1`;
}

function buildDistillerInstruction(): string {
  return `You are a principle distiller. Your job is to abstract a specific root cause into a general, cross-scenario principle.

INPUT:
You will receive the Stage A root cause output as structured data. This contains:
- summary: a concise description of the diagnosis
- causalChain: the 5-Whys causal chain
- rootCause: the classified root cause with category prefix
- rootCauseCategory: People | Design | Assumption | Tooling
- evidence: supporting evidence entries
- confidence: the Stage A confidence score

OUTPUT REQUIREMENTS:
Your output MUST match the following JSON schema exactly:
{
  "valid": true,
  "taskId": "<provided taskId>",
  "sourceRootCauseArtifactId": "<provided artifact ID>",
  "abstractedPrinciple": "<≤200 chars, abstract, cross-scenario principle>",
  "rationale": "<why this principle addresses the root cause>",
  "groundedOnCorePrincipleIds": [],
  "scope": "general|domain|scenario",
  "confidence": 0.85,
  "ambiguityNotes": []
}

QUALITY GUARD:
Your principle must be ABSTRACT, not rule-like. Avoid concrete trigger patterns,
specific tools, or implementation details. A principle is directional wisdom;
a rule is a boundary condition.

Examples:
- GOOD (abstract principle): "Prefer understanding the existing structure before modifying it"
- BAD (rule-like): "Always run grep before editing files" or "Never use as casts"
- GOOD (intent over technique): "Explicitly stated user constraints take precedence over inferred optimal paths"
- BAD (technique-specific): "Do not create project files in /tmp directory"

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences
- Do NOT read files, call tools, or write to any database
- abstractedPrinciple MUST be ≤200 characters
- sourceRootCauseArtifactId MUST match the provided artifact ID`;
}

function buildRouterInstruction(): string {
  return `You are a principle router. Your job is to take an abstracted principle and root cause, and decide the concrete carrier(s).

INPUT:
You receive two structured artifacts:
1. Stage A Root Cause output — contains the causal chain, root cause classification, and evidence.
2. Stage B Distiller output — contains the abstracted principle, rationale, scope, and confidence.

ROUTING RULES:
Based on the distiller's abstracted principle and the root cause from Stage A, decide the recommendation kind:

- If the principle is broadly applicable across scenarios → kind: "principle"
  (MUST include abstractedPrinciple field)
- If a specific trigger pattern can be identified for deterministic interception → kind: "rule"
  (MUST include triggerPattern and action fields)
- If code/tool enforcement is possible and practical → kind: "implementation"
- If a prompt directive can enforce the behavior → kind: "prompt"
- If insufficient confidence or the finding is too specific/single-instance → kind: "defer"

Default: "principle" is the preferred kind. Only use "defer" for noise signals or genuinely insufficient evidence.

OUTPUT REQUIREMENTS:
Your output MUST match DiagnosticianOutputV1Schema. You only need to generate these fields:

- violatedPrinciples: array of violated principles, derived from Stage A's rootCause + Stage B's grounding
  - title: short descriptive name for the violated principle (REQUIRED, 3-8 words)
  - principleId: omit (no core axioms in this evaluation)
  - rationale: explanation of why this principle was violated (REQUIRED)
- recommendations: one or more entries with the appropriate kind from the routing rules above
- summary: a concise summary combining Stage A's root cause and Stage B's abstracted principle

The following fields are auto-filled by the system from upstream artifacts — do NOT generate them:
- rootCause (copied from Stage A)
- evidence (copied from Stage A)
- confidence (copied from Stage B)

COMPLETE EXAMPLE OUTPUT:
{
  "valid": true,
  "diagnosisId": "diag-example",
  "summary": "...",
  "rootCause": "Design: ...",
  "violatedPrinciples": [
    { "title": "Runtime Type Validation", "rationale": "..." }
  ],
  "evidence": [{ "sourceRef": "...", "note": "..." }],
  "recommendations": [
    { "kind": "principle", "description": "...", "abstractedPrinciple": "..." }
  ],
  "confidence": 0.85,
  "ambiguityNotes": []
}

CONSTRAINTS:
- Output ONLY valid JSON — no markdown, no explanatory text, no code fences, no prose before or after
- Do NOT read files, call tools, or write to any database
- You MUST NOT re-derive the root cause or invent new principles. Route what the distiller produced.`;
}

// ── API call helper ─────────────────────────────────────────────────────────

interface APIResponse {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: {
    message: string;
    code: string;
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function callSenseNova(
  model: ModelConfig,
  systemPrompt: string,
  userPrompt: string,
  retries = 2,
): Promise<{ content: string; reasoning?: string; usage?: APIResponse['usage']; rawResponse: unknown }> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    temperature: model.temperature ?? 0.3,
    max_tokens: 16384,
  };

  if (model.reasoningEffort) {
    body.reasoning_effort = model.reasoningEffort;
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = attempt * 5000;
        console.log(`    [RETRY] Attempt ${attempt + 1}/${retries + 1} after ${delay}ms delay...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const response = await fetch(SENSENOVA_BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      const responseText = await response.text();
      console.log(`    [DEBUG] HTTP ${response.status}, response length: ${responseText.length}`);

      if (!response.ok) {
        throw new Error(`API error ${response.status}: ${responseText.slice(0, 500)}`);
      }

      let data: APIResponse;
      try {
        data = JSON.parse(responseText) as APIResponse;
      } catch (parseErr) {
        console.log(`    [DEBUG] JSON parse failed. First 500 chars: ${responseText.slice(0, 500)}`);
        throw new Error(`Failed to parse API response: ${(parseErr as Error).message}`);
      }

      if (data.error) {
        throw new Error(`API error: ${data.error.message}`);
      }

      const choice = data.choices?.[0];
      const content = choice?.message?.content ?? '';
      const reasoning = choice?.message?.reasoning_content;

      let finalContent = content;
      if (!finalContent && reasoning) {
        const jsonMatch = reasoning.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          finalContent = jsonMatch[0];
          console.log(`    [DEBUG] Content empty, extracted JSON from reasoning_content (${finalContent.length} chars)`);
        }
      }

      if (!finalContent) {
        console.log(`    [DEBUG] Empty content for model=${model.id}. Full response:`, JSON.stringify(data, null, 2).slice(0, 2000));
      } else {
        console.log(`    [DEBUG] Content length: ${finalContent.length}, reasoning: ${reasoning ? reasoning.length : 'none'} chars`);
      }

      return { content: finalContent, reasoning, usage: data.usage, rawResponse: data };
    } catch (err) {
      lastError = err as Error;
      console.log(`    [RETRY] Attempt ${attempt + 1} failed: ${lastError.message}`);
    }
  }

  throw lastError ?? new Error('All retries exhausted');
}

// ── Output validators ───────────────────────────────────────────────────────

function extractJSON(raw: string): string {
  let text = raw.trim();

  if (text.startsWith('```json')) {
    text = text.slice(7);
  } else if (text.startsWith('```')) {
    text = text.slice(3);
  }
  if (text.endsWith('```')) {
    text = text.slice(0, -3);
  }
  text = text.trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  return text;
}

interface ValidationOutcome {
  valid: boolean;
  errors: string[];
  parsed: unknown;
}

function validateRootCauseOutput(raw: string): ValidationOutcome {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJSON(raw));
  } catch (e) {
    return { valid: false, errors: [`JSON parse error: ${(e as Error).message}`], parsed: null };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    errors.push('Output is not an object');
    return { valid: false, errors, parsed };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.valid !== true) errors.push('valid !== true');
  if (typeof obj.diagnosisId !== 'string' || !obj.diagnosisId) errors.push('diagnosisId missing or empty');
  if (typeof obj.taskId !== 'string' || !obj.taskId) errors.push('taskId missing or empty');
  if (typeof obj.summary !== 'string' || !obj.summary) errors.push('summary missing or empty');
  if (typeof obj.rootCause !== 'string' || !obj.rootCause) errors.push('rootCause missing or empty');
  else {
    const hasCategory = /^(People|Design|Assumption|Tooling):/.test(obj.rootCause as string);
    if (!hasCategory) errors.push('rootCause missing category prefix (People|Design|Assumption|Tooling)');
  }
  if (!['People', 'Design', 'Assumption', 'Tooling'].includes(obj.rootCauseCategory as string)) {
    errors.push(`rootCauseCategory invalid: ${obj.rootCauseCategory}`);
  }
  if (!Array.isArray(obj.causalChain)) errors.push('causalChain is not an array');
  else {
    if (obj.causalChain.length !== 5) errors.push(`causalChain has ${obj.causalChain.length} entries, expected 5`);
    (obj.causalChain as unknown[]).forEach((entry, i) => {
      const e = entry as Record<string, unknown>;
      if (e.why !== i + 1) errors.push(`causalChain[${i}].why !== ${i + 1}`);
      if (typeof e.statement !== 'string' || !e.statement) errors.push(`causalChain[${i}].statement missing`);
      if (!Array.isArray(e.evidenceRefs) || e.evidenceRefs.length === 0) errors.push(`causalChain[${i}].evidenceRefs empty`);
    });
  }
  if (!Array.isArray(obj.evidence)) errors.push('evidence is not an array');
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    errors.push('confidence missing or out of range [0,1]');
  }

  return { valid: errors.length === 0, errors, parsed };
}

function validateDistillerOutput(raw: string, expectedArtifactId: string): ValidationOutcome {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJSON(raw));
  } catch (e) {
    return { valid: false, errors: [`JSON parse error: ${(e as Error).message}`], parsed: null };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    errors.push('Output is not an object');
    return { valid: false, errors, parsed };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.valid !== true) errors.push('valid !== true');
  if (typeof obj.taskId !== 'string' || !obj.taskId) errors.push('taskId missing or empty');
  if (obj.sourceRootCauseArtifactId !== expectedArtifactId) {
    errors.push(`sourceRootCauseArtifactId mismatch: got "${obj.sourceRootCauseArtifactId}", expected "${expectedArtifactId}"`);
  }
  if (typeof obj.abstractedPrinciple !== 'string' || !obj.abstractedPrinciple) {
    errors.push('abstractedPrinciple missing or empty');
  } else if ((obj.abstractedPrinciple as string).length > 200) {
    errors.push(`abstractedPrinciple too long: ${(obj.abstractedPrinciple as string).length} chars (max 200)`);
  }
  if (typeof obj.rationale !== 'string' || !obj.rationale) errors.push('rationale missing');
  if (!['general', 'domain', 'scenario'].includes(obj.scope as string)) {
    errors.push(`scope invalid: ${obj.scope}`);
  }
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) {
    errors.push('confidence missing or out of range');
  }

  return { valid: errors.length === 0, errors, parsed };
}

function validateRouterOutput(raw: string): ValidationOutcome {
  const errors: string[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJSON(raw));
  } catch (e) {
    return { valid: false, errors: [`JSON parse error: ${(e as Error).message}`], parsed: null };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    errors.push('Output is not an object');
    return { valid: false, errors, parsed };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.valid !== true) errors.push('valid !== true');
  if (typeof obj.diagnosisId !== 'string' || !obj.diagnosisId) errors.push('diagnosisId missing');
  if (typeof obj.summary !== 'string' || !obj.summary) errors.push('summary missing');

  if (!Array.isArray(obj.violatedPrinciples) || (obj.violatedPrinciples as unknown[]).length === 0) {
    errors.push('violatedPrinciples missing or empty');
  } else {
    (obj.violatedPrinciples as Array<Record<string, unknown>>).forEach((vp, i) => {
      if (typeof vp.title !== 'string' || !vp.title) errors.push(`violatedPrinciples[${i}].title missing`);
      if (typeof vp.rationale !== 'string' || !vp.rationale) errors.push(`violatedPrinciples[${i}].rationale missing`);
    });
  }

  if (!Array.isArray(obj.recommendations) || (obj.recommendations as unknown[]).length === 0) {
    errors.push('recommendations missing or empty');
  } else {
    const validKinds = new Set(['principle', 'rule', 'implementation', 'prompt', 'defer']);
    (obj.recommendations as Array<Record<string, unknown>>).forEach((rec, i) => {
      if (!validKinds.has(rec.kind as string)) errors.push(`recommendations[${i}].kind invalid: ${rec.kind}`);
      if (typeof rec.description !== 'string' || !rec.description) errors.push(`recommendations[${i}].description missing`);
    });
  }

  return { valid: errors.length === 0, errors, parsed };
}

// ── Quality scoring ─────────────────────────────────────────────────────────

interface QualityScore {
  rootCauseDepth: number;
  principleAbstractness: number;
  routingAccuracy: number;
  overall: number;
  notes: string[];
}

function scoreRootCause(parsed: Record<string, unknown>): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;
  const chain = obj.arr(parsed.causalChain);
  if (chain.length === 5) {
    score += 30;
  } else {
    notes.push(`causalChain length: ${chain.length}/5`);
    score += chain.length * 6;
  }
  const hasAllRefs = chain.every((entry: Record<string, unknown>) =>
    Array.isArray(entry.evidenceRefs) && entry.evidenceRefs.length > 0,
  );
  if (hasAllRefs) score += 20;
  else notes.push('Some causalChain entries missing evidenceRefs');

  const rootCause = parsed.rootCause as string;
  if (rootCause && /^(People|Design|Assumption|Tooling):/.test(rootCause)) score += 15;
  else notes.push('rootCause missing category prefix');

  const summary = parsed.summary as string;
  if (summary && summary.length > 20 && summary.length < 300) score += 15;
  else notes.push('summary too short or too long');

  const evidence = parsed.evidence as Array<unknown>;
  if (Array.isArray(evidence) && evidence.length >= 2) score += 20;
  else {
    notes.push(`evidence count: ${Array.isArray(evidence) ? evidence.length : 0}, expected >= 2`);
    score += 10;
  }

  return { score, notes };
}

function scoreDistiller(parsed: Record<string, unknown>): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  const principle = parsed.abstractedPrinciple as string;
  if (!principle) {
    notes.push('abstractedPrinciple missing');
    return { score: 0, notes };
  }

  if (principle.length <= 200) score += 25;
  else notes.push(`principle too long: ${principle.length} chars`);

  const abstractIndicators = ['prefer', 'before', 'over', 'ensure', 'rather than', 'when', 'prioritize', 'validate'];
  const ruleIndicators = ['always', 'never', 'must use', 'do not', 'don\'t', 'every time', 'run grep'];
  const abstractHits = abstractIndicators.filter(w => principle.toLowerCase().includes(w)).length;
  const ruleHits = ruleIndicators.filter(w => principle.toLowerCase().includes(w)).length;
  if (abstractHits > ruleHits) {
    score += 30;
    notes.push('principle is abstract (good)');
  } else if (ruleHits > 0) {
    score += 10;
    notes.push('principle is rule-like (needs improvement)');
  } else {
    score += 20;
    notes.push('principle tone: neutral');
  }

  const rationale = parsed.rationale as string;
  if (rationale && rationale.length > 30) score += 20;
  else notes.push('rationale too short');

  if (parsed.scope === 'general') score += 15;
  else if (parsed.scope === 'domain') score += 10;
  else notes.push(`scope is "${parsed.scope}" — could be more general`);

  const confidence = parsed.confidence as number;
  if (typeof confidence === 'number' && confidence >= 0.5 && confidence <= 1) score += 10;
  else notes.push('confidence out of expected range');

  return { score, notes };
}

function scoreRouter(parsed: Record<string, unknown>): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 0;

  const recs = parsed.recommendations as Array<Record<string, unknown>>;
  if (!Array.isArray(recs) || recs.length === 0) {
    notes.push('no recommendations');
    return { score: 0, notes };
  }

  const hasPrinciple = recs.some(r => r.kind === 'principle');
  const hasRule = recs.some(r => r.kind === 'rule');
  if (hasPrinciple) {
    score += 30;
    notes.push('includes principle recommendation (good default)');
  }
  if (hasRule) {
    score += 10;
    notes.push('includes rule recommendation');
  }
  if (!hasPrinciple && !hasRule && recs.some(r => r.kind === 'defer')) {
    score += 5;
    notes.push('only defer — may indicate insufficient signal');
  }

  const vps = parsed.violatedPrinciples as Array<Record<string, unknown>>;
  if (Array.isArray(vps) && vps.length > 0) {
    score += 25;
    const hasTitle = vps.every(vp => typeof vp.title === 'string' && (vp.title as string).length >= 3);
    if (hasTitle) score += 10;
    else notes.push('some violatedPrinciples missing title');
  } else {
    notes.push('violatedPrinciples empty');
  }

  const summary = parsed.summary as string;
  if (summary && summary.length > 20) score += 15;
  else notes.push('summary too short');

  if (recs.every(r => typeof r.description === 'string' && (r.description as string).length > 10)) {
    score += 10;
  } else {
    notes.push('some recommendations missing description');
  }

  return { score, notes };
}

// Helper for type safety
const obj = {
  arr(val: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(val)) return [];
    return val as Array<Record<string, unknown>>;
  },
};

// ── Main evaluation runner ──────────────────────────────────────────────────

interface StageResult {
  model: string;
  scenario: string;
  stage: string;
  schemaValid: boolean;
  validationErrors: string[];
  qualityScore: number;
  qualityNotes: string[];
  output: unknown;
  reasoning?: string;
  tokensUsed?: number;
  latencyMs: number;
  error?: string;
}

async function runStage(
  model: ModelConfig,
  scenario: TestScenario,
  stage: 'rootcause' | 'distiller' | 'router',
  rootCauseOutput?: Record<string, unknown>,
  distillerOutput?: Record<string, unknown>,
): Promise<StageResult> {
  const start = Date.now();

  try {
    let systemPrompt: string;
    let userPrompt: string;
    let validator: (raw: string) => ValidationOutcome;
    let scorer: (parsed: Record<string, unknown>) => { score: number; notes: string[] };

    switch (stage) {
      case 'rootcause': {
        systemPrompt = buildRootCauseInstruction();
        userPrompt = JSON.stringify(scenario.contextPayload, null, 2);
        validator = validateRootCauseOutput;
        scorer = scoreRootCause;
        break;
      }
      case 'distiller': {
        systemPrompt = buildDistillerInstruction();
        const artifactId = `artifact-rc-${scenario.contextPayload.taskId}`;
        userPrompt = JSON.stringify({
          rootCauseArtifactId: artifactId,
          rootCauseOutput: rootCauseOutput!,
          distillerInstruction: '(see system prompt)',
        }, null, 2);
        validator = (raw) => validateDistillerOutput(raw, artifactId);
        scorer = scoreDistiller;
        break;
      }
      case 'router': {
        systemPrompt = buildRouterInstruction();
        const rcArtifactId = `artifact-rc-${scenario.contextPayload.taskId}`;
        const distArtifactId = `artifact-dist-${scenario.contextPayload.taskId}`;
        userPrompt = JSON.stringify({
          taskId: scenario.contextPayload.taskId,
          rootCauseArtifactId: rcArtifactId,
          rootCauseOutput: rootCauseOutput!,
          distillerArtifactId: distArtifactId,
          distillerOutput: distillerOutput!,
          routerInstruction: '(see system prompt)',
        }, null, 2);
        validator = validateRouterOutput;
        scorer = scoreRouter;
        break;
      }
    }

    const result = await callSenseNova(model, systemPrompt, userPrompt);
    const latencyMs = Date.now() - start;

    const validation = validator(result.content);
    const quality = validation.valid
      ? scorer(validation.parsed as Record<string, unknown>)
      : { score: 0, notes: ['skipped — schema invalid'] };

    return {
      model: model.label,
      scenario: scenario.name,
      stage,
      schemaValid: validation.valid,
      validationErrors: validation.errors,
      qualityScore: quality.score,
      qualityNotes: quality.notes,
      output: validation.parsed,
      reasoning: result.reasoning,
      tokensUsed: result.usage?.total_tokens,
      latencyMs,
    };
  } catch (err) {
    return {
      model: model.label,
      scenario: scenario.name,
      stage,
      schemaValid: false,
      validationErrors: [],
      qualityScore: 0,
      qualityNotes: [],
      output: null,
      latencyMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

// ── Report generation ───────────────────────────────────────────────────────

function generateReport(results: StageResult[]): string {
  const lines: string[] = [];

  lines.push('═'.repeat(80));
  lines.push('  DIAGNOSTIC PIPELINE QUALITY EVALUATION REPORT');
  lines.push(`  Generated: ${new Date().toISOString()}`);
  lines.push('═'.repeat(80));
  lines.push('');

  const models = [...new Set(results.map(r => r.model))];
  const scenarios = [...new Set(results.map(r => r.scenario))];

  for (const model of models) {
    lines.push('─'.repeat(60));
    lines.push(`  Model: ${model}`);
    lines.push('─'.repeat(60));

    for (const scenario of scenarios) {
      const scenarioResults = results.filter(r => r.model === model && r.scenario === scenario);
      if (scenarioResults.length === 0) continue;

      lines.push('');
      lines.push(`  Scenario: ${scenario}`);
      lines.push('');

      for (const r of scenarioResults) {
        const stageLabel = r.stage === 'rootcause' ? 'Stage A (RootCause)'
          : r.stage === 'distiller' ? 'Stage B (Distiller)'
          : 'Stage C (Router)';

        lines.push(`  ${stageLabel}:`);
        lines.push(`    Schema Valid: ${r.schemaValid ? '✅ PASS' : '❌ FAIL'}`);

        if (r.error) {
          lines.push(`    Error: ${r.error}`);
        }

        if (r.validationErrors.length > 0) {
          lines.push(`    Validation Errors:`);
          for (const err of r.validationErrors) {
            lines.push(`      - ${err}`);
          }
        }

        lines.push(`    Quality Score: ${r.qualityScore}/100`);
        if (r.qualityNotes.length > 0) {
          for (const note of r.qualityNotes) {
            lines.push(`      - ${note}`);
          }
        }

        lines.push(`    Latency: ${(r.latencyMs / 1000).toFixed(1)}s`);
        if (r.tokensUsed) {
          lines.push(`    Tokens: ${r.tokensUsed}`);
        }

        if (r.reasoning) {
          const preview = r.reasoning.length > 200 ? r.reasoning.slice(0, 200) + '...' : r.reasoning;
          lines.push(`    Reasoning (preview): ${preview}`);
        }

        lines.push('');
      }

      const pipelineScore = scenarioResults.reduce((sum, r) => sum + r.qualityScore, 0) / scenarioResults.length;
      const allValid = scenarioResults.every(r => r.schemaValid);
      const totalLatency = scenarioResults.reduce((sum, r) => sum + r.latencyMs, 0);

      lines.push(`  Pipeline Summary for ${scenario}:`);
      lines.push(`    All Stages Valid: ${allValid ? '✅' : '❌'}`);
      lines.push(`    Avg Quality Score: ${pipelineScore.toFixed(1)}/100`);
      lines.push(`    Total Latency: ${(totalLatency / 1000).toFixed(1)}s`);
      lines.push('');
    }
  }

  lines.push('═'.repeat(80));
  lines.push('  CROSS-MODEL COMPARISON');
  lines.push('═'.repeat(80));
  lines.push('');

  const header = '| Model'.padEnd(30) + '| Pipeline Valid | Avg Score | Avg Latency |';
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const model of models) {
    const modelResults = results.filter(r => r.model === model);
    const pipelines = scenarios.map(s => {
      const sr = modelResults.filter(r => r.scenario === s);
      return {
        valid: sr.every(r => r.schemaValid),
        score: sr.reduce((sum, r) => sum + r.qualityScore, 0) / Math.max(sr.length, 1),
        latency: sr.reduce((sum, r) => sum + r.latencyMs, 0),
      };
    });

    const allValid = pipelines.every(p => p.valid);
    const avgScore = pipelines.reduce((sum, p) => sum + p.score, 0) / Math.max(pipelines.length, 1);
    const avgLatency = pipelines.reduce((sum, p) => sum + p.latency, 0) / Math.max(pipelines.length, 1);

    const row = `| ${model}`.padEnd(30)
      + `| ${allValid ? '✅ ALL PASS' : '❌ SOME FAIL'}`.padEnd(17)
      + `| ${(avgScore).toFixed(1)}`.padEnd(12)
      + `| ${(avgLatency / 1000).toFixed(1)}s`.padEnd(13)
      + '|';
    lines.push(row);
  }

  lines.push('');
  lines.push('─'.repeat(80));
  lines.push('  SCORING RUBRIC');
  lines.push('  Stage A (RootCause): causal chain completeness (30) + evidence refs (20) +');
  lines.push('    root cause classification (15) + summary quality (15) + evidence count (20)');
  lines.push('  Stage B (Distiller): principle length (25) + abstractness (30) + rationale (20) +');
  lines.push('    scope (15) + confidence (10)');
  lines.push('  Stage C (Router): recommendation kind (30) + violated principles (35) +');
  lines.push('    summary (15) + description quality (10) + rule matching (10)');
  lines.push('─'.repeat(80));

  return lines.join('\n');
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Starting diagnostic pipeline quality evaluation...\n');
  console.log(`Models: ${MODELS.map(m => m.label).join(', ')}`);
  console.log(`Scenarios: ${SCENARIOS.map(s => s.name).join(', ')}\n`);

  const allResults: StageResult[] = [];

  for (const model of MODELS) {
    console.log(`\n${'═'.repeat(40)}`);
    console.log(`Testing: ${model.label} (id: ${model.id})`);
    console.log('═'.repeat(40));

    for (const scenario of SCENARIOS) {
      console.log(`\n  Scenario: ${scenario.name}`);

      // Stage A — Root Cause
      console.log('    Running Stage A (RootCause)...');
      const stageA = await runStage(model, scenario, 'rootcause');
      allResults.push(stageA);
      console.log(`      Valid: ${stageA.schemaValid ? '✅' : '❌'} | Score: ${stageA.qualityScore}/100 | Latency: ${(stageA.latencyMs / 1000).toFixed(1)}s`);

      if (!stageA.schemaValid || !stageA.output) {
        console.log('      Stage A failed — skipping B & C');
        continue;
      }

      // Stage B — Distiller
      console.log('    Running Stage B (Distiller)...');
      const stageB = await runStage(model, scenario, 'distiller', stageA.output as Record<string, unknown>);
      allResults.push(stageB);
      console.log(`      Valid: ${stageB.schemaValid ? '✅' : '❌'} | Score: ${stageB.qualityScore}/100 | Latency: ${(stageB.latencyMs / 1000).toFixed(1)}s`);

      if (!stageB.schemaValid || !stageB.output) {
        console.log('      Stage B failed — skipping C');
        continue;
      }

      // Stage C — Router
      console.log('    Running Stage C (Router)...');
      const stageC = await runStage(
        model, scenario, 'router',
        stageA.output as Record<string, unknown>,
        stageB.output as Record<string, unknown>,
      );
      allResults.push(stageC);
      console.log(`      Valid: ${stageC.schemaValid ? '✅' : '❌'} | Score: ${stageC.qualityScore}/100 | Latency: ${(stageC.latencyMs / 1000).toFixed(1)}s`);
    }
  }

  const report = generateReport(allResults);
  console.log('\n' + report);

  // Save report to file
  const fs = await import('fs');
  const path = await import('path');
  const reportPath = path.join(process.cwd(), 'scripts', `eval-diag-report-${Date.now()}.txt`);
  fs.writeFileSync(reportPath, report, 'utf-8');
  console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
