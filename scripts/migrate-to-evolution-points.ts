#!/usr/bin/env node

/**
 * Evolution Points Migration Script
 *
 * Migrates from Trust Engine (pain_settings.json) to Evolution Points System (v2.0)
 *
 * Usage:
 *   npx ts-node scripts/migrate-to-evolution-points.ts [workspace-path]
 *
 * Default workspace-path: current working directory
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

// ===== Types =====

interface TrustConfig {
  trust: {
    stages: {
      stage_1_observer: number;
      stage_2_editor: number;
      stage_3_developer: number;
    };
    cold_start: {
      initial_trust: number;
      grace_failures: number;
      cold_start_period_ms: number;
    };
    scores?: {
      paralysis?: number;
      default_confusion?: number;
      default_loop?: number;
      tool_failure_friction?: number;
      exit_code_penalty?: number;
      spiral_penalty?: number;
    };
  };
}

interface PainSettings {
  language: string;
  thresholds: {
    pain_trigger: number;
    cognitive_paralysis_input: number;
    stuck_loops_trigger: number;
  };
  scores: {
    paralysis: number;
    default_confusion: number;
    default_loop: number;
    tool_failure_friction: number;
    exit_code_penalty: number;
    spiral_penalty: number;
  };
  trust: {
    stages: {
      stage_1_observer: number;
      stage_2_editor: number;
      stage_3_developer: number;
    };
    cold_start: {
      initial_trust: number;
      grace_failures: number;
      cold_start_period_ms: number;
    };
  };
}

interface EvolutionScorecard {
  version: '2.0';
  agentId: string;
  totalPoints: number;
  availablePoints: number;
  currentTier: 1 | 2 | 3 | 4 | 5;
  lastDoubleRewardTime?: string;
  recentFailureHashes: Record<string, string>;
  stats: {
    totalSuccesses: number;
    totalFailures: number;
    consecutiveSuccesses: number;
    consecutiveFailures: number;
    doubleRewardsEarned: number;
    tierPromotions: number;
    pointsByDifficulty: {
      trivial: number;
      normal: number;
      hard: number;
    };
  };
  recentEvents: any[];
  lastUpdated: string;
}

// ===== Constants =====

const EVOLUTION_TIERS = {
  Seed: 1,
  Sprout: 2,
  Sapling: 3,
  Tree: 4,
  Forest: 5,
} as const;

const TIER_REQUIREMENTS = {
  [EVOLUTION_TIERS.Seed]: 0,
  [EVOLUTION_TIERS.Sprout]: 50,
  [EVOLUTION_TIERS.Sapling]: 200,
  [EVOLUTION_TIERS.Tree]: 500,
  [EVOLUTION_TIERS.Forest]: 1000,
} as const;

// ===== Migration Logic =====

/**
 * Maps Trust Engine trust score (0-100) to Evolution Tier
 * Conservative migration: start slightly below to encourage growth
 */
function trustScoreToTier(trustScore: number): number {
  if (trustScore >= 95) return EVOLUTION_TIERS.Sapling; // High trust → Sapling (200 pts)
  if (trustScore >= 80) return EVOLUTION_TIERS.Sprout;  // Medium trust → Sprout (50 pts)
  if (trustScore >= 60) return EVOLUTION_TIERS.Seed;   // Low trust → Seed (0 pts)

  return EVOLUTION_TIERS.Seed; // Default
}

/**
 * Maps Trust Engine trust score to EP points
 * Conservative estimation: assume 50% of points were from actual work
 */
function trustScoreToPoints(trustScore: number): number {
  const tier = trustScoreToTier(trustScore);
  return Math.floor(TIER_REQUIREMENTS[tier] * 0.5); // Start at 50% of tier requirement
}

/**
 * Counts pain events from pain_settings.json
 */
function countPainEvents(painSettings: PainSettings): number {
  const scores = painSettings.scores;
  // Estimate total failures based on score patterns
  const estimatedFailures = Math.floor(
    (scores.paralysis || 0) / 30 +
    (scores.default_confusion || 0) / 30 +
    (scores.default_loop || 0) / 40
  );
  return Math.max(0, estimatedFailures);
}

/**
 * Migrates from Trust Engine to Evolution Points
 */
function migrate(trustScore: number, painSettings: PainSettings): EvolutionScorecard {
  const tier = trustScoreToTier(trustScore);
  const points = trustScoreToPoints(trustScore);
  const totalFailures = countPainEvents(painSettings);

  // Estimate successes (assuming 70% success rate based on trust score)
  const estimatedSuccesses = Math.floor(totalFailures * 3);

  const scorecard: EvolutionScorecard = {
    version: '2.0',
    agentId: 'migrated-agent',
    totalPoints: points,
    availablePoints: points,
    currentTier: tier as any,
    lastDoubleRewardTime: undefined,
    recentFailureHashes: {},
    stats: {
      totalSuccesses: estimatedSuccesses,
      totalFailures: totalFailures,
      consecutiveSuccesses: 0,
      consecutiveFailures: 0,
      doubleRewardsEarned: 0,
      tierPromotions: tier > EVOLUTION_TIERS.Seed ? 1 : 0,
      pointsByDifficulty: {
        trivial: Math.floor(points * 0.2),
        normal: Math.floor(points * 0.6),
        hard: Math.floor(points * 0.2),
      },
    },
    recentEvents: [],
    lastUpdated: new Date().toISOString(),
  };

  return scorecard;
}

