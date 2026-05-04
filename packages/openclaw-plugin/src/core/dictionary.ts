 
import * as fs from 'fs';
import * as path from 'path';
import { JsonFileStore } from './file-store.js';

export type RuleType = 'regex' | 'exact_match';

export interface PainRule {
    type: RuleType;
    pattern?: string;      // For regex
    phrases?: string[];    // For exact_match
    severity: number;
    hits: number;
    status: 'active' | 'dormant' | 'archived';
}

export interface PainDictionaryData {
    rules: Record<string, PainRule>;
}


export const PAIN_PROTOCOL_TOKENS = [
    '[EVOLUTION_ACK]',
    'HEARTBEAT_OK',
    'HEARTBEAT_CHECK',
] as const;

export function shouldIgnorePainProtocolText(text: string): boolean {
    const normalized = text.trim();
    if (!normalized) return false;
    return PAIN_PROTOCOL_TOKENS.some((token) => normalized === token || normalized.startsWith(`${token} `) || normalized.includes(token));
}

const DEFAULT_RULES: Record<string, PainRule> = {
    'P_CONFUSION_ZH': {
        type: 'regex',
        pattern: '我(似乎|好像)(不确定|不太确定|不清楚|困惑)',
        severity: 35,
        hits: 0,
        status: 'active'
    },
    'P_CONFUSION_EN': {
        type: 'regex',
        pattern: 'i am (not sure|unsure|confused|uncertain|struggling to)',
        severity: 35,
        hits: 0,
        status: 'active'
    },
    'P_LOOP_ZH': {
        type: 'regex',
        pattern: '似乎(陷入了?循环|回到了?原点|原地打转)',
        severity: 45,
        hits: 0,
        status: 'active'
    },
    'P_LOOP_EN': {
        type: 'exact_match',
        phrases: ['going in circles', 'back to square one', 'looping'],
        severity: 45,
        hits: 0,
        status: 'active'
    }
};

export class PainDictionary {
    private data: PainDictionaryData = { rules: {} };
    private readonly store: JsonFileStore<PainDictionaryData>;
    private readonly compiledRegex: Map<string, RegExp> = new Map();

    constructor(private readonly stateDir: string) {
        const filePath = path.join(stateDir, 'pain_dictionary.json');
        this.store = new JsonFileStore<PainDictionaryData>(filePath, () => ({ rules: { ...DEFAULT_RULES } }));
    }

    load(): void {
        const filePath = path.join(this.stateDir, 'pain_dictionary.json');
        const fileExisted = fs.existsSync(filePath);
        const loaded = this.store.load();
        // Check if we got real data (has at least one rule from file) or just defaults
        const hasRules = loaded.rules && Object.keys(loaded.rules).length > 0;
        if (hasRules) {
            this.data = loaded;
        } else {
            this.data = { rules: { ...DEFAULT_RULES } };
            // Only overwrite if file didn't previously exist — preserve corrupt files
            if (!fileExisted) {
                console.log(`[PD:Dictionary] Dictionary not found, creating with default rules`);
                this.flush();
            } else {
                console.warn(`[PD:Dictionary] Dictionary corrupt or empty, preserving file and using defaults`);
            }
        }
        this.compile();
    }

    private compile(): void {
        this.compiledRegex.clear();
        for (const [id, rule] of Object.entries(this.data.rules)) {
            if (rule.type === 'regex' && rule.pattern) {
                this.compiledRegex.set(id, new RegExp(rule.pattern, 'i'));
            }
        }
    }

    getRule(id: string): PainRule | undefined {
        return this.data.rules[id];
    }

    getAllRules(): Record<string, PainRule> {
        return this.data.rules;
    }

    /**
     * Adds a new rule or updates an existing one.
     */
    addRule(id: string, rule: Omit<PainRule, 'hits'>): void {
        this.data.rules[id] = {
            ...rule,
            hits: this.data.rules[id]?.hits || 0
        };
        // Re-compile if it's a regex rule
        if (rule.type === 'regex' && rule.pattern) {
            this.compiledRegex.set(id, new RegExp(rule.pattern, 'i'));
        }
    }

     
    match(text: string): { ruleId: string; severity: number } | undefined {
        if (shouldIgnorePainProtocolText(text)) return undefined;

        let bestMatch: { ruleId: string; severity: number } | undefined = undefined;

        for (const [id, rule] of Object.entries(this.data.rules)) {
            if (rule.status !== 'active') continue;

            let matched = false;
            if (rule.type === 'regex') {
                const re = this.compiledRegex.get(id);
                if (re) {
                    re.lastIndex = 0;
                    if (re.test(text)) matched = true;
                }
            } else if (rule.type === 'exact_match' && rule.phrases) {
                const lowerText = text.toLowerCase();
                if (rule.phrases.some(p => lowerText.includes(p.toLowerCase()))) {
                    matched = true;
                }
            }

            if (matched) {
                rule.hits++;
                if (!bestMatch || rule.severity > bestMatch.severity) {
                    bestMatch = { ruleId: id, severity: rule.severity };
                }
            }
        }
        return bestMatch;
    }

    flush(): void {
        this.store.save(this.data);
    }

    getStats(): { totalRules: number; totalHits: number } {
        let totalHits = 0;
        for (const rule of Object.values(this.data.rules)) {
            totalHits += rule.hits || 0;
        }
        return {
            totalRules: Object.keys(this.data.rules).length,
            totalHits
        };
    }
}
