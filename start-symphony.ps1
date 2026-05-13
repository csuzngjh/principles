<#
.SYNOPSIS
    Start Symphony orchestration service for the Principles project.

.DESCRIPTION
    Launches Symphony with ACPX + Claude Code integration to automatically
    process Linear issues. Supports both interactive and headless modes.

.PARAMETER WorkflowPath
    Path to WORKFLOW.md. Defaults to the WORKFLOW.md in the Principles project root.

.PARAMETER Port
    Override the HTTP dashboard port.

.PARAMETER LogsRoot
    Override the logs root directory.

.PARAMETER SymphonyDir
    Path to Symphony Elixir project directory.

.PARAMETER DryRun
    Only check prerequisites without starting Symphony.

.EXAMPLE
    .\start-symphony.ps1
    .\start-symphony.ps1 -DryRun
    .\start-symphony.ps1 -Port 4001
    .\start-symphony.ps1 -Port 4002 -LogsRoot D:\Code\principles\.symphony-smoke-logs -DryRun
#>
param(
    [string]$WorkflowPath = "D:\Code\principles\WORKFLOW.md",
    [int]$Port = 0,
    [string]$LogsRoot = "",
    [string]$SymphonyDir = "D:\Code\principles\symphony\elixir",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$OtpDir = "$env:USERPROFILE\.elixir-install\installs\otp\28.1"
$ElixirDir = "$env:USERPROFILE\.elixir-install\installs\elixir\1.19.5-otp-28\bin"

function Write-Status($msg) { Write-Host "[symphony] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)     { Write-Host "[symphony] $msg" -ForegroundColor Green }
function Write-Warn($msg)   { Write-Host "[symphony] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)   { Write-Host "[symphony] $msg" -ForegroundColor Red }

Write-Status "Pre-flight checks..."

$failures = @()

if (-not (Test-Path $OtpDir)) {
    $failures += "OTP 28.1 not found at $OtpDir"
}

if (-not (Test-Path $ElixirDir)) {
    $failures += "Elixir 1.19.5 not found at $ElixirDir"
}

if (-not (Test-Path $SymphonyDir)) {
    $failures += "Symphony directory not found at $SymphonyDir"
}

if (-not (Test-Path $WorkflowPath)) {
    $failures += "WORKFLOW.md not found at $WorkflowPath"
}

$acpxExe = Get-Command "acpx" -ErrorAction SilentlyContinue
if (-not $acpxExe) {
    $failures += "acpx CLI not found in PATH. Install: npm install -g acpx"
} else {
    $acpxVersion = & acpx --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failures += "acpx --version failed: $acpxVersion"
    }
}

$claudeExe = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $claudeExe) {
    Write-Warn "claude CLI not found in PATH. Some agents may not work."
}

$linearKey = $env:LINEAR_API_KEY
if (-not $linearKey) {
    $failures += "LINEAR_API_KEY environment variable not set"
}

if ($failures.Count -gt 0) {
    Write-Fail "Prerequisites check failed:"
    $failures | ForEach-Object { Write-Fail "  - $_" }
    Write-Host ""
    Write-Host "To fix:" -ForegroundColor White
    Write-Host "  1. Install Elixir: cd $SymphonyDir\.. && install.bat elixir@1.19.5 otp@28.1" -ForegroundColor White
    Write-Host "  2. Install ACPX:   npm install -g acpx" -ForegroundColor White
    Write-Host "  3. Set API key:    `$env:LINEAR_API_KEY = 'lin_api_...'" -ForegroundColor White
    exit 1
}

$acpxStrategy = if ($acpxExe.Source -match '\.(ps1|cmd|bat)$') {
    "shell (cmd /S /C acpx) - shim detected at $($acpxExe.Source)"
} else {
    "direct ($($acpxExe.Source))"
}

Write-Ok "All prerequisites met."
Write-Ok "  OTP:      $OtpDir"
Write-Ok "  Elixir:   $ElixirDir"
Write-Ok "  Symphony: $SymphonyDir"
Write-Ok "  Workflow: $WorkflowPath"
Write-Ok "  ACPX:     $acpxStrategy"
Write-Ok "  ACPX ver: $acpxVersion"
if ($claudeExe) {
    Write-Ok "  Claude:   $($claudeExe.Source)"
}
Write-Ok "  Linear:   $($linearKey.Substring(0,8))..."

$displayPort = if ($Port -gt 0) { $Port } else { 4000 }
$displayLogs = if ($LogsRoot -ne "") { $LogsRoot } else { "default" }

Write-Host ""
Write-Status "Launch configuration:"
Write-Status "  Workflow:   $WorkflowPath"
Write-Status "  Port:       $displayPort"
Write-Status "  Logs root:  $displayLogs"
Write-Status "  Dashboard:  http://localhost:$displayPort"
Write-Status "  ACPX:       $acpxStrategy"

if ($DryRun) {
    Write-Ok "Dry run complete. All checks passed."
    exit 0
}

$env:PATH = "$OtpDir;$ElixirDir;$env:PATH"

Set-Location $SymphonyDir

$env:SYMPHONY_WORKFLOW = $WorkflowPath

if ($Port -gt 0) {
    $env:SYMPHONY_PORT = "$Port"
}

if ($LogsRoot -ne "") {
    $env:SYMPHONY_LOGS_ROOT = $LogsRoot

    if (-not (Test-Path $LogsRoot)) {
        New-Item -ItemType Directory -Path $LogsRoot -Force | Out-Null
        Write-Ok "Created logs root: $LogsRoot"
    }
}

Write-Status "Starting Symphony..."
Write-Status "  Press Ctrl+C to stop."
Write-Host ""

mix run --no-start start.exs
