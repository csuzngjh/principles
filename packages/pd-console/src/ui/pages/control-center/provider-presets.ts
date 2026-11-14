/**
 * Presentation-only presentation data for the provider picker (PRI-1213).
 *
 * Provider endpoints and model lists come from the server projection of the
 * pi-ai catalog — never from this file. What lives here is the part the product
 * genuinely owns: which providers are common enough for the main path, what to
 * call them in Chinese, and which environment variable name PD suggests for
 * each key. All of it is editable in the advanced section.
 */

/** Main-path providers: one API key is the only operator input they need. */
export const MAIN_PROVIDER_IDS = [
  'deepseek',
  'moonshotai-cn',
  'zai',
  'minimax-cn',
  'kimi-coding',
  'qwen-token-plan-cn',
  'xiaomi',
  'openai',
  'anthropic',
  'google',
  'xai',
  'openrouter',
  'groq',
  'mistral',
  'together',
  'nvidia',
] as const;

export const MAIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(MAIN_PROVIDER_IDS);

export const CUSTOM_PROVIDER_ID = '__custom__';

interface ProviderDisplay {
  name: string;
  envName: string;
}

/** Chinese product labels + canonical env var names (suggestion only). */
const PROVIDER_DISPLAY: Record<string, ProviderDisplay> = {
  deepseek: { name: 'DeepSeek 深度求索', envName: 'DEEPSEEK_API_KEY' },
  'moonshotai-cn': { name: '月之暗面 Kimi', envName: 'MOONSHOT_API_KEY' },
  zai: { name: '智谱 GLM', envName: 'ZAI_API_KEY' },
  'minimax-cn': { name: 'MiniMax', envName: 'MINIMAX_API_KEY' },
  'kimi-coding': { name: 'Kimi Code', envName: 'KIMI_API_KEY' },
  'qwen-token-plan-cn': { name: '通义千问', envName: 'DASHSCOPE_API_KEY' },
  xiaomi: { name: '小米 MiMo', envName: 'XIAOMI_API_KEY' },
  openai: { name: 'OpenAI', envName: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', envName: 'ANTHROPIC_API_KEY' },
  google: { name: 'Google Gemini', envName: 'GEMINI_API_KEY' },
  xai: { name: 'xAI Grok', envName: 'XAI_API_KEY' },
  openrouter: { name: 'OpenRouter', envName: 'OPENROUTER_API_KEY' },
  groq: { name: 'Groq', envName: 'GROQ_API_KEY' },
  mistral: { name: 'Mistral', envName: 'MISTRAL_API_KEY' },
  together: { name: 'Together AI', envName: 'TOGETHER_API_KEY' },
  nvidia: { name: 'NVIDIA NIM', envName: 'NVIDIA_API_KEY' },
};

export function providerDisplayName(providerId: string): string {
  const known = PROVIDER_DISPLAY[providerId];
  if (known !== undefined) return known.name;
  // Unknown catalog provider: make the raw id readable without inventing a brand.
  return providerId
    .split('-')
    .map((part) => (part === '' ? part : part[0]?.toUpperCase() + part.slice(1)))
    .join(' ');
}

export function suggestedEnvName(providerId: string): string {
  const known = PROVIDER_DISPLAY[providerId];
  if (known !== undefined) return known.envName;
  const normalized = providerId.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return `${normalized === '' ? 'PROVIDER' : normalized}_API_KEY`;
}

/** Monogram for the card badge (no logo assets, no invented brand colors). */
export function providerMonogram(providerId: string): string {
  const name = providerDisplayName(providerId).trim();
  const ascii = /^[A-Za-z]/.exec(name);
  if (ascii !== null) {
    return name.slice(0, 2).toUpperCase();
  }
  return name.slice(0, 1);
}

export function apiFormatLabel(api: string): string {
  switch (api) {
    case 'openai-completions':
    case 'openai-responses':
    case 'azure-openai-responses':
      return 'OpenAI Chat Completions';
    case 'anthropic-messages':
      return 'Anthropic Messages';
    case 'google-generative-ai':
      return 'Google Generative AI';
    default:
      return api;
  }
}

/** Derive a unique profile id from a provider id (server only requires non-empty, non-reserved). */
export function deriveProfileId(providerId: string, existingIds: readonly string[]): string {
  const base =
    providerId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'profile';
  const existing = new Set(existingIds);
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${String(index)}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${String(Date.now())}`;
}
