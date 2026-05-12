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

.PARAMETER DryRun
    Only check prerequisites without starting Symphony.

.EXAMPLE
    .\start-symphony.ps1
    .\start-symphony.ps1 -DryRun
    .\start-symphony.ps1 -Port 4001
#>
param(
    [string]$WorkflowPath = "D:\Code\principles\WORKFLOW.md",
    [int]$Port = 0,
    [string]$LogsRoot = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$SymphonyDir = "D:\Code\principles\symphony\elixir"
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
}

$claudeExe = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $claudeExe) {
    $failures += "claude CLI not found in PATH. Install: npm install -g @anthropic-ai/claude-code"
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
    Write-Host "  2. Install ACPX:   npm install -g acpx @agentclientprotocol/claude-agent-acp" -ForegroundColor White
    Write-Host "  3. Set API key:    `$env:LINEAR_API_KEY = 'lin_api_...'" -ForegroundColor White
    exit 1
}

Write-Ok "All prerequisites met."
Write-Ok "  OTP:      $OtpDir"
Write-Ok "  Elixir:   $ElixirDir"
Write-Ok "  Symphony: $SymphonyDir"
Write-Ok "  Workflow: $WorkflowPath"
Write-Ok "  ACPX:     $($acpxExe.Source)"
Write-Ok "  Claude:   $($claudeExe.Source)"
Write-Ok "  Linear:   $($linearKey.Substring(0,8))..."

if ($DryRun) {
    Write-Ok "Dry run complete. All checks passed."
    exit 0
}

$env:PATH = "$OtpDir;$ElixirDir;$env:PATH"

Set-Location $SymphonyDir

$args = @(
    "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
    $WorkflowPath
)

if ($Port -gt 0) {
    $args += "--port"
    $args += $Port
}

if ($LogsRoot -ne "") {
    $args += "--logs-root"
    $args += $LogsRoot
}

Write-Status "Starting Symphony..."
Write-Status "  Command: mix run start.exs (with WORKFLOW_PATH=$WorkflowPath)"
Write-Status "  Dashboard: http://localhost:4000"
Write-Status "  Press Ctrl+C to stop."
Write-Host ""

$env:WORKFLOW_PATH = $WorkflowPath

mix run start.exs
