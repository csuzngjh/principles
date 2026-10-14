#!/bin/sh
# One-off P1 product verification: after the fix, the auto-launched console
# must be spawned with --workspace <governance dir>, not the project dir.
LAB="D:/Code/wb-probe-lab/console-route-$(date +%s)"
mkdir -p "$LAB/fake-home/.workbuddy" "$LAB/project-a"
PAYLOAD="D:/Code/wb-probe-lab/e2e-install-diag-release3/payload"
cd /d/Code/_worktrees/principles/adhoc-20261012-workbuddy-spec-review-a5c1ad
WORKBUDDY_CONFIG_DIR="$LAB/fake-home/.workbuddy" \
CODEBUDDY_CONFIG_DIR="$LAB/fake-home/.workbuddy" \
USERPROFILE="$LAB/fake-home" HOME="$LAB/fake-home" \
PD_INSTALL_PLUGIN_DIR="$PAYLOAD" PD_SKIP_NPM_UPGRADE=1 PD_SKIP_GLOBAL_SHIM=1 \
node packages/create-principles-disciple/dist/index.js --host workbuddy --workspace "$LAB/project-a" --yes --json > "$LAB/install.out" 2>&1
echo "INSTALL_EXIT=$?"
grep -ao "Console ready at [^\"]*" "$LAB/install.out" | head -1
sleep 8
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'console' -and \$_.CommandLine -match 'workspace' } | ForEach-Object { Write-Output (\$_.ProcessId.ToString() + ' :: ' + \$_.CommandLine.Substring(0, [Math]::Min(300, \$_.CommandLine.Length))) }"
echo "LAB=$LAB"
