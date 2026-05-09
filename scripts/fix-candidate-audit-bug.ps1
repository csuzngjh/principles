$ErrorActionPreference = 'Stop'

$file = 'C:\Users\Administrator\.openclaw\extensions\principles-disciple\pd-cli\dist\commands\candidate.js'
$raw = [System.IO.File]::ReadAllText($file)

$old = "export async function handleCandidateAudit(opts) {`r`n    const workspaceDir = resolveWorkspaceDir(opts.workspace);`r`n    try {`r`n        const dbPath = path.join(workspaceDir, '.pd', 'state.db');`r`n        const ledgerStateDir = path.join(workspaceDir, '.state');`r`n        const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);`r`n        const conn = new SqliteConnection({ workspaceDir, readonly: true });"

$new = "export async function handleCandidateAudit(opts) {`r`n    const workspaceDir = resolveWorkspaceDir(opts.workspace);`r`n    let conn;`r`n    try {`r`n        const dbPath = path.join(workspaceDir, '.pd', 'state.db');`r`n        const ledgerStateDir = path.join(workspaceDir, '.state');`r`n        const ledgerPath = getLedgerFilePathPublic(ledgerStateDir);`r`n        conn = new SqliteConnection({ workspaceDir, readonly: true });"

if ($raw.Contains($old)) {
    $raw = $raw.Replace($old, $new)
    $raw = $raw.Replace('        conn.close();', '        try { conn?.close(); } catch {}')
    [System.IO.File]::WriteAllText($file, $raw)
    Write-Host 'PATCHED: handleCandidateAudit fixed (conn hoisted + safe close)'
} else {
    $oldLF = $old.Replace("`r`n", "`n")
    $newLF = $new.Replace("`r`n", "`n")
    if ($raw.Contains($oldLF)) {
        $raw = $raw.Replace($oldLF, $newLF)
        $raw = $raw.Replace('        conn.close();', '        try { conn?.close(); } catch {}')
        [System.IO.File]::WriteAllText($file, $raw)
        Write-Host 'PATCHED (LF): handleCandidateAudit fixed'
    } else {
        Write-Host 'FAIL: Pattern not found'
        exit 1
    }
}
