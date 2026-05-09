$ErrorActionPreference = 'Stop'

$orphanPrinciples = @(
    'P_001', 'P_002', 'P_003', 'P_004',
    '43f4f93e-81d7-428e-82d6-540b80af1a81',
    '92c5b7d2-aa29-4b63-bb04-ff695e10c37e',
    'c3ad35f2-09e9-4bad-9118-e32ad807e78e',
    'test-intake-1777553058991',
    'MANUAL_TEST_001',
    'cffbe683-130f-4e73-bc0d-b05b236cc288',
    '68232be1-26d2-4acb-aa26-c28406dce64e',
    '248afc2c-9db0-45ff-9346-f475a9d78b54',
    '77f7911e-bbe6-42b6-9a0c-d2cbebf68c31',
    '812733e9-7e8b-4574-808b-440c7bf14250',
    '496acdd1-e342-463e-a398-e5156fc7751a',
    'bc58f84b-67fe-40a3-a2c9-a5b0de95ff55',
    'b3cd9c5d-d271-4a92-be28-7d37c58f97f6',
    '1f4d8e86-3e14-4e6b-b1b2-07915275a4c2',
    'd4ccc420-2947-430c-a5a6-103ee454c45a',
    '40da3da3-c943-4576-921e-3ad64374fb19',
    '710e5312-92b8-467c-8bd1-edb66ced028e',
    '03ec7091-7d72-458c-9547-198f705b7505'
)

$success = 0
$failed = 0

foreach ($id in $orphanPrinciples) {
    $result = & pd runtime pruning review --principle-id $id --decision archive-candidate --note "Orphan derived candidate - auto-archived by PD Production Canary Agent" --reviewer "canary-agent" --workspace "D:\.openclaw\workspace" --json 2>&1
    if ($LASTEXITCODE -eq 0) {
        $success++
        Write-Host "ARCHIVED: $id"
    } else {
        $failed++
        Write-Host "FAILED: $id - $result"
    }
}

Write-Host "`nSUMMARY: archived=$success failed=$failed total=$($orphanPrinciples.Count)"
