export type RuleType = 'regex' | 'exact_match';
export interface PainRule {
    type: RuleType;
    pattern?: string;
    phrases?: string[];
    severity: number;
    hits: number;
    status: 'active' | 'dormant' | 'archived';
}
export interface PainDictionaryData {
    rules: Record<string, PainRule>;
}
export declare const PAIN_PROTOCOL_TOKENS: readonly ["[EVOLUTION_ACK]", "HEARTBEAT_OK", "HEARTBEAT_CHECK"];
export declare function shouldIgnorePainProtocolText(text: string): boolean;
export declare class PainDictionary {
    private stateDir;
    private data;
    private filePath;
    private compiledRegex;
    constructor(stateDir: string);
    load(): void;
    private compile;
    getRule(id: string): PainRule | undefined;
    getAllRules(): Record<string, PainRule>;
    /**
     * Adds a new rule or updates an existing one.
     */
    addRule(id: string, rule: Omit<PainRule, 'hits'>): void;
    match(text: string): {
        ruleId: string;
        severity: number;
    } | undefined;
    flush(): void;
    getStats(): {
        totalRules: number;
        totalHits: number;
    };
}
