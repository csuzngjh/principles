// PRI-815 — minimal LLM client for the A/B harness.
//
// Same channel as production PD agents on this host: ZAI coding endpoint,
// glm-5.3. Credentials come from ZAI_API_KEY only (never committed).
// Retries bounded; every call records usage/latency/attempts for the cost
// guard (SPEC §31). JSON extraction mirrors the production fetch path:
// strip code fences, then first-{ ... last-} salvage parse.

const ENDPOINT = process.env.PD_LLM_ENDPOINT ?? 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
const MODEL = process.env.PD_LLM_MODEL ?? 'glm-5.3';
const MAX_TOKENS = Number(process.env.PD_LLM_MAX_TOKENS ?? 8000);
const TEMPERATURE = Number(process.env.PD_LLM_TEMPERATURE ?? 0);
const TIMEOUT_MS = Number(process.env.PD_LLM_TIMEOUT_MS ?? 300_000);

export function extractJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(t);
  } catch { /* fall through to salvage */ }
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch { /* unparseable */ }
  }
  return null;
}

export async function chat(messages, { maxAttempts = 3, signal, maxTokens, thinking } = {}) {
  const key = process.env.ZAI_API_KEY;
  if (!key) throw new Error('ZAI_API_KEY is not set');
  const tokenBudget = maxTokens ?? MAX_TOKENS;
  const extra = thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {};
  let lastError = null;
  let started = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: TEMPERATURE, max_tokens: tokenBudget, ...extra }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`http_${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json();
      const choice = data?.choices?.[0]?.message;
      const content = choice?.content ?? '';
      const usage = data?.usage ?? {};
      return {
        content,
        usage: {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
          total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
        },
        latencyMs: Date.now() - started,
        attempt,
        model: MODEL,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return { content: '', usage: { input: 0, output: 0, total: 0 }, latencyMs: Date.now() - started, attempt: maxAttempts, error: lastError, model: MODEL };
}
