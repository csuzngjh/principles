import * as fs from 'fs';
import * as path from 'path';

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
    private filePath: string;
    private compiledRegex: Map<string, RegExp> = new Map();

    constructor(private stateDir: string) {
        this.filePath = path.join(stateDir, 'pain_dictionary.json');
    }

    load(): void {
        if (fs.existsSync(this.filePath)) {
            try {
                this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            } catch (e) {
                console.error('[PD] Failed to parse pain_dictionary.json, using defaults.');
                this.data = { rules: { ...DEFAULT_RULES } };
            }
        } else {
            this.data = { rules: { ...DEFAULT_RULES } };
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

    match(text: string): { ruleId: string; severity: number } | undefined {
        let bestMatch: { ruleId: string; severity: number } | undefined = undefined;

        for (const [id, rule] of Object.entries(this.data.rules)) {
            if (rule.status !== 'active') continue;

            let matched = false;
            if (rule.type === 'regex') {
                const re = this.compiledRegex.get(id);
                if (re?.test(text)) matched = true;
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
        try {
            if (!fs.existsSync(this.stateDir)) {
                fs.mkdirSync(this.stateDir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            console.error('[PD] Failed to flush pain_dictionary.json:', e);
        }
    }
}
