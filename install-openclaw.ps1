# ============================================================================
# Principles Disciple - OpenClaw Plugin Installer for Windows
# ============================================================================
# 用法: .\install-openclaw.ps1 [-Lang zh|en] [-Force] [-Smart]
# ============================================================================

param(
    [ValidateSet("zh", "en")]
    [string]$Lang = "zh",
    
    [switch]$Force,
    [switch]$Smart,
    
    [string]$WorkspaceDir
)

# 颜色函数（避免与内置 cmdlet 冲突）
function Write-Info { param($msg) Write-Host "info " -ForegroundColor Blue -NoNewline; Write-Host $msg }
function Write-Success { param($msg) Write-Host "success " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn { param($msg) Write-Host "warning " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Err { param($msg) Write-Host "error " -ForegroundColor Red -NoNewline; Write-Host $msg }

# 路径设置
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = $PWD.Path }
$PluginDir = Join-Path $ScriptDir "packages\openclaw-plugin"
$OpenClawStateDir = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } else { Join-Path $env:USERPROFILE ".openclaw" }
$OpenClawConfig = Join-Path $OpenClawStateDir "openclaw.json"

# 显示横幅
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Blue
Write-Host "║     🦞 Principles Disciple - OpenClaw Plugin Installer      ║" -ForegroundColor Blue
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Blue
Write-Host ""
Write-Host "🌐 语言: " -NoNewline
Write-Host $Lang -ForegroundColor Green
Write-Host "📁 插件目录: " -NoNewline
Write-Host $PluginDir -ForegroundColor Green
Write-Host "📁 OpenClaw 配置: " -NoNewline
Write-Host $OpenClawConfig -ForegroundColor Green
Write-Host ""

# ============================================================================
# 1. 选择安装模式
# ============================================================================
$InstallMode = if ($Force) { "force" } elseif ($Smart) { "smart" } else { "" }

if (-not $InstallMode) {
    Write-Host "📋 请选择安装模式:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  1) " -NoNewline; Write-Host "智能合并" -ForegroundColor Cyan -NoNewline; Write-Host " - 已存在的文件会生成 .update 副本，保护用户修改"
    Write-Host "  2) " -NoNewline; Write-Host "强制覆盖" -ForegroundColor Cyan -NoNewline; Write-Host " - 直接覆盖所有文件，保持与模板同步"
    Write-Host ""
    
    $choice = Read-Host "请选择 [1/2，默认1]"
    $InstallMode = if ($choice -eq "2") { "force" } else { "smart" }
}

# ============================================================================
# 2. 配置工作区目录
# ============================================================================
Write-Host ""
Write-Host "📁 步骤 2/7: 配置工作区目录" -ForegroundColor Yellow
Write-Host ""
Write-Host "Principles Disciple 需要知道你的智能体工作区目录。"
Write-Host ""

# 检测 OpenClaw 的工作区目录
$DetectedWorkspace = $WorkspaceDir
if (-not $DetectedWorkspace) {
    if ($env:OPENCLAW_WORKSPACE) {
        $DetectedWorkspace = $env:OPENCLAW_WORKSPACE
    } elseif (Test-Path $OpenClawConfig) {
        try {
            $config = Get-Content $OpenClawConfig | ConvertFrom-Json
            if ($config.agents.defaults.workspace) {
                $DetectedWorkspace = $config.agents.defaults.workspace
            }
        } catch {}
    }
}

# 如果没有检测到，使用默认目录
if (-not $DetectedWorkspace) {
    $DetectedWorkspace = Join-Path $env:USERPROFILE ".openclaw\workspace"
}

Write-Host "检测到的 OpenClaw 工作区: " -NoNewline
Write-Host $DetectedWorkspace -ForegroundColor Green
Write-Host ""
Write-Host "请选择配置方式:"
Write-Host ""
Write-Host "  1) " -NoNewline; Write-Host "使用检测到的目录" -ForegroundColor Cyan -NoNewline; Write-Host " - $DetectedWorkspace"
Write-Host "  2) " -NoNewline; Write-Host "自定义目录" -ForegroundColor Cyan -NoNewline; Write-Host " - 输入你指定的工作区路径"
Write-Host "  3) " -NoNewline; Write-Host "跳过" -ForegroundColor Cyan -NoNewline; Write-Host " - 稍后通过环境变量配置"
Write-Host ""

