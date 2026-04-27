import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import {
  CandidateIntakeError,
  INTAKE_ERROR_CODES,
  type LedgerAdapter,
  type LedgerPrincipleEntry,
} from '@principles/core/runtime-v2';

interface LedgerFile {
  principles: LedgerPrincipleEntry[];
}

function resolveLedgerPath(stateDir: string): string {
  const pdDir = basename(stateDir) === '.pd' ? stateDir : join(stateDir, '.pd');
  return join(pdDir, 'principle-tree-ledger.json');
}

function extractCandidateId(sourceRef: string): string {
  return sourceRef.startsWith('candidate://')
    ? sourceRef.slice('candidate://'.length)
    : sourceRef;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

/**
 * Minimal file-backed ledger adapter for pd-cli candidate intake.
 *
 * This intentionally depends only on @principles/core runtime-v2 contracts.
 * The OpenClaw plugin can provide a richer adapter later, but the operator CLI
 * must not import the plugin package just to intake candidates.
 */
export class PrincipleTreeLedgerAdapter implements LedgerAdapter {
  readonly #ledgerPath: string;

  constructor(opts: { stateDir: string }) {
    this.#ledgerPath = resolveLedgerPath(opts.stateDir);
  }

  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry {
    const candidateId = extractCandidateId(entry.sourceRef);
    const existing = this.existsForCandidate(candidateId);
    if (existing) {
      return existing;
    }

    try {
      const ledger = this.#readLedger();
      ledger.principles.push(entry);
      this.#writeLedger(ledger);
      return entry;
    } catch (err) {
      throw new CandidateIntakeError(
        INTAKE_ERROR_CODES.LEDGER_WRITE_FAILED,
        `Failed to write ledger entry for candidate ${candidateId}`,
        { candidateId, cause: err },
      );
    }
  }

  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null {
    const sourceRef = `candidate://${candidateId}`;
    const ledger = this.#readLedger();
    return ledger.principles.find((entry) => entry.sourceRef === sourceRef) ?? null;
  }

  #readLedger(): LedgerFile {
    try {
      const raw = readFileSync(this.#ledgerPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      return { principles: Array.isArray(parsed.principles) ? parsed.principles : [] };
    } catch (err) {
      if (isNotFound(err)) {
        return { principles: [] };
      }
      throw err;
    }
  }

  #writeLedger(ledger: LedgerFile): void {
    mkdirSync(dirname(this.#ledgerPath), { recursive: true });
    writeFileSync(this.#ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  }
}
