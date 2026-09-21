// Commit identity guard — rejects commits attributed to a Git email that
// GitHub maps to a foreign account instead of the repository owner.
//
// Incident 2026-09-21: an agent session ran
//   git -c user.name="PD" -c user.email="pd@users.noreply.github.com" commit ...
// overriding the correct global config at commit time. GitHub attributed
// those commits to github.com/pd, not to the repository owner (csuzngjh).
// The email was never persisted in any git config, so no config repair can
// prevent a repeat; this guard fails closed at commit time instead.
//
// `git var GIT_*_IDENT` reports the effective identity the commit would get,
// including per-invocation `-c user.email=...` overrides (inherited by hooks
// through git's config environment) and GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL
// environment variables. Checking it here therefore covers every injection
// path available to an agent session.
//
// Judge-only: it never rewrites, repairs or reconfigures anything.
//
// Usage:
//   node scripts/dev/check-commit-identity.mjs
// Exit codes: 0 = identity acceptable, 1 = rejected.

import { runGit } from './lib/git.mjs';

// Emails that GitHub attributes to an account other than the repository
// owner. Extend only with addresses proven to misattribute (P1 evidence),
// never with addresses that are merely unusual — legitimate collaborators
// may commit under any verified email of their own.
const FORBIDDEN_EMAILS = new Set(['pd@users.noreply.github.com']);

const REMEDIATION =
  'Configure the PD agent Git identity to the repository owner\'s verified email.';

function extractEmail(identLine) {
  const match = identLine.match(/<([^>]*)>/);
  return match ? match[1].trim() : '';
}

let rejected = false;
for (const identVar of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
  let ident;
  try {
    ident = await runGit(['var', identVar]);
  } catch (err) {
    console.error(
      `commit-identity: cannot resolve ${identVar} — refusing to commit (fail loud):\n` +
        String(err && err.message ? err.message : err),
    );
    process.exit(1);
  }
  const email = extractEmail(ident.trim());
  if (FORBIDDEN_EMAILS.has(email.toLowerCase())) {
    rejected = true;
    console.error(
      `Invalid Git ${identVar === 'GIT_AUTHOR_IDENT' ? 'author' : 'committer'} email: ` +
        `${email} is associated with github.com/pd. ${REMEDIATION}`,
    );
  }
}

if (rejected) process.exit(1);
