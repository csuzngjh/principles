/**
 * Shared consent-ledger fixture helper for Codex ingestion tests (PRI-1262).
 *
 * Live and catch-up ingestion reuse the FORMAL v3 consent judgment; without a
 * granted record against the CURRENT frozen disclosure the pipeline degrades
 * `consent_not_granted:<decision>` before any transcript read. Tests that
 * exercise happy-path ingestion must therefore seed a granted record — this
 * helper writes the exact production shape (`hosts.codex.*`, schemaVersion 3).
 */
import fs from 'node:fs';
import path from 'node:path';

export type CodexConsentDecision = 'granted' | 'pending' | 'revoked' | 'failed';

export function writeCodexConsent(
  workspaceDir: string,
  decision: CodexConsentDecision,
  disclosureVersion = 'g2b-2026-11-12',
): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.state', 'conversation-ingestion-consent.json'),
    JSON.stringify({
      schemaVersion: '3',
      hosts: {
        codex: {
          schemaVersion: '3',
          decision,
          disclosureVersion,
          decidedAt: '2026-11-17T10:30:00.000Z',
          decidedVia: 'owner_directive',
        },
      },
    }, null, 2),
  );
}

export function writeGrantedCodexConsent(workspaceDir: string): void {
  writeCodexConsent(workspaceDir, 'granted');
}
