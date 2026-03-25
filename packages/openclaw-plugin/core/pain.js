import * as fs from 'fs';
import * as path from 'path';
import { serializeKvLines, parseKvLines } from '../utils/io.js';
import { resolvePdPath } from './paths.js';
import { ConfigService } from './config-service.js';
export function computePainScore(rc, isSpiral, missingTestCommand, softScore, projectDir) {
    let score = Math.max(0, softScore || 0);
    const stateDir = projectDir ? resolvePdPath(projectDir, 'STATE_DIR') : undefined;
    const config = stateDir ? ConfigService.get(stateDir) : null;
    const scoreSettings = config ? config.get('scores') : {
        exit_code_penalty: 70,
        spiral_penalty: 40,
        missing_test_command_penalty: 30
    };
    if (rc !== 0) {
        score += scoreSettings.exit_code_penalty;
    }
    if (isSpiral) {
        score += scoreSettings.spiral_penalty;
    }
    if (missingTestCommand) {
        score += scoreSettings.missing_test_command_penalty;
    }
    return Math.min(100, score);
}
export function painSeverityLabel(painScore, isSpiral = false, projectDir) {
    if (isSpiral) {
        return "critical";
    }
    const stateDir = projectDir ? resolvePdPath(projectDir, 'STATE_DIR') : undefined;
    const config = stateDir ? ConfigService.get(stateDir) : null;
    const thresholds = config ? config.get('severity_thresholds') : {
        high: 70,
        medium: 40,
        low: 20
    };
    if (painScore >= thresholds.high) {
        return "high";
    }
    else if (painScore >= thresholds.medium) {
        return "medium";
    }
    else if (painScore >= thresholds.low) {
        return "low";
    }
    else {
        return "info";
    }
}
export function writePainFlag(projectDir, painData) {
    const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
    const dir = path.dirname(painFlagPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(painFlagPath, serializeKvLines(painData), "utf-8");
}
export function readPainFlagData(projectDir) {
    const painFlagPath = resolvePdPath(projectDir, 'PAIN_FLAG');
    try {
        if (!fs.existsSync(painFlagPath)) {
            return {};
        }
        const content = fs.readFileSync(painFlagPath, "utf-8");
        return parseKvLines(content);
    }
    catch (e) {
        return {};
    }
}