$workspaceChoice = Read-Host "请选择 [1/2/3，默认1]"

$PDWorkspaceDir = ""
$PDConfigDir = Join-Path $env:USERPROFILE ".openclaw"

if ($workspaceChoice -eq "2") {
    Write-Host ""
    $PDWorkspaceDir = Read-Host "请输入自定义工作区目录路径"
    if ($PDWorkspaceDir) {
        Write-Host ""
        Write-Host "  即将使用的工作区: " -NoNewline
        Write-Host $PDWorkspaceDir -ForegroundColor Green
    }
} elseif ($workspaceChoice -eq "3") {
    Write-Host ""
    Write-Warn "⏭️  跳过配置，稍后可通过以下方式配置:"
    Write-Host "     - 环境变量: `$env:PD_WORKSPACE_DIR='C:\path\to\workspace'"
    Write-Host "     - 配置文件: $PDConfigDir\principles-disciple.json"
} else {
    $PDWorkspaceDir = $DetectedWorkspace
}

# 创建配置文件
if ($PDWorkspaceDir) {
    Write-Host ""
    Write-Host "创建配置文件..."
    
    if (-not (Test-Path $PDConfigDir)) {
        New-Item -ItemType Directory -Path $PDConfigDir -Force | Out-Null
    }
    
    $PDStateDir = Join-Path $PDWorkspaceDir ".state"
    
    $configContent = @{
        workspace = $PDWorkspaceDir
        state = $PDStateDir
        debug = $false
    } | ConvertTo-Json -Depth 10
    
    $configContent | Out-File -FilePath (Join-Path $PDConfigDir "principles-disciple.json") -Encoding UTF8
    
    Write-Success "✅ 配置文件已创建: $PDConfigDir\principles-disciple.json"
    Write-Host "  工作区: $PDWorkspaceDir"
    Write-Host "  状态目录: $PDStateDir"
    
    # 询问是否创建状态目录
    if (-not (Test-Path $PDStateDir)) {
        Write-Host ""
        $createDir = Read-Host "是否创建状态目录? [Y/n]"
        if ($createDir -ne "n" -and $createDir -ne "N") {
            New-Item -ItemType Directory -Path $PDStateDir -Force | Out-Null
            Write-Success "✅ 状态目录已创建: $PDStateDir"
        }
    }
}

# ============================================================================
# 3. 环境检测
# ============================================================================
Write-Host ""
Write-Host "🔍 步骤 3/7: 环境检测" -ForegroundColor Yellow

# 检查 OpenClaw
$openclawCmd = Get-Command openclaw -ErrorAction SilentlyContinue
$clawdCmd = Get-Command clawd -ErrorAction SilentlyContinue
if (-not $openclawCmd -and -not $clawdCmd) {
    Write-Err "❌ OpenClaw 未安装"
    Write-Host "     请先安装 OpenClaw: https://github.com/openclaw/openclaw"
    exit 1
}
Write-Success "✅ OpenClaw 已安装"

# 检查 Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Err "❌ Node.js 未安装"
    Write-Host "     请先安装 Node.js ≥18"
    exit 1
}
$nodeVersion = (node -v)
Write-Success "✅ Node.js $nodeVersion"

# 检查 Python
$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
$python3Cmd = Get-Command python3 -ErrorAction SilentlyContinue
if (-not $pythonCmd -and -not $python3Cmd) {
    Write-Err "❌ Python 未安装"
    exit 1
}
$pythonVersion = if ($python3Cmd) { (python3 --version) } else { (python --version) }
Write-Success "✅ Python $pythonVersion"

# ============================================================================
# 4. 清理旧版本
# ============================================================================
Write-Host ""
Write-Host "🧹 步骤 4/7: 清理旧版本" -ForegroundColor Yellow

$GlobalExtDir = Join-Path $env:USERPROFILE ".openclaw\extensions\principles-disciple"