// ===== File Operations =====

/**
 * Loads pain_settings.json
 */
function loadPainSettings(workspace: string): PainSettings | null {
  const filePath = path.join(workspace, '.principles', 'pain_settings.json');

  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  pain_settings.json not found at ${filePath}`);
    console.warn('   Starting with default configuration');
    return null;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const settings = JSON.parse(content);
    console.log('✅ Loaded pain_settings.json');
    return settings;
  } catch (error) {
    console.error(`❌ Failed to load pain_settings.json: ${error}`);
    return null;
  }
}

/**
 * Loads PROFILE.json to get agentId
 */
function loadAgentId(workspace: string): string {
  const filePath = path.join(workspace, '.principles', 'PROFILE.json');

  if (!fs.existsSync(filePath)) {
    return 'unknown-agent';
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const profile = JSON.parse(content);
    return profile.agentId || 'unknown-agent';
  } catch {
    return 'unknown-agent';
  }
}

/**
 * Generates EvolutionScorecard.json
 */
function generateScorecard(workspace: string, scorecard: EvolutionScorecard): void {
  const stateDir = path.join(workspace, '.state');

  // Create .state directory if it doesn't exist
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
    console.log('📁 Created .state directory');
  }

  const filePath = path.join(stateDir, 'EVOLUTION_SCORECARD.json');

  try {
    fs.writeFileSync(filePath, JSON.stringify(scorecard, null, 2), 'utf-8');
    console.log('✅ Generated EVOLUTION_SCORECARD.json');
    console.log(`   Tier: ${scorecard.currentTier}, Points: ${scorecard.totalPoints}`);
  } catch (error) {
    console.error(`❌ Failed to write EVOLUTION_SCORECARD.json: ${error}`);
    process.exit(1);
  }
}

/**
 * Updates PROFILE.json to enable Evolution Points
 */
function enableEvolutionInProfile(workspace: string): void {
  const filePath = path.join(workspace, '.principles', 'PROFILE.json');

  if (!fs.existsSync(filePath)) {
    console.warn('⚠️  PROFILE.json not found, skipping evolution enablement');
    return;
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const profile = JSON.parse(content);

    // Enable evolution system
    if (!profile.evolution) {
      profile.evolution = {
        enabled: true,
        doubleRewardCooldownMs: 3600000,
        maxRecentEvents: 50,
      };
      console.log('✅ Enabled Evolution Points in PROFILE.json');
    } else {
      profile.evolution.enabled = true;
      console.log('✅ Evolution Points already enabled in PROFILE.json');
    }

    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
  } catch (error) {
    console.error(`❌ Failed to update PROFILE.json: ${error}`);
    process.exit(1);
  }
}

/**
 * Archives old Trust Engine files
 */
function archiveTrustEngineFiles(workspace: string): void {
  const principlesDir = path.join(workspace, '.principles');
  const painSettingsPath = path.join(principlesDir, 'pain_settings.json');

  if (fs.existsSync(painSettingsPath)) {
    const archiveDir = path.join(workspace, '.principles', 'archive', 'trust-engine');
    fs.mkdirSync(archiveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(archiveDir, `pain_settings-${timestamp}.json`);

    try {
      fs.copyFileSync(painSettingsPath, archivePath);
      console.log(`📦 Archived pain_settings.json to ${archivePath}`);

      // Optionally remove the old file
      // fs.unlinkSync(painSettingsPath);
      // console.log('🗑️  Removed pain_settings.json');
    } catch (error) {
      console.error(`❌ Failed to archive pain_settings.json: ${error}`);
    }
  }
}

// ===== Main =====

function main() {
  console.log('🧬 Evolution Points Migration Script v2.0');
  console.log('========================================\n');

  // Parse workspace path from CLI arguments
  let workspace = process.argv[2] || process.cwd();

  // Resolve relative paths
  workspace = path.resolve(workspace);

  console.log(`📂 Workspace: ${workspace}\n`);

  // Validate workspace
  const principlesDir = path.join(workspace, '.principles');
  if (!fs.existsSync(principlesDir)) {
    console.error('❌ .principles directory not found. Is this a Principles Disciple workspace?');
    process.exit(1);
  }

  // Load Trust Engine configuration
  const painSettings = loadPainSettings(workspace);
  const agentId = loadAgentId(workspace);

  // Get trust score from pain_settings.json
  const trustScore = painSettings?.trust?.cold_start?.initial_trust || 85;
  console.log(`📊 Trust Score: ${trustScore}\n`);

  // Migrate to Evolution Points
  console.log('🔄 Migrating Trust Engine → Evolution Points...');
  const scorecard = migrate(trustScore, painSettings || {} as any);
  scorecard.agentId = agentId;

  // Generate files
  generateScorecard(workspace, scorecard);
  enableEvolutionInProfile(workspace);
  archiveTrustEngineFiles(workspace);

  console.log('\n✅ Migration completed successfully!');
  console.log('\n📝 Next steps:');
  console.log('   1. Review .state/EVOLUTION_SCORECARD.json');
  console.log('   2. Restart OpenClaw Gateway: openclaw gateway --force');
  console.log('   3. Verify agent tier with: cat .state/EVOLUTION_SCORECARD.json');
  console.log('\n🎉 Welcome to the Growth-driven system!');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { migrate, trustScoreToTier, trustScoreToPoints };
