/**
 * Which providers have a bundled official logo (PRI-1213 UI follow-up).
 *
 * The files live next to this module in `assets/providers/` and are copied to
 * `/assets/providers/` by `scripts/build-ui.mjs`. No runtime hotlinking: the
 * console must render every logo offline.
 *
 * Providers absent from this map deliberately fall back to a monogram tile —
 * see `assets/providers/NOTICE.md` for the list and the reason.
 */
const PROVIDER_LOGO_FILES: Readonly<Record<string, string>> = {
  deepseek: 'deepseek.svg',
  'moonshotai-cn': 'moonshotai-cn.svg',
  'minimax-cn': 'minimax-cn.svg',
  'kimi-coding': 'kimi-coding.svg',
  'qwen-token-plan-cn': 'qwen-token-plan-cn.svg',
  xiaomi: 'xiaomi.svg',
  openai: 'openai.svg',
  anthropic: 'anthropic.svg',
  google: 'google.svg',
  openrouter: 'openrouter.svg',
  mistral: 'mistral.svg',
  nvidia: 'nvidia.svg',
};

/** Same-origin, build-time asset path — never an external URL. */
export function providerLogoFile(providerId: string): string | undefined {
  return PROVIDER_LOGO_FILES[providerId];
}

export function providerHasOfficialLogo(providerId: string): boolean {
  return providerLogoFile(providerId) !== undefined;
}

/** Providers that ship a logo, in a stable order (used by tests/docs). */
export function providersWithLogo(): string[] {
  return Object.keys(PROVIDER_LOGO_FILES).sort();
}
