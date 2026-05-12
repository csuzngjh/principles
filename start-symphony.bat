@echo off
setlocal

set SYMPHONY_DIR=D:\Code\principles\symphony\elixir
set OTP_DIR=%USERPROFILE%\.elixir-install\installs\otp\28.1
set ELIXIR_DIR=%USERPROFILE%\.elixir-install\installs\elixir\1.19.5-otp-28\bin
set WORKFLOW_PATH=D:\Code\principles\WORKFLOW.md

if "%1"=="--dry-run" goto :check
if "%1"=="dry-run" goto :check
goto :start

:check
echo [symphony] Checking prerequisites...
if not exist "%OTP_DIR%" echo [FAIL] OTP 28.1 not found && exit /b 1
if not exist "%ELIXIR_DIR%" echo [FAIL] Elixir not found && exit /b 1
if not exist "%SYMPHONY_DIR%" echo [FAIL] Symphony not found && exit /b 1
if not exist "%WORKFLOW_PATH%" echo [FAIL] WORKFLOW.md not found && exit /b 1
where acpx >nul 2>&1 || (echo [FAIL] acpx not in PATH && exit /b 1)
where claude >nul 2>&1 || (echo [FAIL] claude not in PATH && exit /b 1)
if "%LINEAR_API_KEY%"=="" echo [FAIL] LINEAR_API_KEY not set && exit /b 1
echo [symphony] All prerequisites met.
exit /b 0

:start
set PATH=%OTP_DIR%;%ELIXIR_DIR%;%PATH%
cd /d %SYMPHONY_DIR%
set WORKFLOW_PATH=%WORKFLOW_PATH%

echo [symphony] Starting Symphony...
echo [symphony] Dashboard: http://localhost:4000
echo [symphony] Press Ctrl+C to stop.
echo.

mix run start.exs
