// Type declaration for openclaw-plugin modules
// This prevents TypeScript from checking the actual implementation files

declare module '../../openclaw-plugin/src/core/principle-tree-ledger-adapter.js' {
  export class PrincipleTreeLedgerAdapter {
    constructor(opts: { stateDir: string });
    writeProbationEntry(entry: any): any;
    existsForCandidate(candidateId: string): any;
  }
}

declare module '../../openclaw-plugin/src/core/principle-tree-ledger.js' {
  export function addPrincipleToLedger(opts: any): any;
  export function loadLedger(opts: any): any;
  export type LedgerPrinciple = any;
}
