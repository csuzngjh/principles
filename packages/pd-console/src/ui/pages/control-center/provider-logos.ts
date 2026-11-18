/**
 * Vendor-published logo assets, bundled into `dist/web/assets/providers/` at
 * build time. Keep this list in sync with `assets/providers/NOTICE.md`.
 *
 * Providers missing here intentionally fall back to the monogram tile; see
 * NOTICE.md for the licensing/source reason per vendor.
 */
const PROVIDER_LOGO_FILES: Readonly<Record<string, string>> = {
  deepseek: 'deepseek.png',
  'moonshotai-cn': 'kimi.png',
  'kimi-coding': 'kimi.png',
  'minimax-cn': 'minimax.png',
  'qwen-token-plan-cn': 'qwen.png',
  xiaomi: 'xiaomi.png',
  zai: 'zai.svg',
  anthropic: 'anthropic.png',
  google: 'google.png',
  openrouter: 'openrouter.svg',
  mistral: 'mistral.svg',
  together: 'together.svg',
};

export function providerLogoFile(providerId: string): string | undefined {
  return PROVIDER_LOGO_FILES[providerId];
}

export function providerHasOfficialLogo(providerId: string): boolean {
  return providerLogoFile(providerId) !== undefined;
}

export function providersWithLogo(): string[] {
  return Object.keys(PROVIDER_LOGO_FILES);
}
