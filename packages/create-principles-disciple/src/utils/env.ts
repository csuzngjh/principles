/**
 * 环境检测工具
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

export interface EnvCheckResult {
  hasOpenClaw: boolean;
  openclawVersion?: string;
  hasNode: boolean;
  nodeVersion?: string;
  hasPython: boolean;
  pythonVersion?: string;
  hasGit: boolean;
}

export interface WorkspaceInfo {
  detectedPath: string;
  exists: boolean;
  hasPrinciples: boolean;
  isFirstInstall: boolean;  // 是否首次安装
  coreFiles: string[];      // 已存在的核心文件列表
}

/**
 * 检测运行环境
 */
export function checkEnvironment(): EnvCheckResult {
  const result: EnvCheckResult = {
    hasOpenClaw: false,
    hasNode: false,
    hasPython: false,
    hasGit: false,
  };

  // 检测 Node.js
  try {
    result.nodeVersion = execSync('node -v', { encoding: 'utf-8' }).trim();
    result.hasNode = true;
  } catch {
    result.hasNode = false;
  }

  // 检测 OpenClaw
  try {
    result.openclawVersion = execSync('openclaw --version', { encoding: 'utf-8' }).trim();
    result.hasOpenClaw = true;
  } catch {
    // 尝试 clawd 命令
    try {
      result.openclawVersion = execSync('clawd --version', { encoding: 'utf-8' }).trim();
      result.hasOpenClaw = true;
    } catch {
      result.hasOpenClaw = false;
    }
  }

  // 检测 Python
  try {
    const [, pythonVersion] = execSync('python3 --version', { encoding: 'utf-8' }).trim().split(' ');
    result.pythonVersion = pythonVersion;
    result.hasPython = true;
  } catch {
    result.hasPython = false;
  }

  // 检测 Git
  try {
    execSync('git --version', { encoding: 'utf-8' });
    result.hasGit = true;
  } catch {
    result.hasGit = false;
  }

  return result;
}

/**
 * 检测 OpenClaw 工作区
 */
export function detectWorkspace(): WorkspaceInfo {
  const homeDir = os.homedir();
  const candidates: string[] = [];
  
  // 安全地添加候选路径
  if (process.env.OPENCLAW_WORKSPACE) {
    candidates.push(process.env.OPENCLAW_WORKSPACE);
  }
  if (process.env.PD_WORKSPACE_DIR) {
    candidates.push(process.env.PD_WORKSPACE_DIR);
  }
  candidates.push(path.join(homeDir, 'clawd'));
  candidates.push(path.join(homeDir, '.openclaw', 'workspace'));

  // 核心文件列表（用于检测是否已安装）
  const CORE_FILES = [
    'AGENTS.md',
    'SOUL.md',
    'USER.md',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const principlesPath = path.join(candidate, '.principles', 'PRINCIPLES.md');
      const hasPrinciples = fs.existsSync(principlesPath);
      
      // 检测已存在的核心文件
      const coreFiles: string[] = [];
      for (const file of CORE_FILES) {
        if (fs.existsSync(path.join(candidate, file))) {
          coreFiles.push(file);
        }
      }
      
      // 判断是否首次安装：没有 PRINCIPLES.md 且没有核心文件
      const isFirstInstall = !hasPrinciples && coreFiles.length === 0;
      
      return {
        detectedPath: candidate,
        exists: true,
        hasPrinciples,
        isFirstInstall,
        coreFiles,
      };
    }
  }

  // 默认返回 ~/clawd（首次安装）
  const defaultPath = path.join(homeDir, 'clawd');
  return {
    detectedPath: defaultPath,
    exists: false,
    hasPrinciples: false,
    isFirstInstall: true,
    coreFiles: [],
  };
}

/**
 * 获取 OpenClaw 配置目录
 */
export function getOpenClawConfigDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

/**
 * 获取插件扩展目录
 */
export function getPluginExtDir(): string {
  return path.join(getOpenClawConfigDir(), 'extensions', 'principles-disciple');
}

export interface OpenClawGatewayStatus {
  isRunning: boolean;
  port?: number;
  pid?: number;
}

function readOpenClawPort(): number | null {
  const configPath = path.join(getOpenClawConfigDir(), 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config: unknown = JSON.parse(raw);
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const { gateway } = config as Record<string, unknown>;
      if (gateway && typeof gateway === 'object' && !Array.isArray(gateway)) {
        const { port } = gateway as Record<string, unknown>;
        if (typeof port === 'number' && port > 0 && port < 65536) return port;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function checkPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timeout = 2000;
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

export async function checkOpenClawGateway(): Promise<OpenClawGatewayStatus> {
  const port = readOpenClawPort();
  if (!port) return { isRunning: false };

  const listening = await checkPortListening(port);
  if (!listening) return { isRunning: false };

  let pid: number | undefined = undefined;
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      if (output) {
        const [firstLine] = output.split('\n');
        if (firstLine) pid = parseInt(firstLine.trim(), 10);
      }
    } else {
      const output = execSync(`lsof -i :${port} -t -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (output) {
        const [firstLine] = output.split('\n');
        if (firstLine) pid = parseInt(firstLine.trim(), 10);
      }
    }
  } catch { /* ignore */ }

  return { isRunning: true, port, pid };
}
