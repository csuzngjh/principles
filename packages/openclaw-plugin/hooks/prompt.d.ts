import type { PluginHookBeforePromptBuildEvent, PluginHookAgentContext, PluginHookBeforePromptBuildResult, PluginLogger } from '../openclaw-sdk.js';
import { ContextInjectionConfig } from '../types.js';
import { type EmpathyObserverApi } from '../service/empathy-observer-manager.js';
/**
 * 濞寸媴绲块幃濠冾渶濡鍚囬梺鏉跨Ф閻?
 */
interface AgentsDefaultsConfig {
    model?: unknown;
    subagents?: {
        model?: unknown;
    };
}
interface PromptHookApi {
    config?: {
        agents?: {
            defaults?: AgentsDefaultsConfig;
        };
        empathy_engine?: {
            enabled?: boolean;
        };
    };
    runtime: EmpathyObserverApi['runtime'];
    logger: PluginLogger;
}
/**
 * 濞?OpenClaw 闂佹澘绉堕悿鍡樼▔椤撯寬鎺楀几閹邦劷渚€宕圭€ｎ喒鍋撴径瀣仴
 * 闁衡偓椤栨稑鐦?string 闁?{ primary, fallbacks } 闁哄秶鍘х槐?
 * @internal 閻庣數鍘ч崵顓熺閸涱剛杩旀繛鏉戭儓閻︻垱鎷呯捄銊︽殢
 */
export declare function resolveModelFromConfig(modelConfig: unknown, logger?: PluginLogger): string | null;
/**
 * 闁告梻濮惧ù鍥ㄧ▔婵犱胶鐟撻柡鍌氭处閺佺偤宕楅妷鈺佸赋缂?
 * 濞?PROFILE.json 閻犲洩顕цぐ?contextInjection 闂佹澘绉堕悿鍡涙晬鐏炵瓔娲ら柡瀣矆缁楀鈧稒锚濠€顏堝礆濞嗘帞绠查柛銉у仱缁垳鎷嬮妶澶婂赋缂?
 * @internal 閻庣數鍘ч崵顓熺瑹濞戞ê寰撳ù鐘崇墬鑶╅柛褎銇炴繛鍥偨?
 */
export declare function loadContextInjectionConfig(workspaceDir: string): ContextInjectionConfig;
/**
 * 闁兼儳鍢茶ぐ鍥╂嫚婵犲啯鐒介悗娑欏姈濞呫倝鎳楅幋鎺旂Ъ閹煎瓨鏌ф繛鍥偨閵娧勭暠婵☆垪鈧磭鈧?
 * 濞村吋锚閸樻稓鐥缁辩殜ubagents.model > 濞戞挾绮啯闁?
 * 濠碘€冲€归悘澶愭焾閼恒儳姊鹃柡鍫濐樀閸樸倗绱旈鍡欑闁硅埖绋戦崵顓㈡煥濞嗘帩鍤?
 * @internal 閻庣數鍘ч崵顓熺閸涱剛杩旀繛鏉戭儓閻︻垱鎷呯捄銊︽殢
 */
export declare function getDiagnosticianModel(api: PromptHookApi | null, logger?: PluginLogger): string;
export declare function handleBeforePromptBuild(event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext & {
    api?: PromptHookApi;
}): Promise<PluginHookBeforePromptBuildResult | void>;
export {};
