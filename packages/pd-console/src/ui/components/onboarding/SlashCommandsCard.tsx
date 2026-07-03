/**
 * SlashCommandsCard — renders the core slash command list for onboarding Step 3.
 *
 * Receives the commands array (with descriptionKey) as a prop from
 * ONBOARDING_SLASH_COMMANDS. Each command's description text is fetched via
 * i18n using the descriptionKey, keeping all user-facing strings in i18n.
 *
 * rc-9-no-silent-fallback: when commands array is empty, render the fallback
 * message instead of a blank section.
 */

import { useTranslation } from 'react-i18next';
import type { SlashCommand } from './slashCommands.js';

interface SlashCommandsCardProps {
  commands: SlashCommand[];
}

export function SlashCommandsCard({ commands }: SlashCommandsCardProps) {
  const { t } = useTranslation();

  // rc-9: empty commands must not render as a blank section — show fallback.
  if (!commands || commands.length === 0) {
    return (
      <p className="slash-commands-empty" role="note">
        {t('pages.welcome.step3.emptyListFallback')}
      </p>
    );
  }

  return (
    <ul className="slash-commands-list" role="list">
      {commands.map((cmd) => (
        <li key={cmd.name} className="slash-command-item">
          <div className="slash-command-header">
            <code className="slash-command-name">{cmd.name}</code>
            {cmd.alias && (
              <code className="slash-command-alias">{cmd.alias}</code>
            )}
          </div>
          <p className="slash-command-description">{t(cmd.descriptionKey)}</p>
        </li>
      ))}
    </ul>
  );
}