if (Test-Path $GlobalExtDir) {
    Write-Warn "⚠️  发现旧版本: $GlobalExtDir"
    if ($InstallMode -eq "force") {
        Remove-Item -Path $GlobalExtDir -Recurse -Force
        Write-Success "✅ 已删除"
    } else {
        $delete = Read-Host "     是否删除? [Y/n]"
        if ($delete -ne "n" -and $delete -ne "N") {
            Remove-Item -Path $GlobalExtDir -Recurse -Force
            Write-Success "✅ 已删除"
        }
    }
}

# ============================================================================
# 5. 构建插件
# ============================================================================
Write-Host ""
Write-Host "📦 步骤 5/7: 构建插件" -ForegroundColor Yellow

if (Test-Path (Join-Path $PluginDir "package.json")) {
    Push-Location $PluginDir
    
    Write-Host "  安装依赖..."
    $npmInstall = npm install --silent 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "✅ 依赖安装完成"
    } else {
        Write-Err "❌ 依赖安装失败"
        Write-Host $npmInstall
        Pop-Location
        exit 1
    }
    
    Write-Host "  构建插件 (TypeScript 编译)..."
    $npmBuild = npm run build 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "✅ 插件构建完成"
    } else {
        Write-Err "❌ 插件构建失败 - 请检查 TypeScript 编译错误"
        Write-Host $npmBuild
        Pop-Location
        exit 1
    }
    
    Pop-Location
} else {
    Write-Err "❌ 插件目录不存在: $PluginDir"
    exit 1
}

# ============================================================================
# 6. 安装插件到 OpenClaw
# ============================================================================
Write-Host ""
Write-Host "🔌 步骤 6/7: 安装插件到 OpenClaw" -ForegroundColor Yellow

if ($openclawCmd) {
    Write-Host "  清理旧的插件配置..."
    
    # 清理 OpenClaw 配置中的旧插件条目
    if (Test-Path $OpenClawConfig) {
        try {
            $config = Get-Content $OpenClawConfig | ConvertFrom-Json
            
            # 移除旧的插件配置
            if ($config.plugins.allow) {
                $config.plugins.allow = @($config.plugins.allow | Where-Object { $_ -ne "principles-disciple" })
            }
            if ($config.plugins.entries.PSObject.Properties["principles-disciple"]) {
                $config.plugins.entries.PSObject.Properties.Remove("principles-disciple")
            }
            if ($config.plugins.installs.PSObject.Properties["principles-disciple"]) {
                $config.plugins.installs.PSObject.Properties.Remove("principles-disciple")
            }
            
            $config | ConvertTo-Json -Depth 10 | Out-File $OpenClawConfig -Encoding UTF8
            Write-Success "✅ 已清理旧配置"
        } catch {
            Write-Warn "无法清理配置文件: $_"
        }
    }
    
    # 删除旧的扩展目录
    $ExtDir = Join-Path $env:USERPROFILE ".openclaw\extensions\principles-disciple"
    if (Test-Path $ExtDir) {
        Write-Host "  删除旧的扩展目录..."
        Remove-Item -Path $ExtDir -Recurse -Force
    }
    
    Write-Host "  使用 openclaw plugins install 安装插件..."
    
    # 先卸载（忽略错误）
    & openclaw plugins uninstall principles-disciple 2>$null
    
    # 安装插件
    $installResult = & openclaw plugins install $PluginDir 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Success "✅ 插件安装成功"
    } else {
        Write-Err "❌ 插件安装失败"
        Write-Host $installResult
        exit 1
    }
} else {
    Write-Warn "⚠️  openclaw 命令未找到，跳过插件安装"
    Write-Host "     请手动运行: openclaw plugins install $PluginDir --link"
}

# ============================================================================
# 安装插件依赖
# ============================================================================
Write-Host ""
Write-Host "📦 步骤 7/7: 安装插件依赖" -ForegroundColor Yellow

$PluginExtDir = Join-Path $env:USERPROFILE ".openclaw\extensions\principles-disciple"

