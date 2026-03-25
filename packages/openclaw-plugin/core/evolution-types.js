/**
 * Evolution Points System V2.0 - MVP
 *
 * Core Philosophy: Growth-driven替代Penalty-driven
 * - 起点0分，只能增加，不扣分
 * - 失败记录教训，不扣分
 * - 同类任务失败后首次成功 = 双倍奖励（1小时冷却）
 * - 5级成长路径：Seed → Forest
 */
// ===== 等级定义 =====
export var EvolutionTier;
(function (EvolutionTier) {
    EvolutionTier[EvolutionTier["Seed"] = 1] = "Seed";
    EvolutionTier[EvolutionTier["Sprout"] = 2] = "Sprout";
    EvolutionTier[EvolutionTier["Sapling"] = 3] = "Sapling";
    EvolutionTier[EvolutionTier["Tree"] = 4] = "Tree";
    EvolutionTier[EvolutionTier["Forest"] = 5] = "Forest"; // 森林：完全自主
})(EvolutionTier || (EvolutionTier = {}));
export const TIER_DEFINITIONS = [
    { tier: EvolutionTier.Seed, name: 'Seed', requiredPoints: 0, permissions: { maxLinesPerWrite: 20, maxFilesPerTask: 1, allowRiskPath: false, allowSubagentSpawn: false } },
    { tier: EvolutionTier.Sprout, name: 'Sprout', requiredPoints: 50, permissions: { maxLinesPerWrite: 50, maxFilesPerTask: 2, allowRiskPath: false, allowSubagentSpawn: false } },
    { tier: EvolutionTier.Sapling, name: 'Sapling', requiredPoints: 200, permissions: { maxLinesPerWrite: 200, maxFilesPerTask: 5, allowRiskPath: false, allowSubagentSpawn: true } },
    { tier: EvolutionTier.Tree, name: 'Tree', requiredPoints: 500, permissions: { maxLinesPerWrite: 500, maxFilesPerTask: 10, allowRiskPath: true, allowSubagentSpawn: true } },
    { tier: EvolutionTier.Forest, name: 'Forest', requiredPoints: 1000, permissions: { maxLinesPerWrite: Infinity, maxFilesPerTask: Infinity, allowRiskPath: true, allowSubagentSpawn: true } },
];
export function getTierDefinition(tier) {
    return TIER_DEFINITIONS[tier - 1];
}
export function getTierByPoints(totalPoints) {
    // 从高到低检查，找到最高匹配等级
    for (let i = TIER_DEFINITIONS.length - 1; i >= 0; i--) {
        if (totalPoints >= TIER_DEFINITIONS[i].requiredPoints) {
            return TIER_DEFINITIONS[i].tier;
        }
    }
    return EvolutionTier.Seed;
}
export const TASK_DIFFICULTY_CONFIG = {
    trivial: { basePoints: 1, description: '简单任务：读取、搜索、状态查询' },
    normal: { basePoints: 3, description: '常规任务：单文件编辑、测试编写' },
    hard: { basePoints: 8, description: '困难任务：多文件重构、架构变更' },
};
export const DEFAULT_EVOLUTION_CONFIG = {
    doubleRewardCooldownMs: 60 * 60 * 1000, // 1小时
    maxRecentEvents: 50,
    difficultyPenalty: {
        tier4Trivial: 0.1,
        tier4Normal: 0.5,
        tier5Trivial: 0.1,
        tier5Normal: 0.5,
    },
    dualTrack: {
        enabled: true,
        primarySystem: 'evolution',
    },
};
