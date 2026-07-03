/**
 * Onboarding slash command metadata (PRI-506).
 *
 * Command names and aliases are NOT translatable (they are literal slash
 * commands the user types), so they live here in a TS module rather than in
 * i18n JSON. Only the human-readable descriptions are translated — they live
 * under `pages.welcome.step3.commandDescriptions.*` in en.json / zh-CN.json.
 *
 * EP-06 (Source of Truth): the canonical command list is in
 * packages/openclaw-plugin/src/i18n/commands.ts (`commandDescriptions`).
 * This module mirrors the 7 core commands selected for onboarding. When the
 * canonical list changes, update the descriptions here and in both i18n
 * files manually (no cross-package dependency is introduced).
 */

export interface SlashCommand {
  name: string;
  alias?: string;
  descriptionKey: string;
}

export const ONBOARDING_SLASH_COMMANDS: SlashCommand[] = [
  { name: '/pd-init', alias: '/pdi', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdInit' },
  { name: '/pd-status', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdStatus' },
  { name: '/pd-pain', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdPain' },
  { name: '/pd-help', alias: '/pdh', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdHelp' },
  { name: '/pd-context', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdContext' },
  { name: '/pd-evolution-status', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdEvolutionStatus' },
  { name: '/pd-focus', descriptionKey: 'pages.welcome.step3.commandDescriptions.pdFocus' },
];