if (Test-Path $PluginExtDir) {
    Write-Host "  检查插件依赖..."
    
    # 检查 node_modules 是否存在
    if (-not (Test-Path (Join-Path $PluginExtDir "node_modules"))) {
        Write-Host "  安装插件依赖 (micromatch, @sinclair/typebox)..."
        Push-Location $PluginExtDir
        $npmDeps = npm install --silent micromatch@^4.0.8 @sinclair/typebox@^0.34.48 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Success "✅ 插件依赖安装完成"
        } else {
            Write-Err "❌ 插件依赖安装失败"
            Write-Host "  请手动运行: cd $PluginExtDir; npm install micromatch@^4.0.8 @sinclair/typebox@^0.34.48"
            Pop-Location
            exit 1
        }
        Pop-Location
    } else {
        Write-Success "✅ 插件依赖已存在"
    }
} else {
    Write-Warn "⚠️  插件目录不存在，跳过依赖安装"
}

# ============================================================================
# 复制 Skills
# ============================================================================
Write-Host ""
Write-Host "📚 复制 Skills" -ForegroundColor Yellow

$SkillsSrc = Join-Path $PluginDir "templates\langs\$Lang\skills"
$SkillsDest = Join-Path $env:USERPROFILE ".openclaw\extensions\principles-disciple\skills"

# 语言回退
if (-not (Test-Path $SkillsSrc)) {
    Write-Warn "⚠️  语言包 '$Lang' 不存在，回退到 'zh'"
    $SkillsSrc = Join-Path $PluginDir "templates\langs\zh\skills"
    $Lang = "zh"
}

if (Test-Path $SkillsSrc) {
    if (-not (Test-Path $SkillsDest)) {
        New-Item -ItemType Directory -Path $SkillsDest -Force | Out-Null
    }
    
    # 清空目标目录
    Get-ChildItem -Path $SkillsDest -Recurse | Remove-Item -Force -Recurse
    
    # 复制文件
    Copy-Item -Path "$SkillsSrc\*" -Destination $SkillsDest -Recurse -Force
    
    $skillCount = (Get-ChildItem -Path $SkillsDest -Directory).Count
    Write-Success "✅ 已复制 $skillCount 个 skills"
} else {
    Write-Err "❌ Skills 目录不存在: $SkillsSrc"
    exit 1
}

# ============================================================================
# 完成
# ============================================================================
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                   ✅ 安装完成！                              ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# 显示配置的工作区信息
if ($PDWorkspaceDir) {
    Write-Host "📁 工作区配置:"
    Write-Host "  - 工作区目录: " -NoNewline
    Write-Host $PDWorkspaceDir -ForegroundColor Green
    Write-Host "  - 状态目录: " -NoNewline
    Write-Host $PDStateDir -ForegroundColor Green
    Write-Host "  - 配置文件: " -NoNewline
    Write-Host "$PDConfigDir\principles-disciple.json" -ForegroundColor Green
    Write-Host ""
}

$skillsInDest = if (Test-Path $SkillsDest) { (Get-ChildItem -Path $SkillsDest -Directory).Count } else { 0 }
$modelsDir = Join-Path $PluginDir "templates\workspace\.principles\models"
$modelsCount = if (Test-Path $modelsDir) { (Get-ChildItem -Path $modelsDir -Filter "*.md").Count } else { 0 }

Write-Host "安装信息:"
Write-Host "  - 语言: $Lang"
Write-Host "  - 模式: $InstallMode"
Write-Host "  - Skills: $skillsInDest 个"
Write-Host "  - 思维模型: $modelsCount 个"
Write-Host "  - 插件安装: " -NoNewline
Write-Host "$env:USERPROFILE\.openclaw\extensions\principles-disciple" -ForegroundColor Green
Write-Host ""
Write-Host "下一步操作:"
Write-Host "  1. 重启 OpenClaw Gateway 使插件生效:"
Write-Host "     " -NoNewline
Write-Host "openclaw gateway --force" -ForegroundColor Cyan
Write-Host ""
Write-Host "  2. 在你的项目中初始化核心文件:"
Write-Host "     " -NoNewline
Write-Host "openclaw skill init-strategy" -ForegroundColor Cyan
Write-Host ""

if ($PDWorkspaceDir) {
    Write-Host "📝 配置已保存到: $PDConfigDir\principles-disciple.json"
    Write-Host "   如需修改工作区，可编辑该文件或设置环境变量 PD_WORKSPACE_DIR"
    Write-Host ""
}

if ($InstallMode -eq "smart") {
    Write-Warn "💡 智能模式提示: 如果核心文件已存在且被修改过，新版会保存为 .update 文件"
}
