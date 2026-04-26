// Type declaration for PrincipleTreeLedgerAdapter
// This avoids importing the entire openclaw-plugin package

export interface LedgerPrincipleEntry {
  id: string;
  title: string;
  text: string;
  triggerPattern?: string;
  action?: string;
  status: string;
  evaluability: string;
  sourceRef: string;
  artifactRef: string;
  taskRef?: string;
  createdAt: string;
}

export interface LedgerAdapter {
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry;
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null;
}

export declare class PrincipleTreeLedgerAdapter implements LedgerAdapter {
  constructor(opts: { stateDir: string });
  writeProbationEntry(entry: LedgerPrincipleEntry): LedgerPrincipleEntry;
  existsForCandidate(candidateId: string): LedgerPrincipleEntry | null;
}
